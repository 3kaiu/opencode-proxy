// oc-router — Cloudflare Worker 智能路由层
//
// 数据面（OpenCode → Worker）：无鉴权，直接代理
// 管理面（oc CLI → CF KV）：通过 CF API / wrangler 读写端点列表
//
// 端点列表存储在 KV key "endpoints"（由 oc CLI 管理）
// 耗尽状态存储在 KV key "exhausted"（由 Worker 自动维护）
//
// 路由策略：
//   请求进来 → 按健康度分级洗牌 → 跳过已耗尽的 → 依次尝试
//   碰到 429 FreeUsageLimitError → 标记耗尽 → 继续试下一个（客户端无感）
//   碰到 200 → 流式透传给客户端
//   全部 429 → 批量写 KV → 把最后一个 429 透传给客户端
//   客户端只看到两种结果：200（成功）或 429（全部耗尽）
//
// v1.7.0 性能优化：
//   1. 健康端点池：内存记录每端点最近成功时间与连续失败次数，
//      路由时"近期成功者优先"，冷/失败者靠后，避免反复撞死端点
//   2. 分阶段超时：首字节超时 15s（原 60s），流式返回后不再受整体超时约束；
//      客户端断开时主动 abort 上游，节省 subrequest 配额
//   3. 耗尽 TTL 30min（原 8h），retry-after ≥30s 生效（原 60s），
//      免费额度按分钟/小时重置，短 TTL 显著提高端点利用率
//   4. KV 读单飞（in-flight 去重）+ cacheTtl 全局边缘缓存：
//      冷启动并发不击穿 KV，跨 isolate 共享缓存，KV 读成本趋近 0
//   5. KV 写改 waitUntil 异步：成功路径不再等待 KV 落盘，直接开始流式透传
//   6. 网络失败冷却：非 429 的失败进入 30s 内存冷却，避免反复打挂掉端点

// v1.8.0 优化（基于 opencode 客户端行为 + CF 免费层研究）：
//   1. Sticky 会话路由：按 x-opencode-session 固定同一上游，避免同一会话
//      在不同免费端点间漂移（各端点额度/上下文独立）；失败自动切换
//   2. KV 写合并节流：耗尽标记 coalesce 到模块级状态 + 1.5s 节流落盘，
//      规避 KV 同 key 1 次/秒写入限制与多请求互相覆盖丢数据
//   3. 错误契约对齐 opencode：429 全耗尽时同时回 Retry-After + retry-after-ms
//      （客户端精确等待后重试）；/responses /messages 等不支持的路径
//      直接回 404 带引导文案（客户端不重试，用户即时可见）

interface Env {
  ENDPOINT_STATE: KVNamespace
}

interface Endpoint {
  name: string
  url: string
}

/** 耗尽状态 map：{ [endpointName]: expiryUnixTimestamp } */
type ExhaustedMap = Record<string, number>

/** 每端点健康记录（模块级内存，同 isolate 内共享） */
interface HealthEntry {
  lastSuccess: number // 最近成功时间戳，0 = 从未成功
  consecutiveFails: number
  cooldownUntil: number // 非 429 失败后的冷却截止时间戳
}

const FIRST_BYTE_TIMEOUT_MS = 15_000
const DEFAULT_EXHAUST_TTL = 30 * 60
const MIN_RETRY_AFTER = 30
const COOLDOWN_MS = 30_000
const FRESH_WINDOW_MS = 10 * 60_000
// 耗尽端点概率性提前探测：TTL 剩余不足 50% 时，以该概率放行试一次。
// 免费额度常按分钟/小时重置，提前探测可让恢复的端点立即复用，避免闲置。
const PROBE_THRESHOLD_RATIO = 0.5
const PROBE_PROBABILITY = 0.05
const KV_KEY_ENDPOINTS = "endpoints"
const KV_KEY_EXHAUSTED = "exhausted"

// Sticky 会话路由参数
const STICKY_TTL_MS = 30 * 60_000 // 会话固定关系 30min 无活跃后过期
const STICKY_MAX_ENTRIES = 512 // 防内存膨胀，超出淘汰最旧一半
// KV 写节流参数
const EXHAUSTED_FLUSH_MIN_INTERVAL_MS = 1_500 // KV 同 key 写限 1 次/秒，留余量

