#!/usr/bin/env node
// scripts/capture.mjs — 本地捕获代理: 观测真实 AI 请求/响应(特征提取用)
//
// 用法:
//   node scripts/capture.mjs                      # 监听 127.0.0.1:8787, 原样转发 https://opencode.ai
//   node scripts/capture.mjs --port 9000 --target https://oc.wenn.in
// 接线(让 opencode 走本地观测站):
//   oc add dump http://127.0.0.1:8787/zen/v1 && oc use dump
// 然后正常发一次对话; Ctrl-C 后输出本次会话特征汇总。
//
// 记录:
//   - 请求行/请求头(原始)/请求体——不做任何改写
//   - 响应状态/响应头/流式 chunk 时序(first byte、chunk 间隔)
//   - SSE 事件文本(抽样)与 finish_reason
//   - 全程 JSONL 落盘 captures/capture-<ts>.jsonl

import http from "node:http"
import fs from "node:fs"
import path from "node:path"

const argv = process.argv.slice(2)
const flag = (name) => argv.indexOf(name)
const argOf = (name, dflt) => { const i = flag(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt }

const PORT = Number(argOf("--port", "8787"))
const TARGET = String(argOf("--target", "https://opencode.ai")).replace(/\/+$/, "")
const OUT_DIR = path.join(process.cwd(), "captures")

const BODY_CAP = 64 * 1024          // 记录最大 body 字符数
const TEXT_CAP = 2 * 1024 * 1024    // 用于 SSE 事件提取的最大文本量
const store = []                    // 本次会话聚合
let logFd = null

main()

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const outFile = path.join(OUT_DIR, `capture-${Date.now()}.jsonl`)
  logFd = fs.openSync(outFile, "a")

  const server = http.createServer((req, res) => { void handle(req, res) })
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[capture] 监听 http://127.0.0.1:${PORT}  →  ${TARGET}`)
    console.log(`[capture] 日志: ${outFile}`)
    console.log(`[capture] 接线: oc add dump http://127.0.0.1:${PORT}/zen/v1 && oc use dump`)
    console.log("[capture] Ctrl+C 输出汇总\n")
  })
  process.on("SIGINT", () => { server.close(); summary(); process.exit(0) })
}

async function handle(req, res) {
  const ts = Date.now()
  const reqBody = await readBody(req)
  const headers = {}                                    // 原始请求头(小写)
  for (const [k, v] of Object.entries(req.headersDistinct ?? req.headers)) {
    headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v)
  }

  const entry = { ts, method: req.method, path: req.url, headers, body: reqBody.length ? reqBody.toString("utf8").slice(0, BODY_CAP) : "" }

  // ---------- 转发: 原头透传, 仅滤 hop-by-hop; accept-encoding 限定 identity 便于看 SSE ----------
  const fwd = {}
  for (const [k, v] of Object.entries(headers)) {
    if (/^(host|connection|proxy-connection|content-length|transfer-encoding|accept-encoding)$/i.test(k)) continue
    fwd[k] = v
  }
  fwd["accept-encoding"] = "identity"

  let up
  try {
    up = await fetch(TARGET + req.url, {
      method: req.method,
      headers: fwd,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : reqBody,
      redirect: "manual",
    })
  } catch (err) {
    console.error(`[capture] upstream error: ${err.message}`)
    res.writeHead(502, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "capture upstream failed", message: err.message }))
    return
  }

  // ---------- 回写客户端(边收边转, 不缓冲) ----------
  const resHeaders = {}
  up.headers.forEach((v, k) => { if (!/^(content-length|transfer-encoding|connection)$/i.test(k)) resHeaders[k] = v })
  res.writeHead(up.status, resHeaders)

  const tStream = Date.now()
  const gaps = []
  const buf = []
  let firstMs = null
  let chunks = 0
  let bytes = 0
  let prev = tStream
  let textLen = 0

  try {
    while (true) {
      const { done, value } = await up.body.getReader().read()
      if (done) break
      const now = Date.now()
      if (firstMs === null) firstMs = now - tStream
      gaps.push(now - prev); prev = now
      chunks++; bytes += value.length
      if (textLen < TEXT_CAP) {
        const s = Buffer.from(value).toString("utf8")
        buf.push(s); textLen += s.length
      }
      await new Promise((ok) => res.write(value, ok))
    }
  } catch { /* 客户端断流, 记录已收部分 */ }

  res.end()

  entry.response = { status: up.status, headers: resHeaders, firstMs, chunks, bytes, gaps }
  const text = buf.join("")
  entry.sse = extractSse(text) // { events: [...], finishReason }
  store.push(entry)
  writeLog(entry)
  printLive(entry)
}

