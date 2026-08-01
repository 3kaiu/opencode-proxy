use spin_sdk::http::{Request, Response, ResponseBuilder, Method};
use spin_sdk::http_component;

const TARGET_HOST: &str = "https://opencode.ai";

const USER_AGENTS: &[&str] = &[
    "opencode/latest/0.0.50/cli",
    "opencode/latest/0.0.51/cli",
    "opencode/latest/0.0.52/cli",
    "opencode/latest/0.0.53/cli",
    "opencode/latest/0.0.54/cli",
    "opencode/latest/0.0.55/cli",
];

/// 只代理 API 路径，拒绝官网静态资源，避免烧调用量
fn is_api_path(path: &str) -> bool {
    path.starts_with("/zen/") || path.starts_with("/v1/")
}

// WASM 环境无 crypto.getRandomValues()，spin-sdk v5 不暴露随机 API。
// 用 AtomicU64 round-robin / LCG 代替。X-Random-ID 仅为辅助链路多样性，
// Fermyon 是 10 个端点中额度最小的（10 万次/月），确定性序列的实际风险极低。
// 若需真随机可引入 getrandom crate（wasm32-wasip1 target）。
fn random_user_agent() -> &'static str {
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
        let mut h = cors_headers();
        h.push(("Content-Type".into(), "application/json".into()));
        return ResponseBuilder::new(405)
            .headers(h)
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
        None => &uri[..],
    };

    // Extract pathname (without query) for path checks
    let pathname = match path_and_query.find('?') {
        Some(q) => &path_and_query[..q],
        None => path_and_query,
    };

    // Health check
    if pathname == "/health" || pathname == "/health/" {
        let mut h = cors_headers();
        h.push(("Content-Type".into(), "application/json".into()));
        return ResponseBuilder::new(200)
            .headers(h)
            .body(br#"{"status":"ok","version":"1.3.0","platform":"fermyon"}"#.to_vec())
            .build();
    }

    // 非 API 路径直接 404，不转发到上游
    if !is_api_path(pathname) {
        let mut h = cors_headers();
        h.push(("Content-Type".into(), "application/json".into()));
        return ResponseBuilder::new(404)
            .headers(h)
            .body(br#"{"error":"Not found"}"#.to_vec())
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
            let mut h = cors_headers();
            h.push(("Content-Type".into(), "application/json".into()));
            ResponseBuilder::new(502)
                .headers(h)
                .body(body.into_bytes())
                .build()
        }
    }
}
