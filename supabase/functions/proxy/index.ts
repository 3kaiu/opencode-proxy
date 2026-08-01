// opencode-proxy - Supabase Edge Function adapter
// Deploy: supabase functions deploy proxy --no-verify-jwt
// Free tier: 500K invocations/month, no CC, Deno-based.
// Note: Supabase strips /functions/v1 prefix, so pathname starts with /proxy/...

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

function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some((p) => pathname.startsWith(p))
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS })
  }
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Only GET and POST allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }

  const url = new URL(req.url)
  // Supabase strips /functions/v1, so pathname is like /proxy/zen/v1/models
  // Strip the /proxy prefix to get the target path
  let proxyPath = url.pathname.replace(/^\/proxy/, "")
  if (proxyPath === "" || proxyPath === "/" || proxyPath === "/health") {
    return new Response(
      JSON.stringify({ status: "ok", version: "1.3.0", platform: "supabase" }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    )
  }

  // 非 API 路径直接 404，不转发到上游
  if (!isApiPath(proxyPath)) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }

  const target = TARGET_HOST + proxyPath + url.search

  const body =
    req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer()

  const forwardHeaders = new Headers()
  for (const [key, value] of req.headers.entries()) {
    const lowerKey = key.toLowerCase()
    if (lowerKey.startsWith("x-opencode-") || lowerKey === "authorization") {
      forwardHeaders.set(key, value)
    }
  }
  forwardHeaders.set("User-Agent", randomUserAgent())
  forwardHeaders.set("X-Random-ID", randomHex(8))
  forwardHeaders.set("Content-Type", req.headers.get("Content-Type") || "application/json")

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(target, {
      method: req.method,
      headers: forwardHeaders,
      body,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
})
