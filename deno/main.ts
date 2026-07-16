import { handlePreflight, proxyToOpenCode } from "../shared/proxy.ts"
import { isFreeUsageExceeded } from "../shared/detection.ts"
import { triggerSelfRedeploy } from "../shared/redeploy.ts"

Deno.serve(async (req) => {
  // CORS preflight / method check
  const preflight = handlePreflight(req)
  if (preflight) return preflight

  const response = await proxyToOpenCode(req)

  // 检测到限流后，后台触发自我重新部署以换出口 IP
  if (await isFreeUsageExceeded(response)) {
    const hookUrl = Deno.env.get("DEPLOY_HOOK_URL")
    triggerSelfRedeploy(hookUrl).catch(console.error)
  }

  return response
})