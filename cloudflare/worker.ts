// oc-router v3.0.0 — Cloudflare Worker 网关
//
// 深度审计后全面重构:
// 1. Queue 批量写 D1: 每请求 → Queue 消息, 批量 consumer 聚合写 (省 99% D1 写入)
// 2. Cache API 缓存 models: 替代 KV, 不消耗 KV 配额, 支持流式传输
// 3. 端点信誉系统: 滑动窗口 + 并发控制, 智能选端点
// 4. UA 池扩展到 1000+ 组合, 防指纹
// 5. Cron 每分钟健康检查 + 数据清理
//
// CF 免费计划功能深度利用:
// ┌─────────────┬──────────────────────────────────┬────────────────────┐
// │ 功能        │ 用途                             │ 免费额度           │
// ├─────────────┼──────────────────────────────────┼────────────────────┤
// │ Workers     │ 路由/信誉/UA随机化               │ 10万请求/天        │
// │ KV          │ 端点列表 + 枯竭状态 (仅关键数据) │ 1000读+100写/天    │
// │ D1          │ 请求日志/历史统计/限流分析       │ 5M行+10万读+1000写 │
// │ Queue       │ 日志批量聚合 → D1                │ 100万操作/月       │
// │ Cache API   │ /zen/v1/models 响应缓存          │ 无显式限制         │
// │ Cron        │ 每分钟健康检查 + 清理过期数据    │ 包含在 Workers     │
// └─────────────┴──────────────────────────────────┴────────────────────┘

interface Env {
  ENDPOINT_STATE: KVNamespace
  oc_router_logs: D1Database
  LOG_QUEUE: Queue<LogEntry>
  AUTH_TOKEN?: string
}

interface Endpoint {
  name: string
  url: string
  v6?: boolean
}

interface LogEntry {
  ts: number
  req_id: string
  path: string
  endpoint: string
  status: number
  retries: number
  duration_ms: number
  error_type: string
  error_msg: string
}

type ExhaustedMap = Record<string, number>

interface EndpointReputation {
  success: number
  failure: number
  last_429_ts: number
  last_5xx_ts: number
  consecutive_failures: number
  active_requests: number
}

const VERSION = "3.0.0"
const KV_KEY_ENDPOINTS = "endpoints"
const KV_KEY_EXHAUSTED = "exhausted"

// 性能参数
const FIRST_BYTE_TIMEOUT_MS = 90_000
const MIN_QUOTA_EXHAUST_SECONDS = 10 * 3600
const MIN_RETRY_AFTER = 30
const MAX_ATTEMPTS = 6
const SHORT_LIMIT_TTL_SECONDS = 300
const V6_PROBE_TTL_MS = 30 * 60_000
const V6_PROBE_TIMEOUT_MS = 5_000
const ENDPOINTS_CACHE_TTL_MS = 60_000
const EXHAUSTED_CACHE_TTL_MS = 15_000
const FAIL_COOLDOWN_MS = 60_000
const OFFICIAL_UPSTREAM = "https://opencode.ai"
const MAX_CONCURRENT_PER_ENDPOINT = 3

// 信誉系统
const REPUTATION_MIN_SAMPLES = 3
const CONSECUTIVE_FAIL_THRESHOLD = 3

// 内存状态
let endpointsCache: { data: Endpoint[] | null; ts: number } = { data: null, ts: 0 }
let exhaustedCache: { data: ExhaustedMap; ts: number } = { data: {}, ts: 0 }
let endpointsInFlight: Promise<Endpoint[] | null> | null = null
let exhaustedInFlight: Promise<ExhaustedMap> | null = null
const pendingExhausted = new Map<string, number>()
const failCooldown = new Map<string, number>()
const reputation = new Map<string, EndpointReputation>()
const v6CapableCache = new Map<string, { ok: boolean; ts: number }>()
let v6ProbeInFlight: Promise<void> | null = null

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
}

// ── 工具函数 ────────────────────────────────────────────────────────────────

function classify429(body: string): "quota" | "short" {
  if (body.includes("GoUsageLimitError")) return "quota"
  if (body.includes("FreeUsageLimitError")) {
    return body.includes("Free usage limit reached") ? "quota" : "short"
  }
  return "short"
}

function bodyResetSeconds(body: string): number | null {
  try {
    const data = JSON.parse(body) as { metadata?: { resetAt?: unknown } }
    if (data.metadata && typeof data.metadata.resetAt === "number") return data.metadata.resetAt
  } catch { /* ignore */ }
  return null
}

