#!/bin/bash
# proxy-switch.sh - 快速切换 Kimi Code / OpenCode 代理 base URL
#
# 用法:
#   ./proxy-switch.sh          # 交互选择端点
#   ./proxy-switch.sh 3        # 直接选第 3 个
#   ./proxy-switch.sh --test   # 测试所有端点延迟
#   ./proxy-switch.sh --list   # 列出所有端点

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENDPOINTS_FILE="$SCRIPT_DIR/endpoints.txt"
KIMI_CONFIG="$HOME/.kimi-code/config.toml"
OPENCODE_CONFIG="$HOME/.config/opencode/opencode.json"

# config.toml 里要改的 provider 名
KIMI_PROVIDER="opencode"
# opencode.json 里要改的 provider 名
OPENCODE_PROVIDER="opencode-proxy"

G='\033[0;32m' C='\033[0;36m' Y='\033[1;33m' R='\033[0;31m' N='\033[0m'

# ── 加载端点 ──────────────────────────────────────────────
load_endpoints() {
  NAMES=(); URLS=()
  if [[ ! -f "$ENDPOINTS_FILE" ]]; then
    echo -e "${R}找不到 $ENDPOINTS_FILE${N}"; exit 1
  fi
  while IFS='|' read -r name url; do
    if [[ -z "$name" || "$name" == \#* ]]; then continue; fi
    if [[ -z "$url" ]]; then continue; fi
    NAMES+=("$name"); URLS+=("$url")
  done < "$ENDPOINTS_FILE"
  if [[ ${#NAMES[@]} -eq 0 ]]; then
    echo -e "${R}endpoints.txt 里没有端点${N}"; exit 1
  fi
}

# ── 更新 Kimi Code ────────────────────────────────────────
update_kimi() {
  local url="$1"
  if [[ ! -f "$KIMI_CONFIG" ]]; then
    echo -e "  ${Y}⚠${N} Kimi Code config.toml 不存在"; return
  fi
  local tmp; tmp=$(mktemp)
  awk -v new_url="$url" -v p="$KIMI_PROVIDER" '
    $0 ~ "^\\[providers\\." p "\\]" { in_sec=1; print; next }
    /^\[/ { in_sec=0 }
    in_sec && /^base_url[[:space:]]*=/ { print "base_url = \"" new_url "\""; next }
    { print }
  ' "$KIMI_CONFIG" > "$tmp"
  mv "$tmp" "$KIMI_CONFIG"
  echo -e "  ${G}✓${N} Kimi Code  -> providers.$KIMI_PROVIDER"
}

# ── 更新 OpenCode ─────────────────────────────────────────
update_opencode() {
  local url="$1"
  if [[ ! -f "$OPENCODE_CONFIG" ]]; then
    echo -e "  ${Y}⚠${N} OpenCode opencode.json 不存在"; return
  fi
  if command -v jq &>/dev/null; then
    local tmp; tmp=$(mktemp)
    jq --arg url "$url" --arg p "$OPENCODE_PROVIDER" \
      '.provider[$p].options.baseURL = $url' \
      "$OPENCODE_CONFIG" > "$tmp"
    mv "$tmp" "$OPENCODE_CONFIG"
  else
    python3 -c "
import json
with open('$OPENCODE_CONFIG') as f: cfg = json.load(f)
cfg.setdefault('provider', {}).setdefault('$OPENCODE_PROVIDER', {}).setdefault('options', {})['baseURL'] = '$url'
with open('$OPENCODE_CONFIG', 'w') as f: json.dump(cfg, f, indent=2, ensure_ascii=False)
"
  fi
  echo -e "  ${G}✓${N} OpenCode  -> provider.$OPENCODE_PROVIDER"
}

# ── 测试端点 ──────────────────────────────────────────────
test_endpoints() {
  echo -e "${C}测试所有端点 (curl /models, 超时 5s)...${N}"
  echo ""
  for i in "${!NAMES[@]}"; do
    local name="${NAMES[$i]}" url="${URLS[$i]}"
    printf "  %-12s " "$name"
    local t0 t1 code
    t0=$(python3 -c 'import time; print(time.time())')
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${url}/models" 2>/dev/null || echo "000")
    t1=$(python3 -c 'import time; print(time.time())')
    local ms; ms=$(python3 -c "print(int(($t1-$t0)*1000))")
    if [[ "$code" == "200" ]]; then
      echo -e "${G}✓ ${code}${N}  ${ms}ms"
    else
      echo -e "${R}✗ ${code}${N}  ${ms}ms"
    fi
  done
}

# ── 列出端点 ──────────────────────────────────────────────
list_endpoints() {
  for i in "${!NAMES[@]}"; do
    echo -e "  $((i+1)). ${C}${NAMES[$i]}${N}"
    echo -e "     ${Y}${URLS[$i]}${N}"
  done
}

# ── 交互选择 ──────────────────────────────────────────────
pick_endpoint() {
  if [[ -n "${1:-}" ]] && [[ "$1" =~ ^[0-9]+$ ]]; then
    local idx=$(( $1 - 1 ))
    if (( idx < 0 || idx >= ${#NAMES[@]} )); then
      echo -e "${R}无效序号${N}"; exit 1
    fi
    SELECTED_NAME="${NAMES[$idx]}"
    SELECTED_URL="${URLS[$idx]}"
    return
  fi
  echo -e "${C}═══ 代理端点切换 ═══${N}"
  echo ""
  list_endpoints
  echo ""
  read -rp "选择 [1-${#NAMES[@]}] (回车跳过): " choice
  if [[ -z "$choice" ]]; then
    echo "未选择，退出"; exit 0
  fi
  if ! [[ "$choice" =~ ^[0-9]+$ ]] || (( choice < 1 || choice > ${#NAMES[@]} )); then
    echo -e "${R}无效选择${N}"; exit 1
  fi
  local idx=$(( choice - 1 ))
  SELECTED_NAME="${NAMES[$idx]}"
  SELECTED_URL="${URLS[$idx]}"
}

# ── main ──────────────────────────────────────────────────
load_endpoints

case "${1:-}" in
  --test)  test_endpoints; exit 0 ;;
  --list)  list_endpoints; exit 0 ;;
  *)       pick_endpoint "${1:-}" ;;
esac

echo ""
echo -e "切换到: ${G}${SELECTED_NAME}${N}"
echo -e "URL:    ${Y}${SELECTED_URL}${N}"
echo ""
update_kimi   "$SELECTED_URL"
update_opencode "$SELECTED_URL"
echo ""
echo -e "${G}Done.${N} 现在可以用 kimi / opencode 正常访问了。"
