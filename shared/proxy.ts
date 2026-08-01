const TARGET_HOST = "https://opencode.ai"
const REQUEST_TIMEOUT_MS = 60_000

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
}

// 只代理 API 路径，拒绝官网静态资源（字体/CSS/JS/图片），避免烧 Edge Function 调用量
const API_PREFIXES = ["/zen/", "/v1/"]

export function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some((p) => pathname.startsWith(p))
}

function notFoundResponse(): Response {
  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  })
}

function healthResponse(platform: string): Response {
  return new Response(
    JSON.stringify({ status: "ok", version: "1.3.0", platform }),
    { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  )
}

// 随机 User-Agent 池 — 模拟不同客户端指纹，增加链路多样性
const USER_AGENTS = [
  "opencode/latest/0.0.50/cli",
  "opencode/latest/0.0.51/cli",
  "opencode/latest/0.0.52/cli",
  "opencode/latest/0.0.53/cli",
  "opencode/latest/0.0.54/cli",
  "opencode/latest/0.0.55/cli",
]

const randomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]

const randomHex = (bytes = 8) => {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("")
}

/** 处理 CORS preflight 和 method 校验，返回 null 表示通过 */
export function handlePreflight(request: Request): Response | null {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS })
  }
  if (request.method !== "POST" && request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Only GET and POST allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }
  return null
}

export async function proxyToOpenCode(request: Request, platform = "shared"): Promise<Response> {
  const url = new URL(request.url)

  if (url.pathname === "/health") return healthResponse(platform)

  // 非 API 路径直接 404，不转发到上游
  if (!isApiPath(url.pathname)) return notFoundResponse()

  const target = TARGET_HOST + url.pathname + url.search

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer()

  const forwardHeaders = new Headers()
  for (const [key, value] of request.headers.entries()) {
    const lowerKey = key.toLowerCase()
    if (lowerKey.startsWith("x-opencode-") || lowerKey === "authorization") {
      forwardHeaders.set(key, value)
    }
  }
  forwardHeaders.set("User-Agent", randomUserAgent())
  forwardHeaders.set("X-Random-ID", randomHex(8))
  const clientContentType = request.headers.get("Content-Type")
  forwardHeaders.set("Content-Type", clientContentType || "application/json")

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(target, {
      method: request.method,
      headers: forwardHeaders,
      body,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}