function exhaustSeconds(): number {
  const now = new Date()
  const reset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return Math.max(MIN_QUOTA_EXHAUST_SECONDS, Math.floor((reset - now.getTime()) / 1000))
}

function limitTtl(res: Response, body: string): { kind: "quota" | "short"; ttl: number } {
  const kind = classify429(body)
  const resetAt = bodyResetSeconds(body)
  const headerRaw = res.headers.get("retry-after")
  const headerSeconds = headerRaw ? parseInt(headerRaw, 10) : NaN
  const precise = resetAt ?? (Number.isFinite(headerSeconds) ? headerSeconds : null)
  const bounded = (v: number, max: number) => Math.min(Math.max(v, MIN_RETRY_AFTER), max)

  if (kind === "quota") {
    const ttl = precise !== null && Number.isFinite(precise) && precise >= MIN_RETRY_AFTER
      ? bounded(precise, 31_536_000) : exhaustSeconds()
    return { kind, ttl }
  }
  const ttl = precise !== null && Number.isFinite(precise) && precise >= MIN_RETRY_AFTER
    ? bounded(precise, 3600) : SHORT_LIMIT_TTL_SECONDS
  return { kind, ttl }
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function randomHex(len: number): string {
  let s = ""
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 256).toString(16).padStart(2, "0")
  return s
}

function generateRequestId(): string {
  return Date.now().toString(36) + randomHex(8)
}

// ── UA 匿名化 (1000+ 组合) ─────────────────────────────────────────────────

const UA_CLI_VERSIONS = ["0.0.50", "0.0.51", "0.0.52", "0.0.53", "0.0.54", "0.0.55", "0.0.56", "0.0.57"]
const UA_SDK_VERSIONS = ["4.0.22", "4.0.23", "4.0.24", "4.0.25", "4.0.26", "4.0.27"]
const UA_APP_VERSIONS = ["1.18.15", "1.18.16", "1.18.17", "1.18.18", "1.18.19", "1.19.0", "1.19.1", "1.19.2", "1.20.0"]
const UA_BUN_VERSIONS = ["1.2.10", "1.3.14", "1.3.21", "1.4.0", "1.4.4", "1.4.5", "1.5.0"]
const UA_NODE_VERSIONS = ["20.11.0", "20.12.0", "21.6.0", "21.7.0", "22.0.0"]

function randomAnonymousUA(): string {
  const style = Math.floor(Math.random() * 5)
  if (style === 0) return `opencode/latest/${randomPick(UA_CLI_VERSIONS)}/cli`
  if (style === 1) return `opencode/${randomPick(UA_APP_VERSIONS)}`
  if (style === 2) return `opencode/${randomPick(UA_APP_VERSIONS)} ai-sdk/provider-utils/${randomPick(UA_SDK_VERSIONS)} runtime/bun/${randomPick(UA_BUN_VERSIONS)}`
  if (style === 3) return `opencode/${randomPick(UA_APP_VERSIONS)} ai-sdk/provider-utils/${randomPick(UA_SDK_VERSIONS)} runtime/node/${randomPick(UA_NODE_VERSIONS)}`
  // 完整伪装: 含 x-random-id 的变体
  return `opencode/${randomPick(UA_APP_VERSIONS)} (${randomHex(4)}) ai-sdk/${randomPick(UA_SDK_VERSIONS)} runtime/bun/${randomPick(UA_BUN_VERSIONS)}`
}

// ── 请求头处理 ──────────────────────────────────────────────────────────────

const RATE_LIMIT_KEY_HEADERS = new Set([
  "x-opencode-project", "x-opencode-session", "x-opencode-request",
  "x-opencode-client", "x-session-id", "x-session-affinity",
])

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade",
  "proxy-connection", "host", "content-length", "accept-encoding",
  "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor",
  "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "via", "forwarded",
])

const PLACEHOLDER_AUTH = /^(Bearer\s+)?(dummy|placeholder|sk-dummy|test|x|empty|public)$/i

function makeForwardHeaders(request: Request): Headers {
  const headers = new Headers()
  for (const [key, value] of request.headers) {
    const lower = key.toLowerCase()
    if (!HOP_BY_HOP_HEADERS.has(lower) && !RATE_LIMIT_KEY_HEADERS.has(lower)) {
      headers.set(key, value)
    }
  }
  return headers
}

