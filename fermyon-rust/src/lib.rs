use spin_sdk::http::{Request, Response, ResponseBuilder, Method};
use spin_sdk::http_component;

const DEFAULT_TARGET_HOST: &str = "https://opencode.ai";
const HEADER_TARGET: &str = "x-proxy-target";
const ALLOWED_TARGET_HOSTS: &[&str] = &["opencode.ai"];
const VERSION: &str = "2.0.0";

/// 与 shared/proxy.ts 对齐的白名单校验：
/// 仅当 header 存在、为 https、host 匹配白名单时信任，否则回退默认 host。
/// 返回完整目标 URL（含 path/query），由 CF 控制层透传。
fn resolve_proxy_target(req: &Request) -> Option<String> {
    for (key, value) in req.headers() {
        if key.eq_ignore_ascii_case(HEADER_TARGET) {
            let raw = value.as_str()?;
            if !raw.starts_with("https://") {
                return None;
            }
            // 提取 host（截掉 scheme 与 path）
            let rest = &raw[8..];
            let host = rest.split('/').next().unwrap_or("");
            let host = host.split(':').next().unwrap_or("");
            let allowed = ALLOWED_TARGET_HOSTS
                .iter()
                .any(|a| host == *a || host.ends_with(&format!(".{}", a)));
            if allowed {
                return Some(raw.to_string());
            }
        }
    }
    None
}

/// 只代理 API 路径，拒绝官网静态资源，避免烧调用量
fn is_api_path(path: &str) -> bool {
    path.starts_with("/zen/") || path.starts_with("/v1/")
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
    let mut h = cors_headers();
    h.push(("Content-Type".into(), "application/json".into()));
    ResponseBuilder::new(status).headers(h).body(body.as_bytes().to_vec()).build()
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
        return json_response(405, r#"{"error":"Only GET and POST allowed"}"#);
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
        return json_response(
            200,
            &format!(
                r#"{{"status":"ok","version":"{}","platform":"fermyon","noCache":true,"headers":{{"Cache-Control":"no-store"}}}}"#,
                VERSION
            ),
        );
    }

    // Diagnosis: Fermyon 出站被白名单限制为仅 opencode.ai，无法探测外部 IP。
    if pathname == "/diagnose" || pathname == "/diagnose/" {
        return json_response(
            200,
            &format!(
                r#"{{"platform":"fermyon","version":"{}","ipv4":null,"ipv6":null}}"#,
                VERSION
            ),
        );
    }

    // 非 API 路径直接 404，不转发到上游
    if !is_api_path(pathname) {
        return json_response(404, r#"{"error":"Not found"}"#);
    }

    // Build target URL: trust x-proxy-target if allowlisted, else default host.
    let target = match resolve_proxy_target(&req) {
        Some(t) => t,
        None => format!("{}{}", DEFAULT_TARGET_HOST, path_and_query),
    };

    // Build forwarded headers: 纯透传，只带 opencode 作用域与鉴权头（无指纹伪装）
    let mut headers: Vec<(String, String)> = Vec::new();
    for (key, value) in req.headers() {
        let lower = key.to_lowercase();
        if lower.starts_with("x-opencode-") || lower == "authorization" {
            if let Some(v) = value.as_str() {
                headers.push((key.to_string(), v.to_string()));
            }
        }
    }
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
        Err(e) => json_response(502, &format!(r#"{{"error":"proxy failed: {}"}}"#, e)),
    }
}
