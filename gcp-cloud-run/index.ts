import { proxyToOpenCode } from "../shared/proxy.js"
import { isFreeUsageExceeded } from "../shared/detection.js"
import { triggerSelfRedeploy } from "../shared/redeploy.js"

// Cloud Run 入口：用 Bun 运行时，直接跑 TS
// 部署方式: Bun Docker 镜像，推送到 Artifact Registry，部署到 Cloud Run
// 检测到限流后，通过 Cloud Run Deploy Hook 触发重建换 IP
// 需要环境变量: DEPLOY_HOOK_URL

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

    // 检测到限流后，触发自我重新部署以换出口 IP
    if (await isFreeUsageExceeded(response)) {
      const hookUrl = process.env.DEPLOY_HOOK_URL
      triggerSelfRedeploy(hookUrl).catch(console.error)
    }

    return response
  },
})

console.log(`[gcp-cloud-run] Proxy listening on port ${port}`)