function anonymizeClientHeaders(headers: Headers): Headers {
  headers.set("user-agent", randomAnonymousUA())
  headers.set("x-random-id", randomHex(8))
  return headers
}

// 认证策略: 剥离所有 auth, 让每个端点 IP 独立限流
function stripAllAuth(headers: Headers): Headers {
  headers.delete("authorization")
  return headers
}

function stripClientAuth(headers: Headers): Headers {
  const auth = headers.get("authorization")
  if (!auth) return headers
  const token = auth.replace(/^Bearer\s+/i, "").trim()
  if (token === "" || PLACEHOLDER_AUTH.test(token)) headers.delete("authorization")
  return headers
}

function stripProxyToken(headers: Headers, isProxyToken: boolean): Headers {
  if (isProxyToken) headers.delete("authorization")
  return headers
}

function checkAuth(request: Request, token: string | undefined): { ok: boolean; isProxyToken: boolean } {
  if (!token) return { ok: true, isProxyToken: false }
  const provided = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  return { ok: provided === token, isProxyToken: provided === token }
}

// ── 端点信誉系统 ────────────────────────────────────────────────────────────

function getReputation(name: string): EndpointReputation {
  let rep = reputation.get(name)
  if (!rep) {
    rep = { success: 0, failure: 0, last_429_ts: 0, last_5xx_ts: 0, consecutive_failures: 0, active_requests: 0 }
    reputation.set(name, rep)
  }
  return rep
}

function recordSuccess(name: string): void {
  const rep = getReputation(name)
  rep.success++
  rep.consecutive_failures = 0
  if (rep.success + rep.failure > 40) {
    rep.success = Math.round(rep.success * 0.7)
    rep.failure = Math.round(rep.failure * 0.7)
  }
}

function record429(name: string): void {
  const rep = getReputation(name)
  rep.failure++
  rep.last_429_ts = Date.now()
  rep.consecutive_failures++
  if (rep.success + rep.failure > 40) {
    rep.success = Math.round(rep.success * 0.7)
    rep.failure = Math.round(rep.failure * 0.7)
  }
}

function record5xx(name: string): void {
  const rep = getReputation(name)
  rep.failure++
  rep.last_5xx_ts = Date.now()
  rep.consecutive_failures++
}

function recordNetError(name: string): void {
  const rep = getReputation(name)
  rep.failure++
  rep.consecutive_failures++
}

// 基于信誉选端点: 成功率高的优先, 连续失败多的降权
function selectByReputation(endpoints: Endpoint[]): Endpoint[] {
  const scored = endpoints.map(ep => {
    const rep = getReputation(ep.name)
    const total = rep.success + rep.failure
    let score = 1.0
    if (total >= REPUTATION_MIN_SAMPLES) {
      score = rep.success / total
    }
    if (rep.consecutive_failures >= CONSECUTIVE_FAIL_THRESHOLD) score *= 0.3
    if (rep.last_429_ts > 0 && Date.now() - rep.last_429_ts < 600_000) score *= 0.5
    // 并发惩罚: 已有 MAX_CONCURRENT_PER_ENDPOINT 个请求在飞的端点降权
    if (rep.active_requests >= MAX_CONCURRENT_PER_ENDPOINT) score *= 0.1
    return { ep, score }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.map(s => s.ep)
}

// ── IPv6 探测 ───────────────────────────────────────────────────────────────

async function probeV6(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), V6_PROBE_TIMEOUT_MS)
    try {
      const res = await fetch(url + "/diagnose", { headers: { "User-Agent": "oc-router-v6probe/1.0" }, signal: ctrl.signal })
      if (!res.ok) return false
      const data = await res.json() as { ipv6?: string | null }
      return typeof data.ipv6 === "string" && data.ipv6.length > 0
    } finally { clearTimeout(timer) }
  } catch { return false }
}

async function refreshV6Capabilities(endpoints: Endpoint[]): Promise<void> {
  if (v6ProbeInFlight) return v6ProbeInFlight
  const now = Date.now()
  const stale = endpoints.filter(ep => ep.v6 === undefined && (!v6CapableCache.has(ep.name) || now - v6CapableCache.get(ep.name)!.ts > V6_PROBE_TTL_MS))
  if (stale.length === 0) return
  v6ProbeInFlight = (async () => {
    const results = await Promise.all(stale.map(async ep => ({ name: ep.name, ok: await probeV6(ep.url) })))
    for (const r of results) v6CapableCache.set(r.name, { ok: r.ok, ts: Date.now() })
  })().finally(() => { v6ProbeInFlight = null })
  return v6ProbeInFlight
}

