// Vercel Edge Function 入口（构建产物，勿手改）
// 由 scripts/build.mjs 从 shared/proxy.ts + 本入口打单文件到 api/proxy.js
import { handlePlatformRequest } from "../shared/proxy.ts"

export const config = { runtime: "edge" }

export default function handler(request: Request): Promise<Response> {
  return handlePlatformRequest(request, { platform: "vercel", version: "2.0.0" })
}