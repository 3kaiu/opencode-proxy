# opencode-proxy

Vercel Edge Function + Deno Deploy 双出口代理，用于 opencode.ai API 的流量代理和出口 IP 自动切换。

## 架构

两个独立部署，没有主备关系：

- **Vercel** — 部署为 Edge Function，域名 `proxy.vercel.app`
- **Deno Deploy** — 部署在 Deno 平台，域名 `proxy.deno.dev`

各自在检测到 `Free usage exceeded, subscribe to Go` 限流后，通过平台 Deploy Hook 触发自我重新部署，以获得新的出口 IP。

## 部署

### Vercel

1. 在 [Vercel](https://vercel.com) 导入此仓库
2. 项目设置 → Git → Deploy Hooks → 创建 Hook
3. 复制 Hook URL，设为环境变量 `VERCEL_DEPLOY_HOOK_URL`
4. 部署

### Deno Deploy

1. 在 [Deno Deploy](https://dash.deno.com) 创建项目
2. 入口文件设为 `deno/main.ts`
3. 项目设置 → Deploy Hooks → 创建 Hook
4. 复制 Hook URL，设为环境变量 `DENO_DEPLOY_HOOK_URL`
5. 部署

## 本地配置

在 opencode 的 `config.toml` 中配置代理：

```toml
[model.provider.opencode]
base_url = "https://你的-vercel-域名.vercel.app"
```

## 环境变量

| 变量 | 平台 | 说明 |
|------|------|------|
| `VERCEL_DEPLOY_HOOK_URL` | Vercel | Vercel Deploy Hook URL，触发重新部署 |
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
│   └── proxy.ts          ← Vercel Edge Function 入口
├── deno/
│   ├── main.ts           ← Deno Deploy 入口
│   └── deno.json
├── shared/
│   ├── proxy.ts          ← 共享代理核心
│   ├── detection.ts      ← 限流检测
│   └── redeploy.ts       ← 自我重新部署触发
├── vercel.json
├── package.json
└── CHANGELOG.md
```