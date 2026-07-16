import type { Config, Context } from "@netlify/edge-functions"
import { handlePreflight, proxyToOpenCode } from "../shared/proxy.ts"
import { isFreeUsageExceeded } from "../shared/detection.ts"
import { triggerSelfRedeploy } from "../shared/redeploy.ts"

export default async (request: Request, context: Context): Promise<Response> => {
  // CORS preflight / method check
  const preflight = handlePreflight(request)
  if (preflight) return preflight

  const response = await proxyToOpenCode(request)

  // 检测到限流后，后台触发自我重新部署以换出口 IP
  if (await isFreeUsageExceeded(response)) {
    const hookUrl = Netlify.env.get("DEPLOY_HOOK_URL")
    triggerSelfRedeploy(hookUrl).catch(console.error)
  }

  return response
}

export const config = {
  path: "/*",
}