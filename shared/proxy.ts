const D = "https://opencode.ai", H = "x-proxy-target", A = ["opencode.ai"], T = 6e4, V = "2.0.0", P = ["/zen/", "/v1/"]
const C = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "*", "Access-Control-Max-Age": "86400" }
const J = { ...C, "Content-Type": "application/json" }

interface I { platform: string; version?: string }

export async function handlePlatformRequest(r: Request, i: I, t?: (p: string) => string): Promise<Response> {
  if (r.method === "OPTIONS") return new Response(null, { headers: C })
  if (r.method !== "POST" && r.method !== "GET") return new Response('{"error":"Only POST and GET allowed"}', { status: 405, headers: J })

  let p = t ? t(new URL(r.url).pathname) : new URL(r.url).pathname
  if (!p) p = "/"

  if (p === "/health") return new Response(JSON.stringify({ status: "ok", platform: i.platform, version: i.version || V, noCache: !0, headers: { "Cache-Control": "no-store" } }), { headers: J })
  if (p === "/diagnose") {
    const [v4, v6] = await Promise.allSettled([ip("https://api.ipify.org?format=json"), ip("https://api6.ipify.org?format=json")])
    const a = v4.status === "fulfilled" ? v4.value : null, b = v6.status === "fulfilled" ? v6.value : null
    return new Response(JSON.stringify({ platform: i.platform, version: i.version || V, ipv4: a, ipv6: b }), { headers: J })
  }

  if (!P.some(x => p.startsWith(x))) return new Response('{"error":"Not found"}', { status: 404, headers: J })

  const u = new URL(r.url), g = rt(r) ?? D + u.pathname + u.search
  const bd = r.method === "GET" || r.method === "HEAD" ? void 0 : await r.arrayBuffer()
  const hd = new Headers()
  for (const [k, v] of r.headers) { const l = k.toLowerCase(); (l.startsWith("x-opencode-") || l === "authorization") && hd.set(k, v) }
  hd.set("Content-Type", r.headers.get("Content-Type") || "application/json")

  const c = new AbortController(), tm = setTimeout(() => c.abort(), T)
  try { return await fetch(g, { method: r.method, headers: hd, body: bd, signal: c.signal }) } finally { clearTimeout(tm) }
}

async function ip(u: string): Promise<string | null> {
  try {
    const c = new AbortController(), t = setTimeout(() => c.abort(), 3e3)
    try { const r = await fetch(u, { signal: c.signal }); if (!r.ok) return null; const d = await r.json() as { ip?: string }; return typeof d.ip === "string" ? d.ip : null } finally { clearTimeout(t) }
  } catch { return null }
}

function rt(r: Request): string | null {
  const v = r.headers.get(H); if (!v) return null
  try {
    const u = new URL(v); if (u.protocol !== "https:") return null
    const h = u.hostname.toLowerCase(); if (!A.some(a => h === a || h.endsWith("." + a))) return null
    return v
  } catch { return null }
}
