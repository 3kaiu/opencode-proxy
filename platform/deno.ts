// Deno Deploy 入口（构建产物，勿手改）
// 由 scripts/build.mjs 从 shared/proxy.ts + 本入口打单文件到 deno/main.js
import { handlePlatformRequest } from "../shared/proxy.ts"

Deno.serve((request: Request): Promise<Response> => {
  return handlePlatformRequest(request, { platform: "deno", version: "2.0.0" })
})