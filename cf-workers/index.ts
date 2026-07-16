// opencode-proxy — Cloudflare Worker（单文件，无外部依赖）

const TARGET_HOST = "https://opencode.ai"
const REQUEST_TIMEOUT_MS = 60_000

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
}

function healthResponse() {
  return new Response(
    JSON.stringify({ status: "ok", version: "1.0.0" }),
    { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  )
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

function handlePreflight(request) {
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

async function proxyToOpenCode(request) {
  const url = new URL(request.url)
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

async function isFreeUsageExceeded(response) {
  if (response.status !== 403 && response.status !== 429) return false
  const text = await response.clone().text()
  return text.includes("Free usage exceeded, subscribe to Go")
}

async function triggerSelfRedeploy(hookUrl) {
  if (!hookUrl) {
    console.error("[redeploy] No deploy hook URL configured — skipping")
    return
  }
  console.log("[redeploy] Free usage limit hit, triggering self redeploy...")
  try {
    const res = await fetch(hookUrl, { method: "POST" })
    if (!res.ok) {
      console.error(`[redeploy] Hook returned ${res.status}: ${await res.text()}`)
    } else {
      console.log("[redeploy] Redeploy triggered successfully")
    }
  } catch (err) {
    console.error("[redeploy] Failed to trigger redeploy:", err)
  }
}

export default {
  async fetch(request, env, ctx) {
    const preflight = handlePreflight(request)
    if (preflight) return preflight

    const response = await proxyToOpenCode(request)

    if (await isFreeUsageExceeded(response)) {
      ctx.waitUntil(triggerSelfRedeploy(env.DEPLOY_HOOK_URL))
    }

    return response
  },
}