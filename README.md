# opencode-proxy

多出口代理，用于 opencode.ai API 的流量代理和出口 IP 自动切换。

| 出口 | 平台 | 类型 | 状态 | 入口 |
|------|------|------|------|------|
| **Vercel** | Vercel Edge Function | Edge | ✅ 可用 | `api/proxy.ts` |
| **Cloudflare Workers** | Cloudflare Workers | Edge | ✅ 可用 | `cf-workers/index.ts` |
| **Netlify** | Netlify Edge Functions | Edge | ✅ 可用 | `netlify/edge-functions/proxy.ts` |
| **AWS Lambda** | Lambda + API Gateway | Serverless | ✅ 可用 | `aws-lambda/index.ts` |
| **Deno Deploy** | Deno Deploy | Edge | ✅ 可用（需绑卡验证） | `deno/main.ts` |

> **Deno Deploy 说明**：Deno Deploy Free 计划需要绑定信用卡完成组织验证才能使用完整配额，否则只有 1%。代码已就绪，绑卡后即可部署。

## 架构

各出口独立部署，**没有主备关系**。各自在检测到 `Free usage exceeded, subscribe to Go` 限流后，通过平台 Deploy Hook 触发自我重新部署，以获得新的出口 IP。

```
用户（本地 opencodex 配置中手动选择出口）
  ├── Vercel Edge Function
  ├── Cloudflare Workers
  ├── Netlify Edge Functions
  ├── AWS Lambda + API Gateway
  └── Deno Deploy
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

### Netlify

1. 在 [Netlify](https://netlify.com) 导入此仓库
2. 部署会自动识别 `netlify.toml` 和 `netlify/edge-functions/proxy.ts`
3. 设置环境变量 `DEPLOY_HOOK_URL`
4. 创建 Deploy Hook：Deploy → Deploy settings → Build hooks → Add build hook
5. 将生成的 Hook URL 设为 `DEPLOY_HOOK_URL` 的值

### AWS Lambda + API Gateway

1. 编译 TypeScript 并打包：
   ```bash
   npx tsc aws-lambda/index.ts --outDir dist --module commonjs --target es2022
   cd dist && zip -r ../lambda.zip .
   ```
2. 在 AWS Console 创建 Lambda 函数（Node.js 20），上传 `lambda.zip`
3. 创建 API Gateway（HTTP API 或 REST API），将全部请求路由到 Lambda
4. 出口 IP 由 AWS 自动分配，自动变化，无需手动触发重建

### Deno Deploy

1. 在 [Deno Deploy](https://dash.deno.com) 创建项目
2. 入口文件设为 `deno/main.ts`
3. 项目设置 → Deploy Hooks → 创建 Hook
4. 复制 Hook URL，设为环境变量 `DEPLOY_HOOK_URL`
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
├── aws-lambda/
│   └── index.ts                  ← AWS Lambda + API Gateway 入口
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