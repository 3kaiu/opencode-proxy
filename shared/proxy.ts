// 平台出口代理核心（唯一真源；构建期由 scripts/build.mjs 打单文件并 minify）
// 行为: 只允许 /zen/* 与 /v1/* API 路径, 请求/响应头除 hop-by-hop 与基础设施头外
//       原样透传, 目标是 opencode.ai（可选 x-proxy-target 白名单覆盖, 由网关透传）。

export const VERSION = "2.1.0"

const DEFAULT_TARGET = "https://opencode.ai"
const TARGET_HEADER = "x-proxy-target"
const ALLOWED_TARGET_HOSTS = ["opencode.ai"]
const REQUEST_TIMEOUT_MS = 60_000
const API_PREFIXES = ["/zen/", "/v1/"]

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
}

// 头透传: 除 hop-by-hop/基础设施头外一律原样转发; 响应链上不做任何改写
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
    headers.set(key, value)
  }
  return headers
}

// 占位 apiKey 判定: 官方对 Bearer dummy / 空 key 返回 401/报错,
// 转发前剥离, 让官方按未认证的免费模型处理
const PLACEHOLDER_AUTH = /^(Bearer\s+)?(dummy|placeholder|sk-dummy|test|x|empty|oc-proxy)$/i

function stripPlaceholderAuth(headers: Headers): Headers {
  const auth = headers.get("authorization")
  if (!auth) return headers
  const token = auth.replace(/^Bearer\s+/i, "").trim()
  if (token === "" || PLACEHOLDER_AUTH.test(token)) {
    headers.delete("authorization")
  }
  return headers
}

// 响应压缩: 官方返回明文 SSE/JSON, 客户端接受 gzip 时在出口压缩, 省下行带宽
// 运行时不提供 CompressionStream(如 Wasmer WinterJS)时跳过压缩, 保证可用性
function maybeCompressResponse(request: Request, response: Response): Response {
  if (typeof CompressionStream === "undefined") return response
  const acceptEncoding = (request.headers.get("accept-encoding") || "").toLowerCase()
  if (!acceptEncoding.includes("gzip")) return response
  if (response.headers.get("content-encoding")) return response
  const contentType = response.headers.get("content-type") || ""
  if (!/text\/|application\/json|event-stream|javascript/i.test(contentType)) return response

  const headers = new Headers(response.headers)
  headers.set("content-encoding", "gzip")
  const vary = headers.get("vary")
  headers.set("vary", vary ? vary + ", accept-encoding" : "accept-encoding")
  headers.delete("content-length")

  const body = response.body ? response.body.pipeThrough(new CompressionStream("gzip")) : null
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}

interface PlatformInfo {
  platform: string
  version?: string
}

export async function handlePlatformRequest(
  request: Request,
  info: PlatformInfo,
  rewritePath?: (pathname: string) => string,
): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS })
  if (request.method !== "POST" && request.method !== "GET") {
    return new Response('{"error":"Only POST and GET allowed"}', { status: 405, headers: jsonHeaders() })
  }

  let pathname = rewritePath ? rewritePath(new URL(request.url).pathname) : new URL(request.url).pathname
  if (!pathname) pathname = "/"

  if (pathname === "/health") {
    return new Response(
      JSON.stringify({ status: "ok", platform: info.platform, version: info.version || VERSION, noCache: true }),
      { headers: { ...jsonHeaders(), "Cache-Control": "public, max-age=60, s-maxage=60" } },
    )
  }

  if (pathname === "/diagnose") {
    const [v4, v6] = await Promise.allSettled([fetchIp("https://api.ipify.org?format=json"), fetchIp("https://api6.ipify.org?format=json")])
    const ipv4 = v4.status === "fulfilled" ? v4.value : null
    const ipv6 = v6.status === "fulfilled" ? v6.value : null
    return new Response(JSON.stringify({ platform: info.platform, version: info.version || VERSION, ipv4, ipv6 }), { headers: jsonHeaders() })
  }

  if (!API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return new Response('{"error":"Not found"}', { status: 404, headers: jsonHeaders() })
  }

  const url = new URL(request.url)
  // 用剥离后的 pathname 构造上游 target：平台挂载前缀（如 Supabase /proxy-1）不能透传给官方
  const target = resolveTarget(request) ?? DEFAULT_TARGET + pathname + url.search
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()

  const headers = stripPlaceholderAuth(makeForwardHeaders(request))

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body,
      signal: controller.signal,
    })
    return maybeCompressResponse(request, response)
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

function resolveTarget(request: Request): string | null {
  const raw = request.headers.get(TARGET_HEADER)
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== "https:") return null
    const host = url.hostname.toLowerCase()
    if (!ALLOWED_TARGET_HOSTS.some((allowed) => host === allowed || host.endsWith("." + allowed))) return null
    return raw
  } catch {
    return null
  }
}

function jsonHeaders(): Record<string, string> {
  return { ...CORS_HEADERS, "Content-Type": "application/json" }
}