function extractSse(text) {
  const matches = []
  let finishReason = null
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue
    let payload = line.slice(5)
    if (payload.startsWith(" ")) payload = payload.slice(1)
    if (payload === "" || payload === "[DONE]") continue
    if (matches.length < 200) matches.push(payload.slice(0, 800))
    try {
      const j = JSON.parse(payload)
      if (j.finish_reason) finishReason = j.finish_reason
    } catch { /* 非 JSON 行忽略 */ }
  }
  return { events: matches.length, samples: matches.slice(0, 5), finishReason }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = []
    req.on("data", (c) => parts.push(c))
    req.on("end", () => resolve(Buffer.concat(parts)))
    req.on("error", reject)
  })
}

function writeLog(e) { if (logFd) fs.writeSync(logFd, JSON.stringify(e) + "\n") }

function printLive(e) {
  const g = e.response.gaps
  const avgGap = g.length ? Math.round(g.reduce((a, b) => a + b, 0) / g.length) : null
  const t = new Date(e.ts).toISOString().slice(11, 19)
  console.log(`\n[${t}] ${e.method} ${e.path}`)
  console.log(`  status=${e.response.status} ct=${(e.response.headers["content-type"] || "-")} | ${e.response.chunks} chunks first=${e.response.firstMs}ms avgGap=${avgGap}ms bytes=${e.response.bytes}${e.sse.finishReason ? ` finish=${e.sse.finishReason}` : ""}`)
  const show = ["authorization", "x-opencode-session", "x-session-id", "user-agent", "accept", "content-type", "x-ms-*"]
  const parts = []
  for (const k of show) if (e.headers[k]) parts.push(`${k}=${mask(k, e.headers[k])}`)
  console.log(`  h: ${parts.join("  ")}`)
  if (e.body) { const m = bodyFeature(e.body); if (m.model) console.log(`  body: model=${m.model} stream=${m.stream} msgs=${m.messages ?? "?"}`); }
}

function mask(k, v) {
  if (k === "authorization" || k === "proxy-authorization") return v.slice(0, 12) + "…[masked]"
  if (k === "cookie" || k === "x-opencode-session") return v.length > 10 ? v.slice(0, 10) + "…" : "..."
  return v.length > 70 ? v.slice(0, 70) + "…" : v
}

function bodyFeature(body) {
  const f = {}
  try {
    const j = JSON.parse(body)
    if (j.model) f.model = j.model
    if (j.stream !== undefined) f.stream = j.stream
    if (Array.isArray(j.messages)) f.messages = j.messages.length
    if (j.max_tokens !== undefined) f.max_tokens = j.max_tokens
    if (Array.isArray(j.tools)) f.tools = j.tools.length
  } catch { /* 非 JSON body */ }
  return f
}

function summary() {
  console.log("\n========== 特征汇总 ==========")
  if (store.length === 0) { console.log("未捕获到请求 (检查是否 oc use dump 生效)"); return }
  const agg = (fn) => { const m = {}; for (const e of store) { const k = fn(e); if (k) m[k] = (m[k] || 0) + 1 } return m }
  const fmt = (m) => Object.entries(m).map(([k, v]) => `${k}=${v}`).join("  ")

  console.log(`请求数: ${store.length}`)
  console.log("  路径: " + fmt(agg((e) => e.path.split("?")[0])))
  console.log("  方法: " + fmt(agg((e) => e.method)))
  console.log("  状态: " + fmt(agg((e) => e.response?.status)))
  console.log("  请求 CT: " + fmt(agg((e) => e.headers["content-type"])))
  const mod = agg((e) => bodyFeature(e.body).model); if (Object.keys(mod).length) console.log("  model: " + fmt(mod))

  const firsts = store.map((e) => e.response?.firstMs).filter((v) => v !== null)
  if (firsts.length) console.log(`  首字节: n=${firsts.length} min=${Math.min(...firsts)}ms med=${median(firsts)}ms max=${Math.max(...firsts)}ms`)
  const allGaps = store.flatMap((e) => e.response?.gaps ?? [])
  if (allGaps.length) console.log(`  chunk间隔: n=${allGaps.length} med=${median(allGaps)}ms p95=${quantile(allGaps, 0.95)}ms max=${Math.max(...allGaps)}ms`)
  const events = store.filter((e) => e.sse.events > 0)
  console.log(`  SSE: ${events.length} 个流式响应, 共 ${events.reduce((a, e) => a + e.sse.events, 0)} 个 data 事件` + (events.length ? `, finish=${[...new Set(events.map((e) => e.sse.finishReason).filter(Boolean))].join(",")}` : ""))
}

function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2) }
function quantile(a, q) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))] }