# oc - proxy switcher CLI

用 [scriptc](https://github.com/vercel-labs/scriptc) 编译的原生二进制，一键切换 Kimi Code 和 OpenCode 的代理端点。

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
oc                    # 查看当前端点
oc list               # 列出所有端点
oc add <name> <url>   # 添加端点
oc use <name>         # 切换端点（同时更新 kimi-code 和 opencode 配置）
oc del <name>         # 删除端点
oc test [name]        # 测试端点连通性（不带 name 则测试全部）
oc import <file>      # 从文件批量导入（每行 name|url）
oc current            # 查看当前端点
oc help               # 帮助
```

## 配置文件

| 文件 | 用途 |
|------|------|
| `~/.oc/config.json` | oc 自身配置（端点列表 + 当前选择） |
| `~/.kimi-code/config.toml` | Kimi Code - 更新 `[providers.oc]` 的 `base_url` |
| `~/.config/opencode/opencode.json` | OpenCode - 更新 `provider.oc` 的 `baseURL` |

## 前置条件

两个配置文件中需要已有名为 `oc` 的供应商段，例如：

**Kimi Code** (`~/.kimi-code/config.toml`):
```toml
[providers.oc]
type = "openai"
base_url = "https://your-proxy.example.com/zen/v1"
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
        "baseURL": "https://your-proxy.example.com/zen/v1"
      }
    }
  }
}
```

`oc use` 只替换 `base_url` / `baseURL` 的值，不会创建或删除供应商段。
