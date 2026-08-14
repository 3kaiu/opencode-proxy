// 平台出口代理核心（唯一真源；构建期由 scripts/build.mjs 打单文件并 minify）
// v2.4.0 审计优化:
// - 修复: SSE 流不再压缩 (减少首字节延迟)
// - 修复: API_PREFIXES 收窄到 /zen/v1/ (避免无效路径穿透)
// - 修复: 移除 x-proxy-target 透传 (安全加固, 只允许转发到 opencode.ai)
// - 新增: /zen/v1/models 内存缓存 (减少上游请求, 5 分钟 TTL)
// - 新增: 请求 ID (X-Request-Id, 便于追踪)
// - 新增: /health 增强 (请求统计 + 运行时间)
// - 新增: /stats 端点 (内存统计)
// - 优化: UA 池扩展到 1000+ 组合 (与 CF router 一致)
// - 优化: 认证策略 stripAllAuth (避免共享限流桶)

export const VERSION = "2.4.0"

const DEFAULT_TARGET = "https://opencode.ai"
const REQUEST_TIMEOUT_MS = 60_000
const MODELS_CACHE_TTL_MS = 5 * 60_000 // 5 分钟

// ── 内存状态 ────────────────────────────────────────────────────────────────

let modelsCache: { data: string; ts: number } | null = null
let requestCount = 0
let successCount = 0
let errorCount = 0
let startTime = Date.now()

// ── CORS ────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
}

// ── 限流键参数匿名化 ────────────────────────────────────────────────────────
// 以下头跨会话/重启/IP 恒定, 官方可能用于关联指纹
// 转发前剥离, 让每个请求呈现为独立的匿名客户端

const RATE_LIMIT_KEY_HEADERS = new Set([
  "x-opencode-project",
  "x-opencode-session",
  "x-opencode-request",
  "x-opencode-client",
  "x-session-id",
  "x-session-affinity",
  "x-proxy-target", // 安全加固: 不透传客户端指定的目标
])

// ── UA 匿名化 (1000+ 组合) ─────────────────────────────────────────────────

const UA_CLI_VERSIONS = ["0.0.50", "0.0.51", "0.0.52", "0.0.53", "0.0.54", "0.0.55", "0.0.56", "0.0.57"]
const UA_SDK_VERSIONS = ["4.0.22", "4.0.23", "4.0.24", "4.0.25", "4.0.26", "4.0.27"]
const UA_APP_VERSIONS = ["1.18.15", "1.18.16", "1.18.17", "1.18.18", "1.18.19", "1.19.0", "1.19.1", "1.19.2", "1.20.0"]
const UA_BUN_VERSIONS = ["1.2.10", "1.3.14", "1.3.21", "1.4.0", "1.4.4", "1.4.5", "1.5.0"]
const UA_NODE_VERSIONS = ["20.11.0", "20.12.0", "21.6.0", "21.7.0", "22.0.0"]

function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function randomAnonymousUA(): string {
  const style = Math.floor(Math.random() * 5)
  if (style === 0) return `opencode/latest/${randomPick(UA_CLI_VERSIONS)}/cli`
  if (style === 1) return `opencode/${randomPick(UA_APP_VERSIONS)}`
  if (style === 2) return `opencode/${randomPick(UA_APP_VERSIONS)} ai-sdk/provider-utils/${randomPick(UA_SDK_VERSIONS)} runtime/bun/${randomPick(UA_BUN_VERSIONS)}`
  if (style === 3) return `opencode/${randomPick(UA_APP_VERSIONS)} ai-sdk/provider-utils/${randomPick(UA_SDK_VERSIONS)} runtime/node/${randomPick(UA_NODE_VERSIONS)}`
  return `opencode/${randomPick(UA_APP_VERSIONS)} (${randomHex(4)}) ai-sdk/${randomPick(UA_SDK_VERSIONS)} runtime/bun/${randomPick(UA_BUN_VERSIONS)}`
}

function randomHex(len: number): string {
  let s = ""
  for (let i = 0; i < len; i++) {
    s += Math.floor(Math.random() * 256).toString(16).padStart(2, "0")
  }
  return s
}

function generateRequestId(): string {
  return Date.now().toString(36) + randomHex(8)
}

function anonymizeClientHeaders(headers: Headers): Headers {
  headers.set("user-agent", randomAnonymousUA())
  headers.set("x-random-id", randomHex(8))
  return headers
}

// ── 请求头处理 ──────────────────────────────────────────────────────────────

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "host",
  "content-length",
  "accept-encoding",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "via",
  "forwarded",
])

function makeForwardHeaders(request: Request): Headers {
  const headers = new Headers()
  for (const [key, value] of request.headers) {
    const lower = key.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower)) continue
    if (RATE_LIMIT_KEY_HEADERS.has(lower)) continue
    headers.set(key, value)
  }
  return headers
}

// 认证策略: 剥离所有 auth, 让每个端点 IP 独立限流
// 不保留 Bearer public, 避免共享限流桶
function stripAllAuth(headers: Headers): Headers {
  headers.delete("authorization")
  return headers
}

// ── 响应处理 ────────────────────────────────────────────────────────────────

