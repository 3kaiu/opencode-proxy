// oc-router — Cloudflare Worker 智能路由层
//
// 数据面（OpenCode → Worker）：无鉴权，直接代理
// 管理面（oc CLI → CF KV）：通过 CF API / wrangler 读写端点列表
//
// 端点列表存储在 KV key "endpoints"（由 oc CLI 管理）
// 耗尽状态存储在 KV key "exhausted"（由 Worker 自动维护）
//
// 路由策略：
//   请求进来 → 洗牌 → 跳过已耗尽的 → 依次尝试
//   碰到 429 FreeUsageLimitError → 标记耗尽 → 继续试下一个（客户端无感）
//   碰到 200 → 流式透传给客户端
//   全部 429 → 批量写 KV → 把最后一个 429 透传给客户端
//   客户端只看到两种结果：200（成功）或 429（全部耗尽）
//
// 性能优化 — 模块级内存缓存（同 isolate 内跨请求复用）：
//   endpoints: 缓存 60s（端点列表极少变动，oc add/del 才改）
//   exhausted: 缓存 10s（需较新鲜以影响路由决策）
//   KV 读从每请求 2 次 → 每 isolate 每分钟约 2 次
//   KV 写不变：仅在新增耗尽时写，每请求最多 1 次
//
// 实测 429 响应特征（所有平台一致）：
//   HTTP 429, Content-Type: text/plain;charset=UTF-8
//   Header: retry-after: <seconds>（距重置的精确秒数）
//   Body: {"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."},"metadata":{}}

interface Env {
  ENDPOINT_STATE: KVNamespace
}

interface Endpoint {
  name: string
  url: string
}

/** 耗尽状态 map：{ [endpointName]: expiryUnixTimestamp } */
type ExhaustedMap = Record<string, number>

const REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_EXHAUST_TTL = 8 * 3600
const KV_KEY_ENDPOINTS = "endpoints"
const KV_KEY_EXHAUSTED = "exhausted"

// ── 模块级缓存（同 isolate 跨请求复用，冷启动时为空）──
const ENDPOINTS_CACHE_TTL_MS = 60_000 // 端点列表 60s 缓存
const EXHAUSTED_CACHE_TTL_MS = 10_000 // 耗尽状态 10s 缓存
let endpointsCache: { data: Endpoint[] | null; ts: number } = { data: null, ts: 0 }
let exhaustedCache: { data: ExhaustedMap; ts: number } = { data: {}, ts: 0 }

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
  if (isNaN(seconds) || seconds < 60) return DEFAULT_EXHAUST_TTL
  return Math.min(seconds, 31_536_000)
}

/** 带缓存的端点列表读取：60s 内复用内存，过期才读 KV */
async function getEndpoints(kv: KVNamespace): Promise<Endpoint[] | null> {
  const now = Date.now()
  if (endpointsCache.data !== null && now - endpointsCache.ts < ENDPOINTS_CACHE_TTL_MS) {
    return endpointsCache.data
  }
  const raw = await kv.get(KV_KEY_ENDPOINTS)
  if (!raw) {
    endpointsCache = { data: null, ts: now }
    return null
  }
  try {
    const endpoints = JSON.parse(raw) as Endpoint[]
    if (!Array.isArray(endpoints) || endpoints.length === 0) {
      endpointsCache = { data: null, ts: now }
      return null
    }
    endpointsCache = { data: endpoints, ts: now }
    return endpoints
  } catch {
    endpointsCache = { data: null, ts: now }
    return null
  }
}

/** 带缓存的耗尽状态读取：10s 内复用内存，过期才读 KV。返回浅拷贝防止污染缓存 */
async function getExhausted(kv: KVNamespace): Promise<ExhaustedMap> {
  const now = Date.now()
  if (now - exhaustedCache.ts < EXHAUSTED_CACHE_TTL_MS) {
    return { ...exhaustedCache.data }
  }
  const raw = await kv.get(KV_KEY_EXHAUSTED)
  if (!raw) {
    exhaustedCache = { data: {}, ts: now }
    return {}
  }
  try {
    const map = JSON.parse(raw) as ExhaustedMap
    const nowSec = Math.floor(now / 1000)
    for (const key of Object.keys(map)) {
      if (map[key] <= nowSec) delete map[key]
    }
    exhaustedCache = { data: map, ts: now }
    return { ...map }
  } catch {
    exhaustedCache = { data: {}, ts: now }
    return {}
  }
}

/** 标记耗尽：同时更新内存缓存和 KV */
async function markExhausted(kv: KVNamespace, map: ExhaustedMap, name: string, ttl: number): Promise<void> {
  map[name] = Math.floor(Date.now() / 1000) + ttl
  // 立即更新内存缓存，当前 isolate 后续请求立刻跳过
  exhaustedCache = { data: { ...map }, ts: Date.now() }
}

