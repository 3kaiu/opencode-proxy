import { proxyToOpenCode } from "../shared/proxy.js"

// Cloud Run 入口：用 Bun 运行时，直接跑 TS
// 部署方式: Bun Docker 镜像，推送到 Artifact Registry，部署到 Cloud Run
// 出口 IP 是 GCP 随机分配的，自动变化，不需要手动触发重建

const port = parseInt(process.env.PORT || "8080", 10)

Bun.serve({
  port,
  async fetch(request: Request): Promise<Response> {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        },
      })
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Only POST allowed" }), {
        status: 405,
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
      })
    }

    const response = await proxyToOpenCode(request)

    return response
  },
})

console.log(`[gcp-cloud-run] Proxy listening on port ${port}`)