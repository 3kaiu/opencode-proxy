// opencode-proxy - Render adapter (Node.js HTTP server)
// Deploy: render.com -> New -> Web Service -> connect 3kaiu/opencode-proxy -> Docker
// Free tier: 750 instance hours/month, spins down after 15min idle (~1min cold start)
// Exit IP: AWS (non-Cloudflare) ✅

const http = require("http");
const https = require("https");

const TARGET_HOST = "opencode.ai";
const LISTEN_PORT = process.env.PORT || 7860;

const CORS_HEADERS = {
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

function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function randomHex(bytes = 8) {
  return require("crypto").randomBytes(bytes).toString("hex");
}

const server = http.createServer((req, res) => {
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

  const url = new URL(req.url, `http://localhost:${LISTEN_PORT}`);

  // 健康检查
  if (url.pathname === "/health") {
    res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", platform: "render" }));
    return;
  }

  // 构建转发 headers
  const forwardHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.startsWith("x-opencode-") || lowerKey === "authorization") {
      forwardHeaders[key] = value;
    }
  }
  forwardHeaders["User-Agent"] = randomUserAgent();
  forwardHeaders["X-Random-ID"] = randomHex(8);
  forwardHeaders["Content-Type"] = req.headers["content-type"] || "application/json";
  forwardHeaders["Host"] = TARGET_HOST;

  const proxyReq = https.request(
    {
      hostname: TARGET_HOST,
      port: 443,
      path: url.pathname + url.search,
      method: req.method,
      headers: forwardHeaders,
    },
    (proxyRes) => {
      const statusCode = proxyRes.statusCode || 502;
      // 复制上游 headers + CORS
      const responseHeaders = { ...proxyRes.headers, ...CORS_HEADERS };
      res.writeHead(statusCode, responseHeaders);
      // 流式转发响应体（支持 SSE）
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (err) => {
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
  console.log(`opencode-proxy (render) listening on :${LISTEN_PORT}`);
});
