// opencode-proxy — Vercel Edge Function（单文件，无外部依赖）

const TARGET_HOST = "https://opencode.ai"
const REQUEST_TIMEOUT_MS = 60_000

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
}

// 只代理 API 路径，拒绝官网静态资源，避免烧 Edge Function 调用量
const API_PREFIXES = ["/zen/", "/v1/"]

function isApiPath(pathname) {
  return API_PREFIXES.some((p) => pathname.startsWith(p))
}

function healthResponse() {
  return new Response(
    JSON.stringify({ status: "ok", version: "1.3.0", platform: "vercel" }),
    { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  )
}

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

function handlePreflight(request) {
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

async function proxyToOpenCode(request) {
  const url = new URL(request.url)
  if (url.pathname === "/health") return healthResponse()

  // 非 API 路径直接 404，不转发到上游
  if (!isApiPath(url.pathname)) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
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

export default async function handler(request) {
  const preflight = handlePreflight(request)
  if (preflight) return preflight

  return await proxyToOpenCode(request)
}

export const config = { runtime: "edge" }
