// Fermyon Cloud Rust adapter — aligned with shared/proxy.ts v2.3.0 behavior.
// Build: cargo build --target wasm32-wasip1 --release (~250KB WASM)

use spin_sdk::http::{Method, Request, Response, ResponseBuilder};
use spin_sdk::http_component;

const VERSION: &str = "2.3.0";
const TARGET_HOST: &str = "https://opencode.ai";

const OPENCODE_LATEST_CLI: &[&str] = &["0.0.50", "0.0.51", "0.0.52", "0.0.53", "0.0.54", "0.0.55"];
const PROVIDER_UTILS: &[&str] = &["4.0.22", "4.0.23", "4.0.24", "4.0.25"];
const OPENCODE_VERSIONS: &[&str] = &[
    "1.18.15", "1.18.16", "1.18.17", "1.18.18", "1.18.19", "1.19.0", "1.19.1",
];
const BUN_VERSIONS: &[&str] = &["1.2.10", "1.3.14", "1.3.21", "1.4.0", "1.4.4"];

fn next_random_u64() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0x9e3779b97f4a7c15);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

fn random_hex(len: usize) -> String {
    let mut result = String::with_capacity(len * 2);
    let mut val = next_random_u64();
    for _ in 0..len {
        let byte = (val & 0xff) as u8;
        result.push_str(&format!("{:02x}", byte));
        val = val.wrapping_mul(1103515245).wrapping_add(12345);
    }
    result
}

fn user_agent() -> String {
    match next_random_u64() % 3 {
        0 => format!("opencode/latest/{}/cli", OPENCODE_LATEST_CLI[(next_random_u64() as usize) % OPENCODE_LATEST_CLI.len()]),
        1 => format!("opencode/{}/cli", OPENCODE_VERSIONS[(next_random_u64() as usize) % OPENCODE_VERSIONS.len()]),
        _ => format!(
            "opencode/{}/cli ai-sdk/provider-utils/{} runtime/bun/{}",
            OPENCODE_VERSIONS[(next_random_u64() as usize) % OPENCODE_VERSIONS.len()],
            PROVIDER_UTILS[(next_random_u64() as usize) % PROVIDER_UTILS.len()],
            BUN_VERSIONS[(next_random_u64() as usize) % BUN_VERSIONS.len()]
        ),
    }
}

fn cors_headers() -> Vec<(String, String)> {
    vec![
        ("Access-Control-Allow-Origin".into(), "*".into()),
        ("Access-Control-Allow-Methods".into(), "GET, POST, OPTIONS".into()),
        ("Access-Control-Allow-Headers".into(), "*".into()),
        ("Access-Control-Max-Age".into(), "86400".into()),
    ]
}

fn json_response(status: u16, body: &str) -> Response {
    ResponseBuilder::new(status)
        .header("Content-Type", "application/json")
        .header("Access-Control-Allow-Origin", "*")
        .body(body.as_bytes().to_vec())
        .build()
}

fn is_dummy_auth(value: &str) -> bool {
    let v = value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
        .map(str::trim)
        .unwrap_or_else(|| value.trim());
    v.is_empty()
        || matches!(
            v.to_ascii_lowercase().as_str(),
            "dummy" | "placeholder" | "sk-dummy" | "test" | "x" | "empty" | "oc-proxy"
        )
}

fn path_and_query(uri: &str) -> &str {
    match uri.find("://") {
        Some(scheme_end) => {
            let after_scheme = &uri[scheme_end + 3..];
            match after_scheme.find('/') {
                Some(path_start) => &after_scheme[path_start..],
                None => "/",
            }
        }
        None => uri,
    }
}

fn target_from_header(req: &Request) -> Option<String> {
    let raw = req.header("x-proxy-target")?.as_str()?;
    let parsed = raw.strip_prefix("https://")?;
    let (host, _rest) = parsed.split_once('/').unwrap_or((parsed, ""));
    if host == "opencode.ai" || host.ends_with(".opencode.ai") {
        Some(raw.to_string())
    } else {
        None
    }
}

async fn fetch_ip(ipify_url: &str) -> Option<String> {
    let req = Request::builder()
        .method(Method::Get)
        .uri(ipify_url)
        .header("User-Agent", user_agent())
        .body(Vec::new())
        .build();
    let resp = spin_sdk::http::send::<_, Response>(req).await.ok()?;
    if !(*resp.status() >= 200 && *resp.status() < 300) {
        return None;
    }
    let body = String::from_utf8(resp.body().to_vec()).ok()?;
    let key = "\"ip\":\"";
    let start = body.find(key)? + key.len();
    let end = body[start..].find('"')?;
    Some(body[start..start + end].to_string())
}

#[http_component]
async fn handle_request(req: Request) -> Response {
    if req.method() == &Method::Options {
        return ResponseBuilder::new(200).headers(cors_headers()).body(Vec::new()).build();
    }

    if req.method() != &Method::Get && req.method() != &Method::Post {
        return json_response(405, r#"{"error":"Only POST and GET allowed"}"#);
    }

    let path = path_and_query(req.uri());

    if path == "/health" || path == "/health/" {
        return json_response(200, &format!(r#"{{"status":"ok","platform":"fermyon","version":"{}","noCache":true}}"#, VERSION));
    }

    if path == "/diagnose" || path == "/diagnose/" {
        let (v4, v6) = (
            fetch_ip("https://api.ipify.org?format=json").await,
            fetch_ip("https://api6.ipify.org?format=json").await,
        );
        let body = format!(
            r#"{{"platform":"fermyon","version":"{}","ipv4":{},"ipv6":{}}}"#,
            VERSION,
            v4.map(|s| format!("\"{}\"", s)).unwrap_or_else(|| "null".into()),
            v6.map(|s| format!("\"{}\"", s)).unwrap_or_else(|| "null".into())
        );
        return json_response(200, &body);
    }

    let is_api_path = path.starts_with("/zen/") || path.starts_with("/v1/");
    if !is_api_path {
        return json_response(404, r#"{"error":"Not found"}"#);
    }

    let base = target_from_header(&req).unwrap_or_else(|| TARGET_HOST.to_string());
    let target = format!("{}{}", base, path);

    let mut headers: Vec<(String, String)> = Vec::new();
    for (key, value) in req.headers() {
        let lower = key.to_lowercase();
        if lower == "x-opencode-project" || lower == "x-proxy-target" {
            continue;
        }
        if lower == "authorization" {
            if let Some(v) = value.as_str() {
                if !is_dummy_auth(v) {
                    headers.push((key.to_string(), v.to_string()));
                }
            }
            continue;
        }
        if lower.starts_with("x-opencode-") || lower == "accept" || lower == "content-type" {
            if let Some(v) = value.as_str() {
                headers.push((key.to_string(), v.to_string()));
            }
        }
    }
    headers.push(("User-Agent".into(), user_agent()));
    headers.push(("X-Random-ID".into(), random_hex(8)));

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
            let status = *resp.status();
            let mut all_headers = cors_headers();
            for (k, v) in resp.headers() {
                if let Some(vs) = v.as_str() {
                    all_headers.push((k.to_string(), vs.to_string()));
                }
            }
            ResponseBuilder::new(status)
                .headers(all_headers)
                .body(resp.into_body())
                .build()
        }
        Err(e) => json_response(502, &format!(r#"{{"error":"proxy failed: {}"}}"#, e)),
    }
}
