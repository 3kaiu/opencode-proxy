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
  const target = resolveTarget(request) ?? DEFAULT_TARGET + url.pathname + url.search
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()

  const headers = makeForwardHeaders(request)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(target, {
      method: request.method,
      headers,
      body,
      signal: controller.signal,
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