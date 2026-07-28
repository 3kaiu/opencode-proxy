// opencode-proxy - Fermyon Cloud adapter (Spin JS SDK)
// Deploy: cd fermyon && npm install && spin deploy
// Free tier: 100K req/month, 500 outbound req/hour, 30s timeout, 5GB egress
// Exit IP: Akamai/Fermyon infrastructure (non-Cloudflare) ✅

const TARGET_HOST = "https://opencode.ai"
const REQUEST_TIMEOUT_MS = 25_000 // Spin free tier has 30s handler limit

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
}

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

function handlePreflight(request: Request): Response | null {
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

async function proxyToOpenCode(request: Request): Promise<Response> {
  const url = new URL(request.url)

  // 健康检查
  if (url.pathname === "/health") {
    return new Response(
      JSON.stringify({ status: "ok", platform: "fermyon" }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    )
  }

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
  forwardHeaders.set("Content-Type", request.headers.get("Content-Type") || "application/json")

  // Spin JS 支持 AbortController，但 30s 是平台硬限
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

// Spin JS 使用标准 FetchEvent (Service Worker 模式)
// @ts-ignore - Spin 运行时提供 FetchEvent
addEventListener("fetch", (event: FetchEvent) => {
  const preflight = handlePreflight(event.request)
  if (preflight) {
    event.respondWith(preflight)
    return
  }
  event.respondWith(proxyToOpenCode(event.request))
})
