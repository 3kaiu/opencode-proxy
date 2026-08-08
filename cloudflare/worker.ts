// oc-router — Cloudflare Worker 网关
// 职责: 从 KV 读平台出口端点列表, 随机轮换分配, 转发 AI 流式 SSE
// 状态: 端点列表 + 429 枯竭标记 (KV, 跨 isolate 唯一可信状态)
// 不做: 健康分级/成功加权/粘性会话/冷却退避 (per-isolate 内存态在边缘多实例下无效)
// 重试: 网络错误 / 5xx / 429 均尝试下一个端点, 全部失败才回给客户端

interface Env {
  ENDPOINT_STATE: KVNamespace
}

interface Endpoint {
  name: string
  url: string
}

type ExhaustedMap = Record<string, number>

const VERSION = "2.1.0"
const KV_KEY_ENDPOINTS = "endpoints"
const KV_KEY_EXHAUSTED = "exhausted"
const FIRST_BYTE_TIMEOUT_MS = 15_000
const DEFAULT_EXHAUST_TTL = 30 * 60
const MIN_RETRY_AFTER = 30
const MAX_ATTEMPTS = 6
const ENDPOINTS_CACHE_TTL_MS = 60_000
const EXHAUSTED_CACHE_TTL_MS = 15_000
const KV_CACHE_TTL_ENDPOINTS = 60
const KV_CACHE_TTL_EXHAUSTED = 30

let endpointsCache: { data: Endpoint[] | null; ts: number } = { data: null, ts: 0 }
let exhaustedCache: { data: ExhaustedMap; ts: number } = { data: {}, ts: 0 }
let endpointsInFlight: Promise<Endpoint[] | null> | null = null
let exhaustedInFlight: Promise<ExhaustedMap> | null = null
const pendingExhausted = new Map<string, number>()

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
}

function isFreeUsageLimit(body: string): boolean {
  return body.includes("FreeUsageLimitError")
}

function parseRetryAfter(res: Response): number {
  const raw = res.headers.get("retry-after")
  if (!raw) return DEFAULT_EXHAUST_TTL
  const seconds = parseInt(raw, 10)
  if (isNaN(seconds) || seconds < MIN_RETRY_AFTER) return DEFAULT_EXHAUST_TTL
  return Math.min(seconds, 31_536_000)
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

async function getEndpoints(kv: KVNamespace): Promise<Endpoint[] | null> {
  const now = Date.now()
  if (endpointsCache.data !== null && now - endpointsCache.ts < ENDPOINTS_CACHE_TTL_MS) {
    return endpointsCache.data
  }
  if (!endpointsInFlight) {
    endpointsInFlight = (async () => {
      try {
        const raw = await kv.get(KV_KEY_ENDPOINTS, { cacheTtl: KV_CACHE_TTL_ENDPOINTS })
        if (!raw) {
          endpointsCache = { data: null, ts: Date.now() }
          return null
        }
        try {
          const endpoints = JSON.parse(raw) as Endpoint[]
          if (!Array.isArray(endpoints) || endpoints.length === 0) {
            endpointsCache = { data: null, ts: Date.now() }
            return null
          }
          endpointsCache = { data: endpoints, ts: Date.now() }
          return endpoints
        } catch {
          endpointsCache = { data: null, ts: Date.now() }
          return null
        }
      } finally {
        endpointsInFlight = null
      }
    })()
  }
  return endpointsInFlight
}

async function getExhausted(kv: KVNamespace): Promise<ExhaustedMap> {
  const now = Date.now()
  if (now - exhaustedCache.ts < EXHAUSTED_CACHE_TTL_MS) {
    return { ...exhaustedCache.data }
  }
  if (!exhaustedInFlight) {
    exhaustedInFlight = (async () => {
      try {
        const raw = await kv.get(KV_KEY_EXHAUSTED, { cacheTtl: KV_CACHE_TTL_EXHAUSTED })
        if (!raw) {
          exhaustedCache = { data: {}, ts: Date.now() }
          return {}
        }
        try {
          const map = JSON.parse(raw) as ExhaustedMap
          const nowSec = Math.floor(Date.now() / 1000)
          for (const key of Object.keys(map)) {
            if (map[key] <= nowSec) delete map[key]
          }
          exhaustedCache = { data: map, ts: Date.now() }
          return { ...map }
        } catch {
          exhaustedCache = { data: {}, ts: Date.now() }
          return {}
        }
      } finally {
        exhaustedInFlight = null
      }
    })()
  }
  return exhaustedInFlight
}

function markExhausted(map: ExhaustedMap, name: string, ttl: number): void {
  const expiry = Math.floor(Date.now() / 1000) + ttl
  map[name] = expiry
  pendingExhausted.set(name, expiry)
}

async function writeExhausted(kv: KVNamespace, map: ExhaustedMap): Promise<void> {
  for (const [name, expiry] of pendingExhausted) {
    if (map[name] === undefined || map[name] < expiry) map[name] = expiry
  }
  pendingExhausted.clear()
  const values = Object.values(map)
  if (values.length === 0) return
  const now = Math.floor(Date.now() / 1000)
  const maxExpiry = Math.max(...values, now + 60)
  const ttl = Math.max(60, maxExpiry - now)
  await kv.put(KV_KEY_EXHAUSTED, JSON.stringify(map), { expirationTtl: ttl })
}

// 头透传: 除 hop-by-hop/基础设施头外一律原样转发, 不做白名单改写
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
  for (const [key, value] of request.headers.entries()) {
    const lower = key.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower)) continue
    headers.set(key, value)
  }
  return headers
}

