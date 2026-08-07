// opencode-proxy — 平台层统一转发核心（v2 单一真源）
//
// 职责：纯流量转发。所有智能决策（路由 / sticky / 健康分级 / 429 熔断 /
// SSE 字段补齐）都在 CF Worker（oc-router）层完成，平台层只是一个
// 无状态的 HTTP 转发节点，不持有业务逻辑、不伪装指纹。
//
// 本文件是唯一源码真源，全部平台部署使用 scripts/build.mjs 打出的
// 单文件构建产物（平台侧不做 build）。

const DEFAULT_TARGET_HOST = "https://opencode.ai"

// CF worker 决策层通过此头把"该转发到哪个最终上游"透传给平台。
// 平台读到合法值就直接转发，读到非法/缺失就回退 DEFAULT_TARGET_HOST。
const HEADER_TARGET = "x-proxy-target"
// 允许被信任的上游 host（Allowlist，防平台变成任意目标开放代理）。
// 匹配规则：完全相等或 host 本身是名单条目的子域（如 api.opencode.ai 匹配 opencode.ai）。
// 换上游 host 时只需改这里 + worker 的 UPSTREAM_TARGET，平台产物不必重建。
const ALLOWED_TARGET_HOSTS = ["opencode.ai"]

const REQUEST_TIMEOUT_MS = 60_000
const VERSION = "2.0.0"

const API_PREFIXES = ["/zen/", "/v1/"]

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
}

export interface PlatformInfo {
  platform: string
  version?: string
}

export interface EgressProbe {
  ipv4: string | null
  ipv6: string | null
}

/** 是否属于需要转发给上游的 API 路径 */
export function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some((p) => pathname.startsWith(p))
}

/** CORS preflight 与 method 校验；通过返回 null */
export function handlePreflight(request: Request): Response | null {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS })
  }
  if (request.method !== "POST" && request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Only POST and GET allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }
  return null
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  })
}

/** 健康检查：暴露平台信息，供 oc test / 健康分级使用 */
export function healthResponse(info: PlatformInfo): Response {
  return jsonResponse(200, {
    status: "ok",
    platform: info.platform,
    version: info.version || VERSION,
    noCache: true,
    headers: { "Cache-Control": "no-store" },
  })
}

/** 出口探针：汇报本平台对外出口 IP（v4/v6），用于身份池筛选 */
export async function diagnoseResponse(info: PlatformInfo): Promise<Response> {
  const probe = await Promise.race([probeEgress(), delay(4000)])
  return jsonResponse(200, {
    platform: info.platform,
    version: info.version || VERSION,
    ipv4: probe ? probe.ipv4 : null,
    ipv6: probe ? probe.ipv6 : null,
  })
}

async function probeEgress(): Promise<EgressProbe | null> {
  const [v4, v6] = await Promise.allSettled([
    fetchOutboundIP("https://api.ipify.org?format=json"),
    fetchOutboundIP("https://api6.ipify.org?format=json"),
  ])
  const ipv4 = v4.status === "fulfilled" ? v4.value : null
  const ipv6 = v6.status === "fulfilled" ? v6.value : null
  if (ipv4 == null && ipv6 == null) return null
  return { ipv4, ipv6 }
}

async function fetchOutboundIP(url: string): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    try {
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok) return null
      const data = (await res.json()) as { ip?: string }
      return typeof data.ip === "string" ? data.ip : null
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null
  }
}

function delay(ms: number): Promise<undefined> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 解析 CF 透传的目标地址。
 * 仅当 header 存在、host 通过 Allowlist 校验、且为 https 时信任，否则返回 null（回退默认）。
 */
export function resolveProxyTarget(request: Request): string | null {
  const raw = request.headers.get(HEADER_TARGET)
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== "https:") return null
    const host = url.hostname.toLowerCase()
    if (!ALLOWED_TARGET_HOSTS.some((allowed) => host === allowed || host.endsWith("." + allowed))) {
      return null
    }
    return raw
  } catch {
    return null
  }
}

/**
 * 转发到目标上游。
 * 目标由 CF 决策层通过 x-proxy-target 头透传（决策集中，平台零配置）；
 * 无该头（直连平台）时回退到 DEFAULT_TARGET_HOST。
 * 纯透传：保留客户端 x-opencode-* 与 Authorization；不修改、不伪装。
 * 返回原始上游 Response（含 SSE body 流），平台运行时负责流式输出。
 */
export async function proxyToOpenCode(request: Request): Promise<Response> {
  const url = new URL(request.url)

  if (!isApiPath(url.pathname)) {
    return jsonResponse(404, { error: "Not found" })
  }

  const target = resolveProxyTarget(request) ?? DEFAULT_TARGET_HOST + url.pathname + url.search

  const body =
    request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()

  const forwardHeaders = new Headers()
  for (const [key, value] of request.headers.entries()) {
    const lowerKey = key.toLowerCase()
    if (lowerKey.startsWith("x-opencode-") || lowerKey === "authorization") {
      forwardHeaders.set(key, value)
    }
  }
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

/** 统一入口：preflight → (health | diagnose | proxy)，返回已注入 CORS 的 Response */
export async function handlePlatformRequest(
  request: Request,
  info: PlatformInfo,
  pathTransform?: (pathname: string) => string,
): Promise<Response> {
  const preflight = handlePreflight(request)
  if (preflight) return preflight

  // 平台可能改写路径（如 Supabase 的 /proxy 前缀）。transformed = 平台实际看到的 path。
  let path = pathTransform ? pathTransform(new URL(request.url).pathname) : new URL(request.url).pathname
  if (!path) path = "/"

  if (path === "/health") return healthResponse(info)
  if (path === "/diagnose") return diagnoseResponse(info)

  // 保留平台前缀差异：当 pathTransform 存在但上游需要原始路径时，交给上层处理。
  // 默认情况 path == request.pathname，直接转发。
  const targetURL = new URL(request.url)
  if (path !== targetURL.pathname) {
    targetURL.pathname = path
    const nextRequest = new Request(targetURL.toString(), request)
    return proxyToOpenCode(nextRequest)
  }
  return proxyToOpenCode(request)
}