function endpointV6(ep: Endpoint): boolean | null {
  if (typeof ep.v6 === "boolean") return ep.v6
  const cached = v6CapableCache.get(ep.name)
  return cached ? cached.ok : null
}

async function shuffleV6First(endpoints: Endpoint[], maxWaitMs = 2_000): Promise<Endpoint[]> {
  const probePromise = refreshV6Capabilities(endpoints)
  await Promise.race([probePromise, new Promise(r => setTimeout(r, maxWaitMs))])
  const byRep = selectByReputation(endpoints)
  const v6 = byRep.filter(ep => endpointV6(ep) === true)
  const v4 = byRep.filter(ep => endpointV6(ep) !== true)
  return [...v6, ...v4]
}

// ── KV 读写 (最小化: 仅端点列表 + 枯竭状态) ────────────────────────────────

async function getEndpoints(kv: KVNamespace): Promise<Endpoint[] | null> {
  const now = Date.now()
  if (endpointsCache.data !== null && now - endpointsCache.ts < ENDPOINTS_CACHE_TTL_MS) return endpointsCache.data
  if (!endpointsInFlight) {
    endpointsInFlight = (async () => {
      try {
        const raw = await kv.get(KV_KEY_ENDPOINTS, { cacheTtl: 60 })
        if (!raw) { endpointsCache = { data: null, ts: Date.now() }; return null }
        const endpoints = JSON.parse(raw) as Endpoint[]
        if (!Array.isArray(endpoints) || endpoints.length === 0) { endpointsCache = { data: null, ts: Date.now() }; return null }
        endpointsCache = { data: endpoints, ts: Date.now() }
        return endpoints
      } catch { endpointsCache = { data: null, ts: Date.now() }; return null }
      finally { endpointsInFlight = null }
    })()
  }
  return endpointsInFlight
}

async function getExhausted(kv: KVNamespace): Promise<ExhaustedMap> {
  const now = Date.now()
  if (now - exhaustedCache.ts < EXHAUSTED_CACHE_TTL_MS) return { ...exhaustedCache.data }
  if (!exhaustedInFlight) {
    exhaustedInFlight = (async () => {
      try {
        const raw = await kv.get(KV_KEY_EXHAUSTED, { cacheTtl: 30 })
        if (!raw) { exhaustedCache = { data: {}, ts: Date.now() }; return {} }
        const map = JSON.parse(raw) as ExhaustedMap
        const nowSec = Math.floor(Date.now() / 1000)
        for (const key of Object.keys(map)) if (map[key] <= nowSec) delete map[key]
        exhaustedCache = { data: map, ts: Date.now() }
        return { ...map }
      } catch { exhaustedCache = { data: {}, ts: Date.now() }; return {} }
      finally { exhaustedInFlight = null }
    })()
  }
  return exhaustedInFlight
}

function markExhausted(map: ExhaustedMap, name: string, ttl: number): void {
  const expiry = Math.floor(Date.now() / 1000) + ttl
  map[name] = expiry
  pendingExhausted.set(name, expiry)
  exhaustedCache.data[name] = expiry
}

async function writeExhausted(kv: KVNamespace, map: ExhaustedMap, removed: string[] = []): Promise<void> {
  for (const name of removed) if (name in map) delete map[name]
  for (const [name, expiry] of pendingExhausted) {
    if (map[name] === undefined || map[name] < expiry) map[name] = expiry
  }
  pendingExhausted.clear()
  const values = Object.values(map)
  if (values.length === 0) return
  let merged = map
  try {
    const raw = await kv.get(KV_KEY_EXHAUSTED, { cacheTtl: 0 })
    if (raw) {
      const latest = JSON.parse(raw) as ExhaustedMap
      merged = { ...latest }
      for (const [name, expiry] of Object.entries(map)) merged[name] = Math.max(expiry, latest[name] ?? 0)
    }
  } catch { /* ignore */ }
  const now = Math.floor(Date.now() / 1000)
  const maxExpiry = Math.max(...Object.values(merged), now + 60)
  await kv.put(KV_KEY_EXHAUSTED, JSON.stringify(merged), { expirationTtl: Math.max(60, maxExpiry - now) })
}