function noEndpointsError(): Response {
  return new Response(
    JSON.stringify({
      error:
        "No endpoints configured. Add platform endpoints to KV key \"" +
        KV_KEY_ENDPOINTS +
        '" as JSON array [{"name":"...","url":"https://..."}], e.g. via wrangler: `wrangler kv key put --binding ENDPOINT_STATE endpoints \'[...]\'`.',
    }),
    { status: 503, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  )
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS })
    }

    if (url.pathname === "/health") {
      const endpoints = await getEndpoints(env.ENDPOINT_STATE)
      const exhausted = await getExhausted(env.ENDPOINT_STATE)
      const statuses = (endpoints ?? []).map((ep) => ({
        name: ep.name,
        exhausted: ep.name in exhausted,
      }))
      const available = statuses.filter((s) => !s.exhausted).length
      return new Response(
        JSON.stringify({
          status: "ok",
          version: VERSION,
          platform: "cloudflare-router",
          available: `${available}/${statuses.length}`,
          endpoints: statuses,
        }),
        { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      )
    }

    if (!url.pathname.startsWith("/zen/v1/")) {
      return new Response(
        JSON.stringify({ error: `Unsupported path: ${url.pathname}. This worker proxies /zen/v1/* only.` }),
        { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      )
    }

    if (request.method !== "POST" && request.method !== "GET") {
      return new Response(JSON.stringify({ error: "Only GET and POST allowed" }), {
        status: 405,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      })
    }

    const [endpoints, exhausted] = await Promise.all([
      getEndpoints(env.ENDPOINT_STATE),
      getExhausted(env.ENDPOINT_STATE),
    ])
    if (!endpoints || endpoints.length === 0) return noEndpointsError()

    const body = request.method === "GET" ? undefined : await request.arrayBuffer()

    const forwardHeaders = makeForwardHeaders(request)

    const candidates = shuffle(endpoints)
    const now = Date.now()
    let skippedExhausted = 0
    let attempts = 0
    let newlyExhausted = 0
    let last429: { body: string; ttl: number } | null = null

    for (const ep of candidates) {
      const expiry = exhausted[ep.name]
      if (expiry !== undefined && expiry * 1000 > now) {
        skippedExhausted++
        continue
      }
      if (attempts >= MAX_ATTEMPTS) break
      attempts++

      const target = ep.url + url.pathname + url.search
      const controller = new AbortController()
      const onClientAbort = () => controller.abort()
      request.signal.addEventListener("abort", onClientAbort, { once: true })
      const timer = setTimeout(() => controller.abort(), FIRST_BYTE_TIMEOUT_MS)

      try {
        const res = await fetch(target, {
          method: request.method,
          headers: forwardHeaders,
          body,
          signal: controller.signal,
        })

        if (res.status === 429 || (res.status >= 500 && res.status <= 504)) {
          const text = await res.text()
          if (res.status >= 500) continue
          const ttl = parseRetryAfter(res)
          if (isFreeUsageLimit(text)) {
            markExhausted(exhausted, ep.name, ttl)
            newlyExhausted++
            ctx.waitUntil(writeExhausted(env.ENDPOINT_STATE, exhausted))
            continue
          }
          last429 = { body: text, ttl }
          continue
        }

        if (newlyExhausted > 0) ctx.waitUntil(writeExhausted(env.ENDPOINT_STATE, exhausted))
        delete exhausted[ep.name]
        // 成功响应原样透传: 只追加路由追踪头, 不覆盖上游任何响应头
        const responseHeaders = new Headers(res.headers)
        responseHeaders.set("X-Proxy-Endpoint", ep.name)
        if (attempts > 1) responseHeaders.set("X-Router-Retries", String(attempts - 1))
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers: responseHeaders,
        })
      } catch {
        continue
      } finally {
        clearTimeout(timer)
        request.signal.removeEventListener("abort", onClientAbort)
      }
    }

    if (newlyExhausted > 0) ctx.waitUntil(writeExhausted(env.ENDPOINT_STATE, exhausted))

    if (last429) {
      return new Response(last429.body, {
        status: 429,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json",
          "Retry-After": String(last429.ttl),
          "retry-after-ms": String(last429.ttl * 1000),
          "X-Router-Status": "all-exhausted",
          "X-Router-Tried": String(attempts),
          "X-Router-Skipped": String(skippedExhausted),
        },
      })
    }

    return new Response(
      JSON.stringify({ error: "All endpoints unavailable.", tried: attempts, skipped: skippedExhausted }),
      { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    )
  },
}