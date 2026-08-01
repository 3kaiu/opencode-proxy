import { handlePreflight, proxyToOpenCode } from "../shared/proxy.ts"

Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight

  return await proxyToOpenCode(req)
})