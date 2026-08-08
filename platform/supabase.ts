// Supabase Edge Function 入口（构建产物，勿手改）
// 由 scripts/build.mjs 从 shared/proxy.ts + 本入口打单文件到 supabase/functions/{slug}/index.js
// 注意：Supabase 挂载在 /functions/v1/{slug}，路径带函数名前缀，适配器负责剥离
import { handlePlatformRequest, VERSION } from "../shared/proxy.ts"

// Supabase 的 fetch 入口形态与 Deno.serve 一致（Deno 运行时）
// 剥离任意函数名前缀（/proxy-1/health -> /health），同一产物可部署为多个 slug
const stripFunctionPrefix = (pathname: string): string => {
  const rest = pathname.replace(/^\/[^/]+/, "")
  return rest || "/"
}

Deno.serve((request: Request): Promise<Response> => {
  return handlePlatformRequest(request, { platform: "supabase", version: VERSION }, stripFunctionPrefix)
})