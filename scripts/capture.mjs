#!/usr/bin/env node
// scripts/capture.mjs — 本地纯转发观测代理
//   opencode client -> 127.0.0.1:8787 (capture) -> target
// 只做两件事: 1) 原样转发请求/响应流  2) 全程 JSONL 落盘 captures/capture-<ts>.jsonl
// 用法: node scripts/capture.mjs [--port 8787] [--target https://opencode.ai]

import http from "node:http"
import fs from "node:fs"
import path from "node:path"

const argv = process.argv.slice(2)
const argOf = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt }
const PORT = Number(argOf("--port", "8787"))
const TARGET = String(argOf("--target", "https://opencode.ai")).replace(/\/+$/, "")
const OUT_DIR = path.join(process.cwd(), "captures")
const BODY_CAP = 256 * 1024
const HOP = /^(host|connection|proxy-connection|content-length|transfer-encoding|upgrade)$/i

fs.mkdirSync(OUT_DIR, { recursive: true })
const logFd = fs.openSync(path.join(OUT_DIR, `capture-${Date.now()}.jsonl`), "a")
const writeLog = (e) => { try { fs.writeSync(logFd, JSON.stringify(e) + "\n") } catch {} }

function handler(req, res) {
  void handle(req, res)
}

async function handle(req, res) {
  const started = Date.now()
  const reqParts = []
  for await (const c of req) { reqParts.push(c) }
  const reqBody = Buffer.concat(reqParts)
  const reqHeaders = {}
  for (const [k, v] of Object.entries(req.headers ?? {})) reqHeaders[k.toLowerCase()] = v

  const fwd = {}
  for (const [k, v] of Object.entries(reqHeaders)) { if (!HOP.test(k)) fwd[k] = v }

  let up = null
  try {
    up = await fetch(TARGET + req.url, {
      method: req.method,
      headers: fwd,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : reqBody,
    })
  } catch (err) {
    writeLog({ ts: started, method: req.method, path: req.url, error: `upstream: ${err.message}` })
    res.writeHead(502, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: err.message }))
    console.log(`[${new Date(started).toISOString()}] upstream error: ${err.message}`)
    return
  }

  const resHeaders = {}
  up.headers.forEach((v, k) => { if (!/^(content-length|transfer-encoding|connection)$/i.test(k)) resHeaders[k] = v })
  res.writeHead(up.status, resHeaders)

  const buf = []
  let chunkCount = 0, bytes = 0
  try {
    for await (const value of up.body) {
      chunkCount++; bytes += value.length
      if (bytes <= BODY_CAP) buf.push(value)
      await new Promise((ok) => res.write(value, ok))
    }
  } catch (err) {
    console.log(`[capture] stream error on ${req.url}: ${err.message}`)
  }
  res.end()

  writeLog({
    ts: started,
    ms: Date.now() - started,
    method: req.method,
    path: req.url,
    request: { headers: reqHeaders, body: reqBody.toString("utf8").slice(0, BODY_CAP) },
    response: {
      status: up.status,
      headers: resHeaders,
      chunks: chunkCount,
      bytes,
      body: Buffer.concat(buf).toString("utf8").slice(0, BODY_CAP),
    },
  })
  console.log(`[${new Date(started).toISOString().slice(11, 19)}] ${req.method} ${req.url} -> ${up.status} | ${chunkCount} chunks ${bytes}B ${Date.now() - started}ms`)
}

const s = http.createServer(handler)
s.listen(PORT, "127.0.0.1", () => {
  console.log(`[capture] listen http://127.0.0.1:${PORT}  ->  ${TARGET}`)
  console.log(`[capture] log: ${OUT_DIR}/capture-*.jsonl`)
  console.log(`[capture] 接线: opencode.jsonc 里 oc.options.baseURL 改为 http://127.0.0.1:${PORT}/zen/v1`)
})