const TARGET_HOST = "https://opencode.ai"
const REQUEST_TIMEOUT_MS = 60_000

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
}

// 健康检查响应（惰性创建，避免 CF Workers 全局作用域限制）
function healthResponse(): Response {
  return new Response(
    JSON.stringify({ status: "ok", version: "1.0.0" }),
    {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    },
  )
}

// 随机 User-Agent 池 — 模拟不同客户端指纹，增加链路多样性
const USER_AGENTS = [
  "opencode/latest/1.3.15/cli",
  "opencode/latest/1.3.16/cli",
  "opencode/latest/1.3.17/cli",
  "opencode/latest/1.4.0/cli",
  "opencode/latest/1.4.1/cli",
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
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Only POST allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }
  return null
}

export async function proxyToOpenCode(request: Request): Promise<Response> {
  const url = new URL(request.url)

  // 健康检查
  if (url.pathname === "/health") return healthResponse()

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
  // 透传客户端 Content-Type，若无则默认
  const clientContentType = request.headers.get("Content-Type")
  forwardHeaders.set("Content-Type", clientContentType || "application/json")

  // 带超时的 fetch，直接返回原始 Response 以支持流式 SSE 透传
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