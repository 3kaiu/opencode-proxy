// opencode-proxy - scriptc adapter (TypeScript → native binary)
//
// scriptc compiles TypeScript to a tiny native binary (~200KB, no Node.js runtime).
// Deploy: npm i -g scriptc && scriptc build scriptc/proxy.ts -o opencode-proxy
// Then: scp opencode-proxy-linux vps:/usr/local/bin/ && run as systemd service
//
// Exit IP: whatever VPS you deploy to (non-Cloudflare if VPS is not CF) ✅
// Requires: a VPS (Oracle Cloud free tier, etc.)
//
// This file uses only statically-compilable APIs:
// - node:http / node:https (createServer, request, pipe)
// - node:crypto (randomBytes)
// - console.log
// No fetch(), no AbortController, no dynamic features.

import * as http from "node:http";
import * as https from "node:https";
import { randomBytes } from "node:crypto";

const TARGET_HOST = "opencode.ai";
const LISTEN_PORT = parseInt(process.env.PORT ?? "8787", 10);

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

const USER_AGENTS = [
  "opencode/latest/1.3.15/cli",
  "opencode/latest/1.3.16/cli",
  "opencode/latest/1.3.17/cli",
  "opencode/latest/1.4.0/cli",
  "opencode/latest/1.4.1/cli",
];

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function randomHex(bytes = 8): string {
  return randomBytes(bytes).toString("hex");
}

const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  if (req.method !== "POST" && req.method !== "GET") {
    res.writeHead(405, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Only GET and POST allowed" }));
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${LISTEN_PORT}`);

  // 健康检查
  if (url.pathname === "/health") {
    res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", platform: "scriptc" }));
    return;
  }

  // 构建转发 headers — 只透传 x-opencode-* 和 authorization
  const forwardHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.startsWith("x-opencode-") || lowerKey === "authorization") {
      forwardHeaders[key] = value as string;
    }
  }
  forwardHeaders["User-Agent"] = randomUserAgent();
  forwardHeaders["X-Random-ID"] = randomHex(8);
  forwardHeaders["Content-Type"] = (req.headers["content-type"] as string) ?? "application/json";
  forwardHeaders["Host"] = TARGET_HOST;

  const proxyReq = https.request(
    {
      hostname: TARGET_HOST,
      port: 443,
      path: url.pathname + url.search,
      method: req.method,
      headers: forwardHeaders,
    },
    (proxyRes: http.IncomingMessage) => {
      const sc = proxyRes.statusCode ?? 502;
      // 复制上游 headers + CORS
      const responseHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        responseHeaders[key] = value as string;
      }
      for (const [key, value] of Object.entries(CORS_HEADERS)) {
        responseHeaders[key] = value;
      }
      res.writeHead(sc, responseHeaders);
      // 流式转发响应体（SSE-safe pipe）
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (err: Error) => {
    console.error("[proxy] Error:", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { ...CORS_HEADERS, "Content-Type": "text/plain" });
      res.end("bad gateway");
    }
  });

  // 流式转发请求体
  req.pipe(proxyReq);
});

server.listen(LISTEN_PORT, () => {
  console.log(`opencode-proxy (scriptc native) listening on :${LISTEN_PORT}`);
});
