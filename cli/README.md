# oc - proxy switcher CLI

用 [scriptc](https://github.com/vercel-labs/scriptc) 编译的原生二进制，管理 opencode.ai 代理端点，支持 Cloudflare Worker 智能路由自动同步。

## 安装

### 方式一：直接下载预编译二进制（推荐）

GitHub Actions 会自动编译，直接下载即可：

```bash
# macOS arm64
curl -L https://github.com/3kaiu/opencode-proxy/releases/latest/download/oc-darwin-arm64 -o ~/bin/oc && chmod +x ~/bin/oc
```

加到 PATH（选你用的 shell）：
```bash
# fish:  fish_add_path ~/bin             >> ~/.config/fish/config.fish
# zsh:   export PATH="$HOME/bin:$PATH"   >> ~/.zshrc
# bash:  export PATH="$HOME/bin:$PATH"   >> ~/.bashrc
```

### 方式二：本地编译

```bash
npm install -g scriptc
scriptc build cli/oc.ts -o cli/oc
cp cli/oc ~/bin/oc
```

## 卸载

```bash
rm ~/bin/oc
rm -rf ~/.oc
```

## 使用

```bash
oc                    # 查看当前端点 + 路由健康状态
oc list               # 列出所有端点
oc add <name> <url>   # 添加端点（自动同步到 CF Worker）
oc use <name>         # 切换端点（同时更新 kimi-code 和 opencode 配置）
oc del <name>         # 删除端点（自动同步到 CF Worker）
oc test [name]        # 测试端点连通性（不带 name 则测试全部）
oc import <file>      # 从文件批量导入（自动同步到 CF Worker）
oc sync               # 手动同步端点列表到 CF Worker
oc status             # 查看 CF 路由健康状态和各端点耗尽情况
oc init ...           # 一次性配置 Cloudflare（不存储凭据）
oc current            # 查看当前端点
oc help               # 帮助
```

## Cloudflare 智能路由

配置 CF 后，`oc add` / `oc del` / `oc import` 会自动将端点列表同步到 CF Worker Secret，无需手动操作。

### 初始化

```bash
oc init <worker-url> <account-id> <kv-namespace-id>

# 示例
oc init https://<your-worker>.workers.dev <account-id> <kv-namespace-id>
```

参数说明：
- `worker-url`：Worker 的公网 URL（不含路径）
- `account-id`：Dashboard URL 中的 hex ID
- `kv-namespace-id`：用 `wrangler kv namespace create ENDPOINT_STATE` 创建后得到的 id

### 认证（oc 不存储任何凭据）

二选一：

```bash
# 方式一：环境变量（推荐，直接调 CF API）
export CLOUDFLARE_API_TOKEN="..."

# 方式二：wrangler OAuth（浏览器授权，wrangler 自己管 token）
wrangler login
```

### 工作流程

```
oc add myproxy https://...   →  本地保存 + 自动推送到 CF Worker Secret
oc del myproxy               →  本地删除 + 自动推送到 CF Worker Secret
oc                           →  显示当前端点 + 路由可用/耗尽摘要
oc status                    →  查询 CF Worker /health，显示各端点耗尽状态
```

同步时自动排除 `worker-url` 自身，防止循环路由。

### 推荐用法

客户端（Kimi Code / OpenCode）只配置一个端点指向 CF Worker：

```bash
oc use cf-router
```

CF Worker 内部自动轮转所有上游端点，碰到 429 限流自动标记耗尽并切换，客户端无感。

## 配置文件

| 文件 | 用途 |
|------|------|
| `~/.oc/config.json` | oc 自身配置（端点列表 + 当前选择 + CF 非敏感配置） |
| `~/.kimi-code/config.toml` | Kimi Code - 更新 `[providers.oc]` 的 `base_url` |
| `~/.config/opencode/opencode.json` | OpenCode - 更新 `provider.oc` 的 `baseURL` |

`~/.oc/config.json` 不存储任何 API Key 或凭据。CF 认证通过环境变量或 wrangler OAuth 完成。

## 前置条件

两个配置文件中需要已有名为 `oc` 的供应商段，例如：

**Kimi Code** (`~/.kimi-code/config.toml`):
```toml
[providers.oc]
type = "openai"
base_url = "https://<your-worker>.workers.dev/zen/v1"
```

**OpenCode** (`~/.config/opencode/opencode.json`):
```json
{
  "provider": {
    "oc": {
      "models": { "deepseek-v4-flash-free": { "name": "deepseek-v4-flash-free" } },
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "apiKey": "",
        "baseURL": "https://<your-worker>.workers.dev/zen/v1"
      }
    }
  }
}
```

`oc use` 只替换 `base_url` / `baseURL` 的值，不会创建或删除供应商段。
