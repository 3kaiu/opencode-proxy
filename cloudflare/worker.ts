// oc-router — Cloudflare Worker 网关
// 职责: 从 KV 读平台出口端点列表, 随机轮换分配, 转发 AI 流式 SSE
// 状态: 端点列表 + 429 枯竭标记 (KV, 跨 isolate 唯一可信状态)
// 路由: /zen/v1/chat/completions 走平台端点代理; 其余 /zen/v1/* 直连官方 opencode.ai
// 重试: 网络错误 / 5xx / 429 均尝试下一个端点, 全部失败才回给客户端

interface Env {
  ENDPOINT_STATE: KVNamespace
  // 代理认证密钥: 客户端须带 Authorization: Bearer <AUTH_TOKEN> (未设置则跳过认证)
  AUTH_TOKEN?: string
}

interface Endpoint {
  name: string
  url: string
}

type ExhaustedMap = Record<string, number>

const VERSION = "2.2.0"
const KV_KEY_ENDPOINTS = "endpoints"
const KV_KEY_EXHAUSTED = "exhausted"
const FIRST_BYTE_TIMEOUT_MS = 90_000 // TTFB p95 4.3s; thinking 模型首字可 >15s, 15s 会误杀
const MIN_EXHAUST_SECONDS = 10 * 3600 // 429 限流最小枯竭时长: 至少 10h
const MIN_RETRY_AFTER = 30
const MAX_ATTEMPTS = 6
const ENDPOINTS_CACHE_TTL_MS = 60_000
const EXHAUSTED_CACHE_TTL_MS = 15_000
const KV_CACHE_TTL_ENDPOINTS = 60
const KV_CACHE_TTL_EXHAUSTED = 30
const FAIL_COOLDOWN_MS = 60_000      // 5xx/超时后冷却 60s, 避免每请求全量重打坏端点
const OFFICIAL_UPSTREAM = "https://opencode.ai" // /zen/v1 非 chat/completions 路径直连官方

let endpointsCache: { data: Endpoint[] | null; ts: number } = { data: null, ts: 0 }
let exhaustedCache: { data: ExhaustedMap; ts: number } = { data: {}, ts: 0 }
let endpointsInFlight: Promise<Endpoint[] | null> | null = null
let exhaustedInFlight: Promise<ExhaustedMap> | null = null
const pendingExhausted = new Map<string, number>()
const failCooldown = new Map<string, number>()

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
}

function isFreeUsageLimit(body: string): boolean {
  return body.includes("FreeUsageLimitError")
}

// 429 限流为"当天额度耗尽": 枯竭到次日 UTC 零点重置, 且至少 10h
// (免费额度按天结算, 当天不会恢复; 次日 0 点 UTC 自动重试)
function exhaustSeconds(): number {
  const now = new Date()
  const reset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return Math.max(MIN_EXHAUST_SECONDS, Math.floor((reset - now.getTime()) / 1000))
}

function parseRetryAfter(res: Response): number {
  const raw = res.headers.get("retry-after")
  if (!raw) return exhaustSeconds()
  const seconds = parseInt(raw, 10)
  if (isNaN(seconds) || seconds < MIN_RETRY_AFTER) return exhaustSeconds()
  return Math.min(Math.max(seconds, MIN_EXHAUST_SECONDS), 31_536_000)
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
  // 同步更新内存缓存: 否则同一 isolate 的 EXHAUSTED_CACHE_TTL_MS 窗口内
  // 后续请求读缓存副本(无新标记)仍会重打该端点
  exhaustedCache.data[name] = expiry
}

