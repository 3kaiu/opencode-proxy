import { proxyToOpenCode } from "../shared/proxy"
import { isFreeUsageExceeded } from "../shared/detection"
import { triggerSelfRedeploy } from "../shared/redeploy"

export default async function handler(request: Request): Promise<Response> {
  const response = await proxyToOpenCode(request)

  // 检测到限流后，后台触发自我重新部署以换出口 IP
  if (await isFreeUsageExceeded(response)) {
    const hookUrl = Deno.env.get("VERCEL_DEPLOY_HOOK_URL")
    if (hookUrl) {
      // Edge Runtime 没有 waitUntil，直接 fetch 异步触发
      triggerSelfRedeploy(hookUrl).catch(console.error)
    }
  }

  return response
}

export const config = { runtime: "edge" }