// ── 模块级缓存（同 isolate 跨请求复用，冷启动时为空）──
const ENDPOINTS_CACHE_TTL_MS = 60_000 // 端点列表 60s 缓存
const EXHAUSTED_CACHE_TTL_MS = 10_000 // 耗尽状态 10s 缓存
const KV_CACHE_TTL_ENDPOINTS = 60 // KV.get cacheTtl（秒），跨 isolate 共享
const KV_CACHE_TTL_EXHAUSTED = 30 // 最小合法值 30s；耗尽状态的准确性由内存 10s 缓存保证

let endpointsCache: { data: Endpoint[] | null; ts: number } = { data: null, ts: 0 }
let exhaustedCache: { data: ExhaustedMap; ts: number } = { data: {}, ts: 0 }

// 单飞锁：同 isolate 并发冷启动时共享同一份 KV 读 Promise，避免击穿
let endpointsInFlight: Promise<Endpoint[] | null> | null = null
let exhaustedInFlight: Promise<ExhaustedMap> | null = null

const healthMap = new Map<string, HealthEntry>()

// Sticky 会话路由：{ [sessionId]: endpointName }，仅模块级内存，同 isolate 内生效
const stickyMap = new Map<string, { name: string; ts: number }>()

// KV 写合并：pending 累积本 isolate 内所有待落盘的耗尽标记，
// 定时器合并为一次 KV 写（同 key 限 1 次/秒，且避免多请求互相覆盖）
const pendingExhausted = new Map<string, number>()
let exhaustedFlushTimer: ReturnType<typeof setTimeout> | null = null

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

function recordSuccess(name: string): void {
  const h = healthMap.get(name) ?? { lastSuccess: 0, consecutiveFails: 0, cooldownUntil: 0 }
  h.lastSuccess = Date.now()
  h.consecutiveFails = 0
  h.cooldownUntil = 0
  healthMap.set(name, h)
}

function recordFailure(name: string): void {
  const h = healthMap.get(name) ?? { lastSuccess: 0, consecutiveFails: 0, cooldownUntil: 0 }
  h.consecutiveFails++
  h.cooldownUntil = Date.now() + Math.min(COOLDOWN_MS * Math.pow(2, Math.min(h.consecutiveFails, 4)), 8 * 60_000)
  healthMap.set(name, h)
}

/** 带缓存的端点列表读取：60s 内复用内存，过期才读 KV（单飞去重 + cacheTtl） */
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

/** 带缓存的耗尽状态读取：10s 内复用内存，过期才读 KV。返回浅拷贝防止污染缓存 */
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

/** 标记耗尽：写入模块级 pending，合并 + 节流落盘 */
function markExhausted(map: ExhaustedMap, name: string, ttl: number): void {
  const expiry = Math.floor(Date.now() / 1000) + ttl
  map[name] = expiry
  pendingExhausted.set(name, expiry)
  exhaustedCache = { data: { ...map }, ts: Date.now() }
}

/** 合并写入：所有待落盘的标记合并后，节流（≥1.5s 一次）写 KV。返回 Promise 供 waitUntil */
async function writeExhausted(kv: KVNamespace, map: ExhaustedMap): Promise<void> {
  // 合并 pending 到最新 map
  for (const [name, expiry] of pendingExhausted) {
    if (map[name] === undefined || map[name] < expiry) map[name] = expiry
  }
  // 节流：距上次写入不足 1.5s 则等待到时间窗再写
  const nowMs = Date.now()
  const wait = EXHAUSTED_FLUSH_MIN_INTERVAL_MS - (nowMs - lastExhaustedFlushTs)
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait))
  }
  const values = Object.values(map)
  if (values.length === 0) return
  lastExhaustedFlushTs = Date.now()
  const now = Math.floor(Date.now() / 1000)
  const maxExpiry = Math.max(...values, now + 60)
  const ttl = Math.max(60, maxExpiry - now)
  await kv.put(KV_KEY_EXHAUSTED, JSON.stringify(map), { expirationTtl: ttl })
  // 落盘成功后清掉已写入的 pending（期间新标记会再次触发下一次写入）
  for (const [name, expiry] of pendingExhausted) {
    if (map[name] !== undefined && map[name] >= expiry) pendingExhausted.delete(name)
  }
}

