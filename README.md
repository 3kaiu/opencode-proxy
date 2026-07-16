# opencode-proxy

多出口代理，用于 opencode.ai API 的流量代理和出口 IP 自动切换。

| 出口 | 平台 | 类型 | 状态 | 入口 |
|------|------|------|------|------|
| **Vercel** | Vercel Edge Function | Edge | ✅ 可用 | `api/proxy.ts` |
| **Cloudflare Workers** | Cloudflare Workers | Edge | ✅ 可用 | `cf-workers/index.ts` |
| **Netlify** | Netlify Edge Functions | Edge | ✅ 可用 | `netlify/edge-functions/proxy.ts` |
| **Deno Deploy** | Deno Deploy | Edge | ✅ 可用（需绑卡验证） | `deno/main.ts` |

> **Deno Deploy 说明**：Deno Deploy Free 计划需要绑定信用卡完成组织验证才能使用完整配额，否则只有 1%。代码已就绪，绑卡后即可部署。

## 架构

各出口独立部署，**没有主备关系**。各自在检测到 `Free usage exceeded, subscribe to Go` 限流后，通过平台 Deploy Hook 触发自我重新部署，以获得新的出口 IP。

```
用户（本地 opencodex 配置中手动选择出口）
  ├── Vercel Edge Function
  ├── Cloudflare Workers
  ├── Netlify Edge Functions
  └── Deno Deploy
```

## 部署

### Vercel

1. 在 [Vercel](https://vercel.com) 导入此仓库 — 自动识别 `api/proxy.ts`
2. 设置环境变量 `DEPLOY_HOOK_URL`（Deploy Hook 在 Dashboard → Git → Deploy Hooks 创建）

### Cloudflare Workers

1. 在 Dashboard 创建 Worker，或 `npm install -g wrangler && wrangler deploy`
2. 设置环境变量 `DEPLOY_HOOK_URL`（Deploy Hook 在 Dashboard → Deployments → Create via API 创建）

### Netlify

1. 在 [Netlify](https://netlify.com) 导入此仓库 — 自动识别 `netlify.toml`
2. 设置环境变量 `DEPLOY_HOOK_URL`（Deploy Hook 在 Deploy → Build hooks 创建）

### Deno Deploy

1. 在 [Deno Deploy](https://dash.deno.com) 导入此仓库，入口 `deno/main.ts`
2. 设置环境变量 `DEPLOY_HOOK_URL`（Deploy Hook 在项目 Settings → Deploy Hooks 创建）

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

或

```toml
[model.provider.opencode]
base_url = "https://你的-api-gateway-域名.execute-api.区域.amazonaws.com"
```

或

```toml
[model.provider.opencode]
base_url = "https://你的-deno-域名.deno.dev"
```

## 环境变量

| 变量 | 平台 | 说明 |
|------|------|------|
| `DEPLOY_HOOK_URL` | Vercel / CF Workers / Netlify / Deno | 平台 Deploy Hook URL，触发重新部署 |

## 检测与切换

检测到 HTTP 403/429 且响应体包含 `Free usage exceeded, subscribe to Go` 时：

1. 当前请求正常返回（不中断）
2. 后台异步 POST 到 Deploy Hook URL
3. 平台开始重新部署，新实例从不同节点提供服务
4. 出口 IP 随新部署变化

## 文件结构

```
opencode-proxy/
├── api/
│   └── proxy.ts                  ← Vercel Edge Function 入口
├── cf-workers/
│   └── index.ts                  ← Cloudflare Workers 入口
├── deno/
│   ├── main.ts                   ← Deno Deploy 入口
│   └── deno.json
├── netlify/
│   └── edge-functions/
│       └── proxy.ts              ← Netlify Edge Functions 入口
├── shared/
│   ├── proxy.ts                  ← 共享代理核心
│   ├── detection.ts              ← 限流检测
│   └── redeploy.ts               ← 自我重新部署触发
├── netlify.toml
├── wrangler.toml
├── vercel.json
├── package.json
└── README.md
```