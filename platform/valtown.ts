import { handlePlatformRequest, VERSION } from "../shared/proxy.ts"

export default async function (request: Request): Promise<Response> {
  return handlePlatformRequest(request, { platform: "valtown", version: VERSION })
}