// ── Queue 日志 (批量写 D1) ──────────────────────────────────────────────────
// 每请求 → Queue.send() (1 Queue 操作, 免费 100万/月)
// Queue consumer 每 30s 或 50 条触发一次, 批量 INSERT 到 D1 (1 D1 写 = 50 行)
// 效果: 1000 请求/天 → ~20-30 次 D1 写入 (vs 之前 1000 次)

function enqueueLog(ctx: ExecutionContext, queue: Queue<LogEntry>, entry: LogEntry): void {
  ctx.waitUntil(
    queue.send(entry).catch(err => {
      console.log(JSON.stringify({ ev: "queue_send_error", ts: Date.now(), error: String(err) }))
    })
  )
}

// ── Cache API (models 缓存) ─────────────────────────────────────────────────
// 替代 KV 缓存: 不消耗 KV 配额, 支持流式传输, CF 边缘节点缓存

const MODELS_CACHE_KEY = "oc-router:models:v1"
const MODELS_CACHE_TTL = 300 // 5 分钟

async function getModelsFromCache(): Promise<string | null> {
  try {
    const cache = caches.default
    const cached = await cache.match(new Request("https://cache.internal/" + MODELS_CACHE_KEY))
    if (cached) {
      const text = await cached.text()
      return text
    }
  } catch { /* ignore */ }
  return null
}

async function setModelsCache(data: string): Promise<void> {
  try {
    const cache = caches.default
    const response = new Response(data, {
      headers: { "Cache-Control": `max-age=${MODELS_CACHE_TTL}`, "Content-Type": "application/json" }
    })
    await cache.put(new Request("https://cache.internal/" + MODELS_CACHE_KEY), response)
  } catch { /* ignore */ }
}

// ── 路径拼接 ────────────────────────────────────────────────────────────────