async function writeExhausted(kv: KVNamespace, map: ExhaustedMap, removed: string[] = []): Promise<void> {
  for (const name of removed) {
    if (name in map) delete map[name]
  }
  for (const [name, expiry] of pendingExhausted) {
    if (map[name] === undefined || map[name] < expiry) map[name] = expiry
  }
  pendingExhausted.clear()
  const values = Object.values(map)
  if (values.length === 0) return

  // 写前重读 KV 合并: 多 isolate 并发写 exhausted 时后写会覆盖先写的标记(lost update)
  // 取每个端点的最大过期时间, 防止新 429 标记被旧快照覆盖
  let merged = map
  try {
    const raw = await kv.get(KV_KEY_EXHAUSTED, { cacheTtl: 0 })
    if (raw) {
      const latest = JSON.parse(raw) as ExhaustedMap
      merged = { ...latest }
      for (const [name, expiry] of Object.entries(map)) {
        merged[name] = Math.max(expiry, latest[name] ?? 0)
      }
    }
  } catch {
    // KV 读失败则直接用当前 map
  }

  const now = Math.floor(Date.now() / 1000)
  const maxExpiry = Math.max(...Object.values(merged), now + 60)
  const ttl = Math.max(60, maxExpiry - now)
  await kv.put(KV_KEY_EXHAUSTED, JSON.stringify(merged), { expirationTtl: ttl })
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

// 占位 apiKey 剥离: 官方对 Bearer dummy / 空 key 返回 401, 转发前移除
// (用户配置 apiKey: dummy 时代理可正常工作)
const PLACEHOLDER_AUTH = /^(Bearer\s+)?(dummy|placeholder|sk-dummy|test|x|empty)$/i

function stripPlaceholderAuth(headers: Headers): Headers {
  const auth = headers.get("authorization")
  if (!auth) return headers
  const token = auth.replace(/^Bearer\s+/i, "").trim()
  if (token === "" || PLACEHOLDER_AUTH.test(token)) {
    headers.delete("authorization")
  }
  return headers
}

// 剥离代理自身认证头: 校验通过的 AUTH_TOKEN 是代理密钥, 不能让上游/平台拿到
function stripProxyToken(headers: Headers, isProxyToken: boolean): Headers {
  if (isProxyToken) headers.delete("authorization")
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

// 代理认证: 客户端携带 Bearer <AUTH_TOKEN> 放行; 未配置密钥则跳过(本地/私有部署兼容)
// 返回值标记该 auth 头是否为代理自己的密钥 — 是则转发时剥离(官方不需要且不应拿到)
function checkAuth(request: Request, token: string | undefined): { ok: boolean; isProxyToken: boolean } {
  if (!token) return { ok: true, isProxyToken: false }
  const auth = request.headers.get("authorization") || ""
  const provided = auth.replace(/^Bearer\s+/i, "").trim()
  return { ok: provided === token, isProxyToken: provided === token }
}

function authFailed(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized: missing or invalid AUTH_TOKEN." }), {
    status: 401,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  })
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

    // 代理认证: 除 OPTIONS/health 外一律校验; 防止匿名滥用烧光平台免费额度
    const auth = checkAuth(request, env.AUTH_TOKEN)
    if (!auth.ok) return authFailed()

    // 非 chat/completions 路径(如 /zen/v1/models): 直连官方上游, 不走平台代理
    if (url.pathname !== "/zen/v1/chat/completions") {
      const body = request.method === "GET" ? undefined : await request.arrayBuffer()
      const upstreamTarget = OFFICIAL_UPSTREAM + url.pathname + url.search
      try {
        const res = await fetch(upstreamTarget, {
          method: request.method,
          headers: stripProxyToken(makeForwardHeaders(request), auth.isProxyToken),
          body,
        })
        const h = new Headers(res.headers)
        h.set("X-Proxy-Source", "official")
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers: h,
        })
      } catch {
        return new Response(
          JSON.stringify({ error: "Official upstream unreachable." }),
          { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
        )
      }
    }

    const [endpoints, exhausted] = await Promise.all([
      getEndpoints(env.ENDPOINT_STATE),
      getExhausted(env.ENDPOINT_STATE),
    ])
    if (!endpoints || endpoints.length === 0) return noEndpointsError()

    const body = request.method === "GET" ? undefined : await request.arrayBuffer()

    const forwardHeaders = stripProxyToken(stripPlaceholderAuth(makeForwardHeaders(request)), auth.isProxyToken)

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
      const cdUntil = failCooldown.get(ep.name)
      if (cdUntil !== undefined && cdUntil > now) {
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
          // 429/5xx 诊断信息通常 <2KB; 截断读取避免把大错误体全量拉进内存
          const reader = res.body!.getReader()
          const buf = new Uint8Array(2048)
          let got = 0
          while (got < 2048) {
            const { value, done } = await reader.read()
            if (done) break
            if (value) {
              const n = Math.min(value.length, 2048 - got)
              buf.set(value.subarray(0, n), got)
              got += n
            }
          }
          reader.cancel()
          const text = new TextDecoder().decode(buf.subarray(0, got))
          if (res.status >= 500) {
            // 5xx 是端点自身问题: 冷却期内不再重复打
            failCooldown.set(ep.name, Date.now() + FAIL_COOLDOWN_MS)
            continue
          }
          const ttl = parseRetryAfter(res)
          if (isFreeUsageLimit(text)) {
            markExhausted(exhausted, ep.name, ttl)
            newlyExhausted++
            ctx.waitUntil(writeExhausted(env.ENDPOINT_STATE, exhausted))
            // 记录待透传 429: 全部端点耗尽时优先回 429+Retry-After, 而非 502
            // (客户端能识别限流并尊重 Retry-After, 避免误判故障后狂重试白耗额度)
            last429 = { body: text, ttl }
            continue
          }
          last429 = { body: text, ttl }
          continue
        }

        if (newlyExhausted > 0) ctx.waitUntil(writeExhausted(env.ENDPOINT_STATE, exhausted))
        // 成功响应: 该端点在 KV 中的枯竭标记已过期, 同步清除(仅内存删除会让其他 isolate 继续跳过)
        if (ep.name in exhausted) {
          ctx.waitUntil(writeExhausted(env.ENDPOINT_STATE, exhausted, [ep.name]))
        }
        delete exhausted[ep.name]
        delete exhaustedCache.data[ep.name]
        failCooldown.delete(ep.name)
        const responseHeaders = new Headers(res.headers)
        responseHeaders.set("X-Proxy-Endpoint", ep.name)
        if (attempts > 1) responseHeaders.set("X-Router-Retries", String(attempts - 1))
        console.log(
          JSON.stringify({
            ev: "proxy",
            ts: Date.now(),
            path: url.pathname,
            endpoint: ep.name,
            retries: attempts - 1,
            status: res.status,
          }),
        )
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers: responseHeaders,
        })
      } catch {
        // 客户端中断连接不算端点故障, 不冷却; 否则冷却该端点
        if (!request.signal.aborted) {
          failCooldown.set(ep.name, Date.now() + FAIL_COOLDOWN_MS)
        }
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