// 响应压缩: 仅对非流式响应做 gzip, SSE 流跳过 (减少首字节延迟)
// 运行时不提供 CompressionStream 时跳过压缩, 保证可用性
function maybeCompressResponse(request: Request, response: Response): Response {
  if (typeof CompressionStream === "undefined") return response
  const acceptEncoding = (request.headers.get("accept-encoding") || "").toLowerCase()
  if (!acceptEncoding.includes("gzip")) return response
  if (response.headers.get("content-encoding")) return response
  
  const contentType = response.headers.get("content-type") || ""
  // 跳过 SSE 流 (event-stream) 和已压缩内容
  if (/event-stream/i.test(contentType)) return response
  if (!/text\/|application\/json|javascript/i.test(contentType)) return response

  const headers = new Headers(response.headers)
  headers.set("content-encoding", "gzip")
  const vary = headers.get("vary")
  headers.set("vary", vary ? vary + ", accept-encoding" : "accept-encoding")
  headers.delete("content-length")

  const body = response.body ? response.body.pipeThrough(new CompressionStream("gzip")) : null
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}

// ── models 内存缓存 ─────────────────────────────────────────────────────────

function getModelsFromCache(): string | null {
  if (modelsCache && Date.now() - modelsCache.ts < MODELS_CACHE_TTL_MS) {
    return modelsCache.data
  }
  return null
}

function setModelsCache(data: string): void {
  modelsCache = { data, ts: Date.now() }
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

interface PlatformInfo {
  platform: string
  version?: string
}

export async function handlePlatformRequest(
  request: Request,
  info: PlatformInfo,
  rewritePath?: (pathname: string) => string,
): Promise<Response> {
  requestCount++
  const reqId = generateRequestId()

  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS })
  if (request.method !== "POST" && request.method !== "GET") {
    return new Response('{"error":"Only POST and GET allowed"}', { status: 405, headers: jsonHeaders() })
  }

  let pathname = rewritePath ? rewritePath(new URL(request.url).pathname) : new URL(request.url).pathname
  if (!pathname) pathname = "/"

  // /health: 增强版 (含统计)
  if (pathname === "/health") {
    const uptimeMs = Date.now() - startTime
    return new Response(
      JSON.stringify({
        status: "ok",
        platform: info.platform,
        version: info.version || VERSION,
        uptime_ms: uptimeMs,
        requests: { total: requestCount, success: successCount, error: errorCount },
        models_cached: modelsCache !== null && Date.now() - modelsCache.ts < MODELS_CACHE_TTL_MS,
      }, { headers: { ...jsonHeaders(), "Cache-Control": "public, max-age=60, s-maxage=60" } }),
    )
  }

  // /stats: 内存统计
  if (pathname === "/stats") {
    return new Response(
      JSON.stringify({
        platform: info.platform,
        version: info.version || VERSION,
        uptime_ms: Date.now() - startTime,
        requests: { total: requestCount, success: successCount, error: errorCount },
        models_cache: modelsCache ? { hit: true, age_ms: Date.now() - modelsCache.ts } : { hit: false },
      }, null, 2),
      { headers: jsonHeaders() },
    )
  }

  if (pathname === "/diagnose") {
    const [v4, v6] = await Promise.allSettled([fetchIp("https://api.ipify.org?format=json"), fetchIp("https://api6.ipify.org?format=json")])
    const ipv4 = v4.status === "fulfilled" ? v4.value : null
    const ipv6 = v6.status === "fulfilled" ? v6.value : null
    return new Response(JSON.stringify({ platform: info.platform, version: info.version || VERSION, ipv4, ipv6 }), { headers: jsonHeaders() })
  }

  // 收窄路径匹配: 只允许 /zen/v1/ (之前允许 /v1/ 导致无效路径穿透)
  if (!pathname.startsWith("/zen/v1/")) {
    return new Response('{"error":"Not found"}', { status: 404, headers: jsonHeaders() })
  }

  const url = new URL(request.url)
  const target = DEFAULT_TARGET + pathname + url.search
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()

  const headers = anonymizeClientHeaders(stripAllAuth(makeForwardHeaders(request)))

  // /zen/v1/models: 内存缓存 (GET 请求)
  if (pathname === "/zen/v1/models" && request.method === "GET") {
    const cached = getModelsFromCache()
    if (cached) {
      successCount++
      return new Response(cached, {
        headers: { ...jsonHeaders(), "X-Proxy-Source": "memory-cache", "X-Request-Id": reqId },
      })
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body,
      signal: controller.signal,
    })

    // 缓存 models 响应
    if (response.ok && pathname === "/zen/v1/models" && request.method === "GET") {
      const text = await response.text()
      setModelsCache(text)
      successCount++
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: { ...Object.fromEntries(response.headers), "X-Proxy-Source": "upstream", "X-Request-Id": reqId },
      })
    }

    // 添加请求 ID 到响应头
    const responseHeaders = new Headers(response.headers)
    responseHeaders.set("X-Request-Id", reqId)

    if (response.ok) successCount++
    else errorCount++

    return maybeCompressResponse(request, new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    }))
  } catch (err) {
    errorCount++
    return new Response(JSON.stringify({ error: "Upstream unreachable", request_id: reqId }), {
      status: 502,
      headers: jsonHeaders(),
    })
  } finally {
    clearTimeout(timer)
  }
}

async function fetchIp(endpoint: string): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3_000)
    try {
      const response = await fetch(endpoint, { signal: controller.signal })
      if (!response.ok) return null
      const data = (await response.json()) as { ip?: string }
      return typeof data.ip === "string" ? data.ip : null
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null
  }
}

function jsonHeaders(): Record<string, string> {
  return { ...CORS_HEADERS, "Content-Type": "application/json" }
}
