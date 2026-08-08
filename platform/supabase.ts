// Supabase Edge Function 入口（构建产物，勿手改）
// 由 scripts/build.mjs 从 shared/proxy.ts + 本入口打单文件到 supabase/functions/proxy/index.js
// 注意：Supabase 挂载在 /functions/v1/proxy，路径带 /proxy 前缀，适配器负责剥离
import { handlePlatformRequest, VERSION } from "../shared/proxy.ts"

// Supabase 的 fetch 入口形态与 Deno.serve 一致（Deno 运行时）
const stripProxyPrefix = (pathname: string): string => {
  if (pathname.startsWith("/proxy/")) return pathname.slice("/proxy".length)
  if (pathname === "/proxy") return "/"
  return pathname
}

Deno.serve((request: Request): Promise<Response> => {
  return handlePlatformRequest(request, { platform: "supabase", version: VERSION }, stripProxyPrefix)
})