/** KV 写：TTL 取所有条目中最大的剩余时间 */
async function writeExhausted(kv: KVNamespace, map: ExhaustedMap): Promise<void> {
  const values = Object.values(map)
  if (values.length === 0) return
  const now = Math.floor(Date.now() / 1000)
  const maxExpiry = Math.max(...values, now + 60)
  const ttl = Math.max(60, maxExpiry - now)
  await kv.put(KV_KEY_EXHAUSTED, JSON.stringify(map), { expirationTtl: ttl })
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function noEndpointsError(): Response {
  return new Response(JSON.stringify({ error: "No endpoints configured. Use: oc add <name> <url>" }), {
    status: 503,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS })
    }

    // 健康检查 — 返回各端点耗尽状态（公开，不含端点 URL）
    if (url.pathname === "/health") {
      const endpoints = await getEndpoints(env.ENDPOINT_STATE)
      if (!endpoints) return noEndpointsError()
      const exhausted = await getExhausted(env.ENDPOINT_STATE)
      const statuses = endpoints.map((ep) => ({
        name: ep.name,
        exhausted: ep.name in exhausted,
      }))
      const available = statuses.filter((s) => !s.exhausted).length
      return new Response(
        JSON.stringify({
          status: "ok",
          version: "1.6.0",
          platform: "cloudflare-router",
          available: `${available}/${statuses.length}`,
          endpoints: statuses,
        }),
        { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      )
    }

    // 仅放行 /zen/v1/* API 路径，其余全部 404
    if (!url.pathname.startsWith("/zen/v1/")) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      })
    }

    if (request.method !== "POST" && request.method !== "GET") {
      return new Response(JSON.stringify({ error: "Only GET and POST allowed" }), {
        status: 405,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      })
    }

    // ── 缓存读取：通常 0 次 KV 读（命中缓存），最多 2 次（缓存过期）──
    const endpoints = await getEndpoints(env.ENDPOINT_STATE)
    if (!endpoints) return noEndpointsError()
    const exhausted = await getExhausted(env.ENDPOINT_STATE)

    const suffix = url.pathname.replace(/^\/zen\/v1/, "") || "/"

    // 请求体只读一次，重试时复用
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer()

    // 转发 headers
    // 不转发客户端的 Authorization（可能含客户端自己的凭据）
    // opencode.ai 免费层要求 Authorization: Bearer 头存在（可以为空）
    const forwardHeaders = new Headers()
    for (const [key, value] of request.headers.entries()) {
      const lower = key.toLowerCase()
      if (lower.startsWith("x-opencode-")) {
        forwardHeaders.set(key, value)
      }
    }
    forwardHeaders.set("Content-Type", request.headers.get("Content-Type") || "application/json")
    forwardHeaders.set("Authorization", "Bearer ")

    // ── 核心路由：洗牌 → 跳过已耗尽 → 依次尝试 → 429 内部吸收 ──
    const candidates = shuffle(endpoints)
    let skippedExhausted = 0
    let triedCount = 0
    let newlyExhausted = 0
    let last429Body: string | null = null
    let last429Ttl = DEFAULT_EXHAUST_TTL

    for (const ep of candidates) {
      if (ep.name in exhausted) {
        skippedExhausted++
        continue
      }

      const target = ep.url + suffix + url.search
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      triedCount++

      try {
        const res = await fetch(target, {
          method: request.method,
          headers: forwardHeaders,
          body,
          signal: controller.signal,
        })

        // 429 免费额度限流 → 标记 → 继续试下一个（客户端无感）
        if (res.status === 429) {
          const text = await res.text()
          if (isFreeUsageLimit(text)) {
            const ttl = parseRetryAfter(res)
            await markExhausted(env.ENDPOINT_STATE, exhausted, ep.name, ttl)
            newlyExhausted++
            last429Body = text
            last429Ttl = ttl
            continue
          }
          // 非免费额度限流的 429，直接透传
          if (newlyExhausted > 0) await writeExhausted(env.ENDPOINT_STATE, exhausted)
          return new Response(text, {
            status: 429,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json", "X-Proxy-Endpoint": ep.name },
          })
        }

        // 成功：批量写 KV（如有新耗尽），然后流式透传
        if (newlyExhausted > 0) await writeExhausted(env.ENDPOINT_STATE, exhausted)
        const responseHeaders = new Headers(res.headers)
        responseHeaders.set("Access-Control-Allow-Origin", "*")
        responseHeaders.set("X-Proxy-Endpoint", ep.name)
        if (skippedExhausted > 0 || triedCount > 1) {
          responseHeaders.set("X-Router-Retries", String(triedCount - 1))
        }
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers: responseHeaders,
        })
      } catch {
        // 网络错误 / 超时 — 跳过，不标记耗尽
        continue
      } finally {
        clearTimeout(timer)
      }
    }

    // ── 全部端点耗尽或不可用 ──
    if (newlyExhausted > 0) await writeExhausted(env.ENDPOINT_STATE, exhausted)

    if (last429Body) {
      return new Response(last429Body, {
        status: 429,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json",
          "Retry-After": String(last429Ttl),
          "X-Router-Status": "all-exhausted",
          "X-Router-Tried": String(triedCount),
          "X-Router-Skipped": String(skippedExhausted),
        },
      })
    }

    return new Response(
      JSON.stringify({ error: "All endpoints unavailable.", tried: triedCount, skipped: skippedExhausted }),
      { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    )
  },
}
