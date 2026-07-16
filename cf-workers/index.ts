import { proxyToOpenCode } from "../shared/proxy"
import { isFreeUsageExceeded } from "../shared/detection"
import { triggerSelfRedeploy } from "../shared/redeploy"

export default {
  async fetch(
    request: Request,
    env: { DEPLOY_HOOK_URL?: string },
    ctx: ExecutionContext,
  ): Promise<Response> {
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

    // 检测到限流后，后台触发自我重新部署以换出口 IP
    if (await isFreeUsageExceeded(response)) {
      ctx.waitUntil(triggerSelfRedeploy(env.DEPLOY_HOOK_URL))
    }

    return response
  },
}