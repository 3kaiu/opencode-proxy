# opencode-proxy 全面审计报告

> 审计日期：2026-07-16
> 审计范围：代码质量、架构、性能、安全、可维护性、平台适配正确性、功能完整性

---

## 目录

1. [代码质量](#1-代码质量)
2. [架构](#2-架构)
3. [性能](#3-性能)
4. [安全](#4-安全)
5. [可维护性](#5-可维护性)
6. [平台适配正确性](#6-平台适配正确性)
7. [功能完整性](#7-功能完整性)
8. [优先级排序整改建议](#8-优先级排序整改建议)

---

## 1. 代码质量

### 1.1 重复代码 — P0

四个入口文件（`api/proxy.ts`、`cf-workers/index.ts`、`deno/main.ts`、`netlify/edge-functions/proxy.ts`）包含完全相同的 CORS preflight 处理和 method 检查。差异仅在于环境变量获取方式和后台触发方式。

**当前重复代码量：** 每个入口约 15 行完全相同的 CORS/method 样板。

**建议：** 将 CORS preflight + method 校验提取到 `shared/proxy.ts` 中，让入口文件只处理平台差异（环境变量获取 + 后台执行上下文）。

### 1.2 路径引用不一致 — P1

| 入口 | 导入路径 | 是否有 `.ts` 后缀 |
|------|----------|-------------------|
| `api/proxy.ts` | `../shared/proxy` | ❌ 无 |
| `cf-workers/index.ts` | `../shared/proxy` | ❌ 无 |
| `deno/main.ts` | `../shared/proxy.ts` | ✅ 有 |
| `netlify/edge-functions/proxy.ts` | `../shared/proxy.ts` | ✅ 有 |

Deno 和 Netlify 需要 `.ts` 后缀，Vercel 和 CF Workers 通过 bundler 解析不需要。虽然各自平台能跑，但给人不一致的印象。**建议统一使用 `.ts` 后缀**，因为 Deno 和 Netlify Edge 是严格解析的，Vercel/CF 的 bundler 也能处理带后缀的导入。

### 1.3 `isFreeUsageExceeded` 的 `clone()` 调用 — 已确认安全

`detection.ts` 中对 `response.clone().text()` 是必要的，因为后续需要返回原始 `response` 给用户。当前实现正确，没有优化空间。

### 1.4 `triggerSelfRedeploy` 的 fire-and-forget 模式 — P2

四个入口使用不同的 fire-and-forget 方式：

| 入口 | 方式 | 是否正确 |
|------|------|---------|
| Vercel | `triggerSelfRedeploy(...).catch(console.error)` | 可以，但 Vercel Edge 可能在响应返回后 kill 上下文 |
| CF Workers | `ctx.waitUntil(triggerSelfRedeploy(...))` | ✅ 正确，等待 promise 完成 |
| Deno | `triggerSelfRedeploy(...).catch(console.error)` | 可以，Deno.serve 通常不会立即 kill |
| Netlify | `triggerSelfRedeploy(...).catch(console.error)` | 可以，Netlify Edge 有缓冲 |

**风险：** Vercel Edge Function 在响应返回到客户端后，异步任务可能被平台中断。CF Workers 的 `ctx.waitUntil` 是唯一保证完成后台任务的方式。

### 1.5 `request.arrayBuffer()` 在 proxy.ts 中重复读取 — 安全

`shared/proxy.ts` 中读取 `request.arrayBuffer()` 用于转发给 fetch。这是必要的，因为：
1. 入口需要读取 body 来检测限流（通过 `isFreeUsageExceeded`）
2. 但当前实现中 **入口并没有读取 body**，而是直接转发 `response`

实际上 `proxyToOpenCode` 内部读取 body 并转发是正确的，因为入口不需要关心 body 内容。**不需要修改。**

---

## 2. 架构

### 2.1 模块划分 — 合理

```
shared/
  proxy.ts       ← 核心代理：转发请求 + 随机 Header
  detection.ts   ← 限流检测：判断 403/429 + 关键词
  redeploy.ts    ← 自重建触发：POST Deploy Hook
api/cf-workers/deno/netlify/  ← 各平台入口：仅桥接
```

划分清晰，关注点分离良好。每个入口的职责仅是：
1. 获取平台特定配置（环境变量、execution context）
2. 桥接平台事件模型（fetch handler / Deno.serve）

### 2.2 跨平台复用 — 良好

所有逻辑在 `shared/` 中，4 个入口总共只做了 3 件事：CORS → proxy → 检测 → 重建。没有逻辑泄漏到入口层。

### 2.3 平台差异处理 — 部分缺失 P2

各平台的能力差异没有被显式抽象：

| 能力 | Vercel | CF Workers | Deno | Netlify |
|------|--------|------------|------|---------|
| 后台任务保证 | ❌ | ✅ `ctx.waitUntil` | ❌ 无保证 | ❌ 无保证 |
| 环境变量方式 | `process.env` | `env.XXX` 参数 | `Deno.env.get` | `Netlify.env.get` |
| 部署方式 | Git 导入 | wrangler / Dashboard | Git 导入 | Git 导入 |
| 是否支持 `waitUntil` | ❌ | ✅ | ❌ | ❌ |

**建议：** 将后台任务执行也抽象到 `shared/redeploy.ts` 中，接受一个可选的 `waitUntil` 回调。

### 2.4 没有统一入口测试 — P3

没有集成测试或端到端测试验证代理在各平台的正确性。虽然这是边缘函数代理，但至少可以有一个脚本验证基础转发功能。

---

## 3. 性能

### 3.1 流式 SSE 透传 — ✅ 已实现

`shared/proxy.ts` 直接返回 `fetch(target, ...)` 的 Response，没有读 body，实现了流式透传。这是正确的做法。

### 3.2 请求 body 读取时机 — ✅ 正确

`proxyToOpenCode` 只在需要时读取 body（GET/HEAD 跳过），读取后直接传给 fetch，没有额外序列化开销。

### 3.3 `isFreeUsageExceeded` 在正常路径上的开销 — P2

每次请求都会调用 `isFreeUsageExceeded(response)`，但正常请求的 `response.status` 是 200，函数在 `!== 403 && !== 429` 时立即返回 false，**不会读 body**。所以正常路径没有额外开销。✅

但限流路径上会 `clone().text()` 读取完整响应体，这在大型流式响应中可能有内存开销。不过限流响应体通常很小，可接受。

### 3.4 随机 Header 的 crypto 开销 — 可忽略

`randomHex(8)` 使用 `crypto.getRandomValues`，这是同步的、非阻塞的，每次调用 < 0.01ms。可忽略。

### 3.5 没有缓存 — 合理

代理层不需要缓存，因为所有请求都是实时 API 调用。

---

## 4. 安全

### 4.1 环境变量泄漏风险 — P1

`shared/redeploy.ts` 在 `console.error` 中输出 `hookUrl` 如果请求失败：

```ts
console.error(`[redeploy] Hook returned ${res.status}: ${await res.text()}`)
```

**这里没有打印 hookUrl 本身**，所以没有泄漏。✅

但 `triggerSelfRedeploy` 不检查 hookUrl 是否以 `https://` 开头，如果传入错误值，会向任意 URL 发 POST。**建议添加格式校验。**

### 4.2 CORS 配置过于宽松 — P2

所有入口都设置 `Access-Control-Allow-Origin: *`。对于一个公开代理来说这是必要的，但 `Access-Control-Allow-Methods: "POST, OPTIONS"` 中的 `*` 对于 `Allow-Headers` 是合理的。

**风险：** 任何网站都可以从浏览器直接调用这个代理。不过由于代理需要 authorization header，实际风险有限。

### 4.3 请求头透传 — P1

`shared/proxy.ts` 只透传 `x-opencode-*` 和 `authorization` header，这是最小权限原则。✅

但 `Content-Type` 是硬编码默认值，如果客户端发送了自定义 `Content-Type`，会被覆盖。**建议：** 如果客户端带了 Content-Type，应该保留。

### 4.4 没有请求速率限制 — P2

当前没有实现任何请求速率限制。如果代理被滥用或被爬虫发现，可能导致：
1. 消耗 opencode.ai 的 API 配额
2. 触发平台滥用检测

**建议：** 可以添加简单的请求计数，但考虑到这是个人使用的代理，优先级不高。

### 4.5 没有请求超时 — P2

`fetch(target, ...)` 没有设置 `signal` 超时。如果 opencode.ai 挂起，请求会一直挂住直到平台超时。

**建议：** 添加 `AbortController` 超时（如 60 秒）。

---

## 5. 可维护性

### 5.1 README 中 AWS Lambda 残留 — ✅ 已修复

README 中第 66-69 行仍有 AWS Lambda 的配置示例，已被清除。

### 5.2 文件结构文档 — 准确

README 中的文件结构图基本准确，但缺少 `deno/deno.json` 和 `AUDIT.md`（本文件）。

### 5.3 部署文档 — 充分

每个平台都有部署步骤说明，包括环境变量设置。但缺少 Deploy Hook 创建的具体路径。

### 5.4 CI/CD — 只覆盖 Vercel 和 Deno

`.github/workflows/deploy.yml` 只包含 Vercel 和 Deno Deploy 的部署步骤。Cloudflare Workers 和 Netlify 没有 CI/CD 支持。

### 5.5 没有 lint/typecheck 配置 — P3

`package.json` 中没有 lint 或 typecheck 脚本。`tsconfig.json` 不存在。

---

## 6. 平台适配正确性

### 6.1 Vercel Edge Function — ✅

- 入口：`api/proxy.ts` ✓
- 环境变量：`process.env.DEPLOY_HOOK_URL` ✓
- 运行时声明：`export const config = { runtime: "edge" }` ✓
- `vercel.json` 配置正确：rewrites 到 `/api/proxy` ✓

### 6.2 Cloudflare Workers — ✅

- 入口：`cf-workers/index.ts` ✓
- 环境变量：通过 `env.DEPLOY_HOOK_URL` 参数 ✓
- 后台任务：`ctx.waitUntil` ✓
- `wrangler.toml` 配置正确 ✓

### 6.3 Deno Deploy — ✅

- 入口：`deno/main.ts` ✓
- 环境变量：`Deno.env.get("DEPLOY_HOOK_URL")` ✓
- 导入路径使用 `.ts` 后缀 ✓
- `deno.json` 配置正确 ✓

### 6.4 Netlify Edge Functions — ✅

- 入口：`netlify/edge-functions/proxy.ts` ✓
- 环境变量：`Netlify.env.get("DEPLOY_HOOK_URL")` ✓
- `netlify.toml` 配置正确 ✓
- 导入路径使用 `.ts` 后缀 ✓

### 6.5 平台特殊注意事项

| 平台 | 注意事项 |
|------|---------|
| Vercel | Edge Function 有 50ms 的 CPU 时间限制（高级 plan 才有放宽），但 proxy 只是转发所以没问题 |
| CF Workers | 免费计划每天 100k 请求，足够个人使用 |
| Deno Deploy | 需绑卡才有完整配额，否则只有 1% |
| Netlify | Edge Functions 免费计划每月 100k 调用，2MB 响应大小限制 |

---

## 7. 功能完整性

### 7.1 核心代理 — ✅ 完整

- HTTP 方法透传 ✓
- Header 透传（白名单） ✓
- Body 透传 ✓
- 流式响应透传 ✓
- 随机 User-Agent ✓
- 随机 X-Random-ID ✓

### 7.2 限流检测 — ✅ 完整

- 检测 403/429 状态码 ✓
- 检测 `Free usage exceeded, subscribe to Go` 文本 ✓
- 使用 `clone()` 避免消费响应流 ✓

### 7.3 自重建触发 — ✅ 完整

- 读取环境变量 `DEPLOY_HOOK_URL` ✓
- POST 到 Deploy Hook ✓
- Fire-and-forget（各平台机制不同） ✓
- 错误处理（catch + console.error） ✓

### 7.4 缺失功能

| 功能 | 严重程度 | 说明 |
|------|---------|------|
| 请求超时 | P2 | 没有 AbortController，可能挂死 |
| 健康检查端点 | P3 | 没有 `/health` 或 `/ping` 端点 |
| 请求日志/监控 | P3 | 没有请求计数或延迟记录 |
| 部署状态检查 | P3 | 重建后无法确认新实例是否就绪 |

---

## 8. 优先级排序整改建议

### P0 — 必须修复

| # | 问题 | 修复方案 |
|---|------|---------|
| 1 | 四个入口 CORS/method 检查重复 | 提取到 `shared/proxy.ts` 作为 `handleCorsAndMethod(request)` |

### P1 — 应该修复

| # | 问题 | 修复方案 |
|---|------|---------|
| 1 | 导入路径不一致（.ts 后缀） | 统一使用 `.ts` 后缀 |
| 2 | `Content-Type` 被硬编码覆盖 | 透传客户端 Content-Type 而非硬编码 |
| 3 | Vercel 后台任务可能被中断 | 在 Vercel 入口中确保 `triggerSelfRedeploy` 被 await 或使用 `ctx.waitUntil`（Vercel Edge 不支持，但可尝试 `event.waitUntil`） |

### P2 — 建议修复

| # | 问题 | 修复方案 |
|---|------|---------|
| 1 | 请求超时 | 添加 AbortController，60s 超时 |
| 2 | Vercel 后台任务保证 | 检查 Vercel Edge 是否支持 `waitUntil` 或转用 `waitUntil` polyfill |
| 3 | README 缺少 Deno 绑卡说明的准确位置 | 更新 Deno 部署说明 |

### P3 — 可优化

| # | 问题 | 修复方案 |
|---|------|---------|
| 1 | 没有 lint/typecheck 配置 | 添加 `tsconfig.json` 和 `package.json` 脚本 |
| 2 | 没有健康检查端点 | 在 `shared/proxy.ts` 中添加 `/health` 路径返回 200 |
| 3 | CI/CD 只覆盖两个平台 | 添加 CF Workers 和 Netlify 的部署步骤 |

---

## 总结

整体代码质量良好，架构清晰，模块划分合理。核心功能（代理转发、限流检测、自重建）完整正确。

**主要问题：**
1. 代码重复（CORS 样板）—— 影响可维护性
2. Vercel 后台任务可能被中断 —— 影响重建可靠性
3. 缺少请求超时 —— 影响稳定性

**亮点：**
- 流式 SSE 透传正确
- 限流检测正常路径零开销
- 四个平台适配正确
- 模块划分清晰，关注点分离良好