let lastExhaustedFlushTs = 0

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * 健康度分级路由：
 *   fresh   — 近期成功（10min 内）或从未尝试过 → 最优先（内部按最近成功加权）
 *   stale   — 成功过但较久远 → 其次
 *   cooling — 非 429 失败后的冷却中 → 最后（仍尝试，作为兜底）
 * 已耗尽端点默认跳过；TTL 过半后以低概率放行一次做恢复探测。
 */
function rankCandidates(endpoints: Endpoint[], exhausted: ExhaustedMap, now: number): Endpoint[] {
  const fresh: Endpoint[] = []
  const stale: Endpoint[] = []
  const cooling: Endpoint[] = []
  const probes: Endpoint[] = []
  for (const ep of endpoints) {
    if (ep.name in exhausted) {
      // 剩余时间不足半默认 TTL 时，小概率放行探测：恢复则立即复用，未恢复则再标记（无感）
      const remaining = exhausted[ep.name] - Math.floor(now / 1000)
      if (remaining < DEFAULT_EXHAUST_TTL * PROBE_THRESHOLD_RATIO && Math.random() < PROBE_PROBABILITY) {
        probes.push(ep)
      }
      continue
    }
    const h = healthMap.get(ep.name)
    if (!h) {
      fresh.push(ep)
      continue
    }
    if (h.cooldownUntil > now) {
      cooling.push(ep)
    } else if (h.lastSuccess >= now - FRESH_WINDOW_MS || h.lastSuccess === 0) {
      fresh.push(ep)
    } else {
      stale.push(ep)
    }
  }
  // fresh 池按最近成功时间加权：越新权重越高，均衡负载的同时偏向稳定端点
  const weighted = weightedShuffle(fresh, now)
  return [...weighted, ...shuffle(stale), ...shuffle(cooling), ...shuffle(probes)]
}

/**
 * 加权洗牌：权重 = 1 + 距离最近成功的归一化奖励（0~1）。
 * 近 10min 内刚成功的端点权重上限 2，从未尝试/很久以前则权重 1。
 */
function weightedShuffle(fresh: Endpoint[], now: number): Endpoint[] {
  const withWeight = fresh.map((ep) => {
    const h = healthMap.get(ep.name)
    let w = 1
    if (h && h.lastSuccess > 0) {
      const recency = 1 - Math.min((now - h.lastSuccess) / FRESH_WINDOW_MS, 1)
      w = 1 + recency
    }
    return { ep, w }
  })
  const total = withWeight.reduce((s, x) => s + x.w, 0)
  const result: Endpoint[] = []
  const pool = [...withWeight]
  while (pool.length > 0) {
    let r = Math.random() * total
    let idx = 0
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].w
      if (r <= 0) {
        idx = i
        break
      }
    }
    result.push(pool[idx].ep)
    pool.splice(idx, 1)
  }
  return result
}

/** 从请求头提取会话 id：opencode 系用 x-opencode-session，其他用 x-session-affinity / x-session-id */
function getSessionId(request: Request): string | null {
  return (
    request.headers.get("x-opencode-session") ||
    request.headers.get("x-session-affinity") ||
    request.headers.get("x-session-id") ||
    null
  )
}

/** 会话固定端点：过期或不存在返回 null */
function getSticky(name: string, sessionId: string): boolean {
  const s = stickyMap.get(sessionId)
  if (!s) return false
  if (Date.now() - s.ts > STICKY_TTL_MS) {
    stickyMap.delete(sessionId)
    return false
  }
  return s.name === name
}

function setSticky(sessionId: string, name: string): void {
  if (stickyMap.size >= STICKY_MAX_ENTRIES) {
    // 内存保护：淘汰最旧的一半
    const entries = [...stickyMap.entries()].sort((a, b) => a[1].ts - b[1].ts)
    for (let i = 0; i < entries.length / 2; i++) stickyMap.delete(entries[i][0])
  }
  stickyMap.set(sessionId, { name, ts: Date.now() })
}