function buildTarget(epUrl: string, pathname: string, search: string): string {
  const epUrlObj = new URL(epUrl)
  const epBasePath = epUrlObj.pathname.replace(/\/$/, "")
  if (!epBasePath) return epUrl + pathname + search
  let apiPath = pathname
  if (apiPath.startsWith(epBasePath)) apiPath = apiPath.slice(epBasePath.length) || "/"
  return epUrl.replace(/\/$/, "") + apiPath + search
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startTime = Date.now()
    const url = new URL(request.url)
    const reqId = generateRequestId()

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS })

    // /health: 端点状态概览
    if (url.pathname === "/health") {
      const [endpoints, exhausted] = await Promise.all([getEndpoints(env.ENDPOINT_STATE), getExhausted(env.ENDPOINT_STATE)])
      const statuses = (endpoints ?? []).map(ep => {
        const rep = getReputation(ep.name)
        const total = rep.success + rep.failure
        return {
          name: ep.name,
          exhausted: ep.name in exhausted,
          v6: endpointV6(ep),
          success_rate: total > 0 ? Math.round((rep.success / total) * 100) : null,
          active: rep.active_requests,
        }
      })
      return new Response(JSON.stringify({
        status: "ok", version: VERSION, platform: "cloudflare-router",
        available: `${statuses.filter(s => !s.exhausted).length}/${statuses.length}`, endpoints: statuses,
      }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } })
    }

    // /debug: 详细诊断
    if (url.pathname === "/debug") {
      const [endpoints, exhausted] = await Promise.all([getEndpoints(env.ENDPOINT_STATE), getExhausted(env.ENDPOINT_STATE)])
      const now = Date.now()

      let recentStats: { endpoint: string; total: number; success: number; avg_duration: number }[] = []
      try {
        const result = await env.oc_router_logs.prepare(
          "SELECT endpoint, COUNT(*) as total, SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) as success, ROUND(AVG(duration_ms), 0) as avg_duration FROM request_log WHERE ts > ? GROUP BY endpoint ORDER BY total DESC"
        ).bind(now - 3600_000).all()
        recentStats = result.results as any[]
      } catch { /* ignore */ }

      const details = (endpoints ?? []).map(ep => {
        const rep = getReputation(ep.name)
        const expiry = exhausted[ep.name]
        const cooldownUntil = failCooldown.get(ep.name)
        const total = rep.success + rep.failure
        const stats = recentStats.find(s => s.endpoint === ep.name)
        return {
          name: ep.name, url: ep.url, v6: endpointV6(ep),
          exhausted: expiry !== undefined && expiry * 1000 > now,
          exhausted_until: expiry ? new Date(expiry * 1000).toISOString() : null,
          cooldown_until: cooldownUntil ? new Date(cooldownUntil).toISOString() : null,
          reputation: {
            success: rep.success, failure: rep.failure,
            success_rate: total > 0 ? ((rep.success / total) * 100).toFixed(1) + "%" : "N/A",
            consecutive_failures: rep.consecutive_failures,
            active_requests: rep.active_requests,
            last_429: rep.last_429_ts > 0 ? new Date(rep.last_429_ts).toISOString() : null,
            last_5xx: rep.last_5xx_ts > 0 ? new Date(rep.last_5xx_ts).toISOString() : null,
          },
          last_hour: stats ? { total: stats.total, success: stats.success, avg_duration_ms: stats.avg_duration } : null,
        }
      })

      return new Response(JSON.stringify({ version: VERSION, endpoints: details }, null, 2),
        { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } })
    }

    // /stats: D1 历史统计
    if (url.pathname === "/stats") {
      const now = Date.now()
      try {
        const [h1, h24, byStatus, byEndpoint] = await Promise.all([
          env.oc_router_logs.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) as success, AVG(duration_ms) as avg_ms FROM request_log WHERE ts > ?").bind(now - 3600_000).first(),
          env.oc_router_logs.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) as success, AVG(duration_ms) as avg_ms FROM request_log WHERE ts > ?").bind(now - 86400_000).first(),
          env.oc_router_logs.prepare("SELECT status, COUNT(*) as count FROM request_log WHERE ts > ? GROUP BY status ORDER BY count DESC LIMIT 10").bind(now - 86400_000).all(),
          env.oc_router_logs.prepare("SELECT endpoint, COUNT(*) as total, SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) as success, SUM(CASE WHEN status = 429 THEN 1 ELSE 0 END) as rate_limited FROM request_log WHERE ts > ? GROUP BY endpoint ORDER BY total DESC").bind(now - 86400_000).all(),
        ])
        return new Response(JSON.stringify({ version: VERSION, last_hour: h1, last_24h: h24, by_status: byStatus.results, by_endpoint: byEndpoint.results }, null, 2),
          { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } })
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } })
      }
    }

    // 路径校验
    if (!url.pathname.startsWith("/zen/v1/")) {
      return new Response(JSON.stringify({ error: `Unsupported path: ${url.pathname}` }),
        { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } })
    }

    if (request.method !== "POST" && request.method !== "GET") {
      return new Response(JSON.stringify({ error: "Only GET and POST allowed" }),
        { status: 405, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } })
    }

    const auth = checkAuth(request, env.AUTH_TOKEN)
    if (!auth.ok) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } })

    // 非 chat/completions: 直连官方 + Cache API 缓存 models
    if (url.pathname !== "/zen/v1/chat/completions") {
      // /zen/v1/models: Cache API 缓存 (不消耗 KV 配额)
      if (url.pathname === "/zen/v1/models" && request.method === "GET") {
        const cached = await getModelsFromCache()
        if (cached) {
          enqueueLog(ctx, env.LOG_QUEUE, { ts: startTime, req_id: reqId, path: url.pathname, endpoint: "cache", status: 200, retries: 0, duration_ms: Date.now() - startTime, error_type: "", error_msg: "" })
          return new Response(cached, {
            headers: { ...CORS_HEADERS, "Content-Type": "application/json", "X-Proxy-Source": "cache", "X-Request-Id": reqId }
          })
        }
      }

      const upstreamTarget = OFFICIAL_UPSTREAM + url.pathname + url.search
      const body = request.method === "GET" ? undefined : await request.arrayBuffer()
      try {
        const fwdHeaders = anonymizeClientHeaders(stripClientAuth(stripProxyToken(makeForwardHeaders(request), auth.isProxyToken)))
        const res = await fetch(upstreamTarget, { method: request.method, headers: fwdHeaders, body })
        const resBody = await res.text()

        // 缓存 models 响应 (Cache API)
        if (res.ok && url.pathname === "/zen/v1/models" && request.method === "GET") {
          ctx.waitUntil(setModelsCache(resBody))
        }

        enqueueLog(ctx, env.LOG_QUEUE, { ts: startTime, req_id: reqId, path: url.pathname, endpoint: "official", status: res.status, retries: 0, duration_ms: Date.now() - startTime, error_type: "", error_msg: "" })
        return new Response(resBody, {
          status: res.status, statusText: res.statusText,
          headers: { ...Object.fromEntries(res.headers), "X-Proxy-Source": "official", "X-Request-Id": reqId }
        })
      } catch (err) {
        enqueueLog(ctx, env.LOG_QUEUE, { ts: startTime, req_id: reqId, path: url.pathname, endpoint: "official", status: 502, retries: 0, duration_ms: Date.now() - startTime, error_type: "upstream_unreachable", error_msg: String(err).slice(0, 200) })
        return new Response(JSON.stringify({ error: "Official upstream unreachable." }),
          { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } })
      }
    }

    // chat/completions: 平台端点轮换
    const [endpoints, exhausted] = await Promise.all([getEndpoints(env.ENDPOINT_STATE), getExhausted(env.ENDPOINT_STATE)])
    if (!endpoints || endpoints.length === 0) {
      return new Response(JSON.stringify({ error: "No endpoints configured." }), { status: 503, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } })
    }

    const body = request.method === "GET" ? undefined : await request.arrayBuffer()
    const forwardHeaders = anonymizeClientHeaders(stripAllAuth(stripProxyToken(makeForwardHeaders(request), auth.isProxyToken)))
    const candidates = await shuffleV6First(endpoints)
    const now = Date.now()
    let skippedExhausted = 0, attempts = 0, newlyExhausted = 0
    let last429: { body: string; ttl: number } | null = null
    let lastEndpoint = "none"
    let lastStatus = 0
    let lastErrorType = ""
    let lastErrorMsg = ""

    for (const ep of candidates) {
      const expiry = exhausted[ep.name]
      if (expiry !== undefined && expiry * 1000 > now) { skippedExhausted++; continue }
      const cdUntil = failCooldown.get(ep.name)
      if (cdUntil !== undefined && cdUntil > now) { skippedExhausted++; continue }
      const rep = getReputation(ep.name)
      const remaining = candidates.length - skippedExhausted - 1
      if (rep.consecutive_failures >= CONSECUTIVE_FAIL_THRESHOLD && remaining > 1) { skippedExhausted++; continue }
      if (rep.active_requests >= MAX_CONCURRENT_PER_ENDPOINT && remaining > 1) { skippedExhausted++; continue }
      if (attempts >= MAX_ATTEMPTS) break
      attempts++

      rep.active_requests++
      const target = buildTarget(ep.url, url.pathname, url.search)
      const controller = new AbortController()
      const onClientAbort = () => controller.abort()
      request.signal.addEventListener("abort", onClientAbort, { once: true })
      const timer = setTimeout(() => controller.abort(), FIRST_BYTE_TIMEOUT_MS)

      try {
        const res = await fetch(target, { method: request.method, headers: forwardHeaders, body, signal: controller.signal })

        if (res.status === 429 || (res.status >= 500 && res.status <= 504)) {
          const reader = res.body!.getReader()
          const buf = new Uint8Array(2048)
          let got = 0
          while (got < 2048) {
            const { value, done } = await reader.read()
            if (done) break
            if (value) { const n = Math.min(value.length, 2048 - got); buf.set(value.subarray(0, n), got); got += n }
          }
          reader.cancel()
          const text = new TextDecoder().decode(buf.subarray(0, got))

          if (res.status >= 500) {
            failCooldown.set(ep.name, Date.now() + FAIL_COOLDOWN_MS)
            record5xx(ep.name)
            lastEndpoint = ep.name; lastStatus = res.status
            lastErrorType = "5xx"; lastErrorMsg = text.slice(0, 200)
            continue
          }

          const { kind, ttl } = limitTtl(res, text)
          record429(ep.name)
          lastEndpoint = ep.name; lastStatus = 429
          lastErrorType = kind; lastErrorMsg = text.slice(0, 200)

          if (kind === "quota") {
            markExhausted(exhausted, ep.name, ttl)
            newlyExhausted++
            ctx.waitUntil(writeExhausted(env.ENDPOINT_STATE, exhausted))
          } else {
            failCooldown.set(ep.name, Date.now() + ttl * 1000)
          }
          last429 = { body: text, ttl }
          continue
        }

        if (newlyExhausted > 0) ctx.waitUntil(writeExhausted(env.ENDPOINT_STATE, exhausted))
        if (ep.name in exhausted) ctx.waitUntil(writeExhausted(env.ENDPOINT_STATE, exhausted, [ep.name]))
        delete exhausted[ep.name]; delete exhaustedCache.data[ep.name]; failCooldown.delete(ep.name)
        recordSuccess(ep.name)

        const responseHeaders = new Headers(res.headers)
        responseHeaders.set("X-Proxy-Endpoint", ep.name)
        responseHeaders.set("X-Request-Id", reqId)
        if (attempts > 1) responseHeaders.set("X-Router-Retries", String(attempts - 1))

        const duration = Date.now() - startTime
        console.log(JSON.stringify({ ev: "proxy", ts: startTime, req_id: reqId, path: url.pathname, endpoint: ep.name, status: res.status, retries: attempts - 1, duration_ms: duration }))
        enqueueLog(ctx, env.LOG_QUEUE, { ts: startTime, req_id: reqId, path: url.pathname, endpoint: ep.name, status: res.status, retries: attempts - 1, duration_ms: duration, error_type: "", error_msg: "" })

        return new Response(res.body, { status: res.status, statusText: res.statusText, headers: responseHeaders })
      } catch (err) {
        if (!request.signal.aborted) {
          failCooldown.set(ep.name, Date.now() + FAIL_COOLDOWN_MS)
          recordNetError(ep.name)
          lastEndpoint = ep.name; lastStatus = 0
          lastErrorType = "net_error"; lastErrorMsg = String(err).slice(0, 200)
        }
        continue
      } finally {
        clearTimeout(timer)
        request.signal.removeEventListener("abort", onClientAbort)
        rep.active_requests--
      }
    }

    if (newlyExhausted > 0) ctx.waitUntil(writeExhausted(env.ENDPOINT_STATE, exhausted))

    const duration = Date.now() - startTime
    enqueueLog(ctx, env.LOG_QUEUE, { ts: startTime, req_id: reqId, path: url.pathname, endpoint: lastEndpoint, status: last429 ? 429 : 502, retries: attempts - 1, duration_ms: duration, error_type: lastErrorType, error_msg: lastErrorMsg })

    if (last429) {
      return new Response(last429.body, {
        status: 429,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Retry-After": String(last429.ttl),
          "retry-after-ms": String(last429.ttl * 1000), "X-Router-Status": "all-exhausted",
          "X-Router-Tried": String(attempts), "X-Router-Skipped": String(skippedExhausted), "X-Request-Id": reqId }
      })
    }

    return new Response(JSON.stringify({ error: "All endpoints unavailable.", tried: attempts, skipped: skippedExhausted, request_id: reqId }),
      { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } })
  },

  // Queue Consumer: 批量写 D1
  async queue(batch: MessageBatch<LogEntry>, env: Env): Promise<void> {
    const entries = batch.messages.map(m => m.body)
    if (entries.length === 0) return

    try {
      // 批量 INSERT: 1 次 D1 写 = N 行 (省 99% D1 写入)
      const stmt = env.oc_router_logs.prepare(
        "INSERT INTO request_log (ts, req_id, path, endpoint, status, retries, duration_ms, error_type, error_msg) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      const queries = entries.map(e =>
        stmt.bind(e.ts, e.req_id, e.path, e.endpoint, e.status, e.retries, e.duration_ms, e.error_type || null, e.error_msg || null)
      )
      await env.oc_router_logs.batch(queries)
    } catch (err) {
      console.log(JSON.stringify({ ev: "queue_error", ts: Date.now(), error: String(err), batch_size: entries.length }))
    }
  },

  // Cron: 每分钟健康检查 + 每小时清理
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const endpoints = await getEndpoints(env.ENDPOINT_STATE)
    if (!endpoints) return

    // 健康检查: 并发探测所有端点
    const results = await Promise.all(endpoints.map(async ep => {
      try {
        const res = await fetch(ep.url + "/health", { headers: { "User-Agent": "oc-router-healthcheck/1.0" } })
        return { name: ep.name, ok: res.ok, status: res.status }
      } catch { return { name: ep.name, ok: false, status: 0 } }
    }))
    console.log(JSON.stringify({ ev: "healthcheck", ts: Date.now(), results }))

    // 每小时清理 7 天前的日志 (分钟级 cron, 用分钟数判断)
    const now = new Date()
    if (now.getUTCMinutes() === 0) {
      try {
        const cutoff = Date.now() - 7 * 86400_000
        await env.oc_router_logs.prepare("DELETE FROM request_log WHERE ts < ?").bind(cutoff).run()
      } catch (err) {
        console.log(JSON.stringify({ ev: "cleanup_error", ts: Date.now(), error: String(err) }))
      }
    }
  },
}
