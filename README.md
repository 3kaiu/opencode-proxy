# opencode-proxy

三出口代理，用于 opencode.ai API 的流量代理和出口 IP 自动切换。

| 出口 | 平台 | 状态 | 入口 |
|------|------|------|------|
| **Vercel** | Vercel Edge Function | ✅ 可用 | `api/proxy.ts` |
| **Cloudflare Workers** | Cloudflare Workers | ✅ 可用 | `cf-workers/index.ts` |
| **Deno Deploy** | Deno Deploy | ⚠️ 需绑卡验证 | `deno/main.ts` |

> **Deno Deploy 状态说明**：Deno Deploy Free 计划从 2024 年中起要求组织验证（绑定信用卡/企业验证），否则只能使用 Free 计划的 1% 配额（约 1 万请求/月、0.2GB 出口流量）。代码已保留，待验证后即可启用。

## 架构

三个独立部署，**没有主备关系**。各自在检测到 `Free usage exceeded, subscribe to Go` 限流后，通过平台 Deploy Hook 触发自我重新部署，以获得新的出口 IP。

```
用户（本地 opencodex 配置中手动选择出口）
  ├── Vercel Edge Function
  ├── Cloudflare Workers
  └── Deno Deploy（待验证）
```

## 部署

### Vercel

1. 在 [Vercel](https://vercel.com) 导入此仓库
2. 项目设置 → Git → Deploy Hooks → 创建 Hook
3. 复制 Hook URL，设为环境变量 `DEPLOY_HOOK_URL`
4. 部署

### Cloudflare Workers

1. 安装 Wrangler CLI：`npm install -g wrangler`
2. 登录：`wrangler login`
3. 部署：`wrangler deploy`
4. 设置 Deploy Hook Secret：
   ```bash
   echo <DEPLOY_HOOK_URL> | wrangler secret put DEPLOY_HOOK_URL
   ```
5. Cloudflare Workers 的 Deploy Hook 需要在 Dashboard → Workers → 选择项目 → Deployments → Create via API 创建

### Deno Deploy

1. 在 [Deno Deploy](https://dash.deno.com) 创建项目
2. 入口文件设为 `deno/main.ts`
3. 项目设置 → Deploy Hooks → 创建 Hook
4. 复制 Hook URL，设为环境变量 `DENO_DEPLOY_HOOK_URL`
5. 部署

## 本地配置

在 opencodex 的 `config.toml` 中配置代理，按需切换出口：

```toml
[model.provider.opencode]
base_url = "https://你的-vercel-域名.vercel.app"
```

或

```toml
[model.provider.opencode]
base_url = "https://你的-workers-域名.workers.dev"
```

## 环境变量

| 变量 | 平台 | 说明 |
|------|------|------|
| `DEPLOY_HOOK_URL` | Vercel / Cloudflare | 平台 Deploy Hook URL，触发重新部署 |
| `DENO_DEPLOY_HOOK_URL` | Deno | Deno Deploy Hook URL，触发重新部署 |

## 检测与切换

检测到 HTTP 403/429 且响应体包含 `Free usage exceeded, subscribe to Go` 时：

1. 当前请求正常返回（不中断）
2. 后台异步 POST 到 Deploy Hook URL
3. 平台开始重新部署，新实例从不同边缘节点提供服务
4. 出口 IP 随新部署变化

## 文件结构

```
opencode-proxy/
├── api/
│   └── proxy.ts              ← Vercel Edge Function 入口
├── cf-workers/
│   └── index.ts              ← Cloudflare Workers 入口
├── deno/
│   ├── main.ts               ← Deno Deploy 入口
│   └── deno.json
├── shared/
│   ├── proxy.ts              ← 共享代理核心
│   ├── detection.ts          ← 限流检测
│   └── redeploy.ts           ← 自我重新部署触发
├── wrangler.toml             ← Cloudflare Workers 配置
├── vercel.json
├── package.json
└── README.md
```