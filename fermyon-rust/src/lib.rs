use spin_sdk::http::{Request, Response, ResponseBuilder, Method};
use spin_sdk::http_component;

const TARGET_HOST: &str = "https://opencode.ai";

const USER_AGENTS: &[&str] = &[
    "opencode/latest/1.3.15/cli",
    "opencode/latest/1.3.16/cli",
    "opencode/latest/1.3.17/cli",
    "opencode/latest/1.4.0/cli",
    "opencode/latest/1.4.1/cli",
];

fn random_user_agent() -> &'static str {
    // Use a pseudo-random index based on a simple counter
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let idx = (COUNTER.fetch_add(1, Ordering::Relaxed) as usize) % USER_AGENTS.len();
    USER_AGENTS[idx]
}

fn random_hex(len: usize) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0xdeadbeef);
    let mut result = String::with_capacity(len * 2);
    let mut val = COUNTER.fetch_add(1, Ordering::Relaxed);
    for _ in 0..len {
        let byte = (val & 0xff) as u8;
        result.push_str(&format!("{:02x}", byte));
        val = val.wrapping_mul(1103515245).wrapping_add(12345);
    }
    result
}

fn cors_headers() -> Vec<(String, String)> {
    vec![
        ("Access-Control-Allow-Origin".into(), "*".into()),
        ("Access-Control-Allow-Methods".into(), "GET, POST, OPTIONS".into()),
        ("Access-Control-Allow-Headers".into(), "*".into()),
        ("Access-Control-Max-Age".into(), "86400".into()),
    ]
}

#[http_component]
async fn handle_request(req: Request) -> Response {
    // CORS preflight
    if req.method() == &Method::Options {
        return ResponseBuilder::new(200)
            .headers(cors_headers())
            .body(Vec::new())
            .build();
    }

    if req.method() != &Method::Get && req.method() != &Method::Post {
        return ResponseBuilder::new(405)
            .header("Content-Type", "application/json")
            .header("Access-Control-Allow-Origin", "*")
            .body(br#"{"error":"Only GET and POST allowed"}"#.to_vec())
            .build();
    }

    let uri = req.uri();

    // Extract path+query from full URI (v5 returns "https://host/path?query")
    let path_and_query = match uri.find("://") {
        Some(scheme_end) => {
            let after_scheme = &uri[scheme_end + 3..];
            match after_scheme.find('/') {
                Some(path_start) => &after_scheme[path_start..],
                None => "/",
            }
        }
        None => &uri[..], // fallback: assume it's already just a path
    };

    // Health check
    if path_and_query == "/health" || path_and_query == "/health/" {
        return ResponseBuilder::new(200)
            .header("Content-Type", "application/json")
            .header("Access-Control-Allow-Origin", "*")
            .body(br#"{"status":"ok","platform":"fermyon"}"#.to_vec())
            .build();
    }

    // Build target URL
    let target = format!("{}{}", TARGET_HOST, path_and_query);

    // Build forwarded headers
    let mut headers: Vec<(String, String)> = Vec::new();
    for (key, value) in req.headers() {
        let lower = key.to_lowercase();
        if lower.starts_with("x-opencode-") || lower == "authorization" {
            if let Some(v) = value.as_str() {
                headers.push((key.to_string(), v.to_string()));
            }
        }
    }
    headers.push(("User-Agent".into(), random_user_agent().to_string()));
    headers.push(("X-Random-ID".into(), random_hex(8)));
    let ct = req
        .header("content-type")
        .and_then(|v| v.as_str())
        .unwrap_or("application/json");
    headers.push(("Content-Type".into(), ct.to_string()));

    let body = match req.method() {
        Method::Get | Method::Head => Vec::new(),
        _ => req.body().to_vec(),
    };

    let proxy_req = Request::builder()
        .method(req.method().clone())
        .uri(&target)
        .headers(headers)
        .body(body)
        .build();

    match spin_sdk::http::send::<_, Response>(proxy_req).await {
        Ok(resp) => {
            let status = resp.status().clone();
            let mut all_headers = cors_headers();
            for (k, v) in resp.headers() {
                if let Some(vs) = v.as_str() {
                    all_headers.push((k.to_string(), vs.to_string()));
                }
            }
            let body = resp.into_body();
            ResponseBuilder::new(status)
                .headers(all_headers)
                .body(body)
                .build()
        }
        Err(e) => {
            let body = format!(r#"{{"error":"proxy failed: {}"}}"#, e);
            ResponseBuilder::new(502)
                .header("Content-Type", "application/json")
                .header("Access-Control-Allow-Origin", "*")
                .body(body.into_bytes())
                .build()
        }
    }
}
