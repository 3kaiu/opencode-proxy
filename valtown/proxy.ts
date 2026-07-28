// opencode-proxy - Val Town adapter
// Deploy at https://val.town - create a new "HTTP" val, paste this code.
// Free tier: 100K runs/day, no CC, no sleep.

const TARGET_HOST = "https://opencode.ai"
const REQUEST_TIMEOUT_MS = 60_000

const CORS_HEADERS = {
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

export default async function (request: Request): Promise<Response> {
  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS })
  }
  if (request.method !== "POST" && request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Only GET and POST allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }

  const url = new URL(request.url)
  if (url.pathname === "/health") {
    return new Response(JSON.stringify({ status: "ok", platform: "valtown" }), {
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