function clearSticky(sessionId: string): void {
  stickyMap.delete(sessionId)
}

function noEndpointsError(): Response {
  return new Response(JSON.stringify({ error: "No endpoints configured. Use: oc add <name> <url>" }), {
    status: 503,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  })
}

/** opencode 客户端默认 small_model=gpt-5-nano 走 /responses，free 端点不支持 → 404 引导 */
function unsupportedPathError(path: string): Response {
  return new Response(
    JSON.stringify({
      error: `Unsupported path: ${path}. This worker proxies the chat/completions (OpenAI-compatible) API for opencode free models. Set small_model to a free chat model (e.g. deepseek-v4-flash-free) in opencode config.`,
    }),
    { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  )
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
          version: "1.8.0",
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

    // opencode 客户端默认 small_model=gpt-5-nano 会打 /responses，free 端点不支持，
    // 直接 404 引导（客户端对 404 不重试，用户即时可见）
    if (url.pathname === "/zen/v1/responses" || url.pathname === "/zen/v1/messages") {
      return unsupportedPathError(url.pathname)
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

    // 请求体只读一次，重试时复用（此处分支已保证 method 仅为 GET / POST）
    const body = request.method === "GET" ? undefined : await request.arrayBuffer()

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

    // ── 核心路由：健康分级 → 会话固定 → 跳过已耗尽 → 依次尝试 → 429 内部吸收 ──
    const sessionId = getSessionId(request)
    let candidates = rankCandidates(endpoints, exhausted, Date.now())
    // Sticky：同一会话优先打上次成功的端点，避免多端点间上下文/额度碎片化
    if (sessionId) {
      const stickyIdx = candidates.findIndex((ep) => getSticky(ep.name, sessionId))
      if (stickyIdx > 0) {
        const [sticky] = candidates.splice(stickyIdx, 1)
        candidates = [sticky, ...candidates]
      }
    }
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
      // 客户端断开时中止上游，节省 subrequest 配额
      const onClientAbort = () => controller.abort()
      request.signal.addEventListener("abort", onClientAbort, { once: true })
      const timer = setTimeout(() => controller.abort(), FIRST_BYTE_TIMEOUT_MS)
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
            markExhausted(exhausted, ep.name, ttl)
            if (sessionId) clearSticky(sessionId) // 固定端点耗尽，解除绑定
            newlyExhausted++
            last429Body = text
            last429Ttl = ttl
            continue
          }
          // 非免费额度限流的 429，直接透传
          if (newlyExhausted > 0) ctx.waitUntil(writeExhausted(env.ENDPOINT_STATE, exhausted))
          return new Response(text, {
            status: 429,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "application/json",
              "X-Proxy-Endpoint": ep.name,
              "Retry-After": String(last429Ttl),
              "retry-after-ms": String(last429Ttl * 1000),
            },
          })
        }

        // 成功：KV 落盘交给 waitUntil 异步，然后立即流式透传
        if (newlyExhausted > 0) ctx.waitUntil(writeExhausted(env.ENDPOINT_STATE, exhausted))
        recordSuccess(ep.name)
        if (sessionId) setSticky(sessionId, ep.name)
        // 若是探测放行且成功了：本地解封 + 异步写 KV，后续请求立即复用该端点
        if (ep.name in exhausted) {
          delete exhausted[ep.name]
          exhaustedCache = { data: { ...exhausted }, ts: Date.now() }
          ctx.waitUntil(writeExhausted(env.ENDPOINT_STATE, exhausted))
        }
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
        // 网络错误 / 超时 — 冷却该端点，不标记耗尽，继续试下一个
        recordFailure(ep.name)
        continue
      } finally {
        clearTimeout(timer)
        request.signal.removeEventListener("abort", onClientAbort)
      }
    }

    // ── 全部端点耗尽或不可用 ──
    if (newlyExhausted > 0) ctx.waitUntil(writeExhausted(env.ENDPOINT_STATE, exhausted))

    if (last429Body) {
      return new Response(last429Body, {
        status: 429,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json",
          "Retry-After": String(last429Ttl),
          "retry-after-ms": String(last429Ttl * 1000),
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
