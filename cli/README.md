# oc - proxy switcher CLI

用 [scriptc](https://github.com/vercel-labs/scriptc) 编译的原生二进制，管理 opencode 代理端点。端点列表存储在本地 `~/.oc/config.json`，不存任何凭据。

## 安装

### 方式一：下载预编译二进制（推荐）

推送 `cli/oc.ts` 后 GitHub Actions 会自动构建并发布，直接下载：

```bash
curl -L https://github.com/3kaiu/opencode-proxy/releases/latest/download/oc-darwin-arm64 -o ~/bin/oc && chmod +x ~/bin/oc
```

### 方式二：本地编译

```bash
npm install -g scriptc
scriptc build cli/oc.ts -o /tmp/oc
cp /tmp/oc ~/bin/oc
```

> 注意：本地编译前确认 `~/bin/oc` 不是旧版本——如果行为与源码不符，先重新编译。

## 卸载

```bash
rm ~/bin/oc
rm -rf ~/.oc
```

## 使用

```bash
oc                    # 查看当前端点
oc list               # 列出所有端点
oc add NAME URL       # 添加端点（校验 URL 格式）
oc use NAME           # 切换端点（自动更新 kimi-code 和 opencode 配置）
oc del NAME           # 删除端点
oc test [NAME]        # 测试端点 /models 连通性（不带 NAME 测全部）
oc current            # 查看当前端点
oc completion fish    # 生成 fish 补全
oc help               # 帮助
```

`oc use` / `oc del` 支持大小写不敏感匹配和数字序号（`oc use 1`）。

## 配置更新行为

`oc use NAME` 只替换 baseURL，不会动配置里其他内容：

| 客户端 | 文件 | 更新位置 |
|--------|------|----------|
| Kimi Code | `~/.kimi-code/config.toml` | `[providers.oc]` 的 `base_url` |
| OpenCode | `~/.config/opencode/opencode.json(c)`、`~/.opencode/`、以及从 cwd 向上逐级发现的 `.opencode/` 目录 | `provider.oc.options.baseURL` |

细节：

- OpenCode 配置按 opencode 自身加载优先级处理：全局目录同时存在 `opencode.jsonc` 和 `opencode.json` 时更新 jsonc（后加载、优先级更高）。
- 支持带注释和尾逗号的 jsonc（`//`、`/* */`），解析时自动剥离。
- 如果 agent 未安装，自动跳过；如果已安装但缺少 `oc` 供应商段，自动创建。
- `oc test` 探测 `<baseURL>/models`，显示 HTTP 状态码与耗时。

## 推荐用法

```bash
oc add router https://<your-worker>.workers.dev/zen/v1
oc use router
```

客户端（Kimi Code / OpenCode）只配置一个指向路由器的端点即可。
