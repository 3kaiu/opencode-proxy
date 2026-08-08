// Vercel Function 入口（构建产物，勿手改）
// 由 scripts/build.mjs 从 shared/proxy.ts + 本入口打单文件到 api/proxy.js
// 采用官方 Web Signature: export default { fetch(request) } — era
// https://vercel.com/docs/functions/functions-api-reference#function-signature
import { handlePlatformRequest, VERSION } from "../shared/proxy.ts"

// Vercel 传入的 request.url 可能是相对路径(如 /health),
// 补全为绝对 URL 否则共享层 new URL() 抛 ERR_INVALID_URL
function normalize(request: Request): Request {
  try {
    new URL(request.url)
    return request
  } catch {
    const base = `https://${request.headers.get("host") ?? "vercel.app"}`
    return new Request(new URL(request.url, base).toString(), request)
  }
}

export default {
  fetch(request: Request): Promise<Response> {
    return handlePlatformRequest(normalize(request), { platform: "vercel", version: VERSION })
  },
}