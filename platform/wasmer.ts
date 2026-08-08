// Wasmer Edge JS Worker 入口（构建产物，勿手改）
// 由 scripts/build.mjs 从 shared/proxy.ts + 本入口打单文件到 wasmer/src/index.js
// 运行环境: Wasmer Edge + WinterJS (WinterCG 兼容, addEventListener("fetch"))
import { handlePlatformRequest, VERSION } from "../shared/proxy.ts"

addEventListener("fetch", (event: FetchEvent) => {
  event.respondWith(handlePlatformRequest(event.request, { platform: "wasmer", version: VERSION }))
})
