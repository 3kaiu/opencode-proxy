#!/usr/bin/env bash
# scripts/diagnose.sh — 链路延迟诊断: opencode.ai 直连基准 vs ~/.oc 登记端点
# 用法:
#   bash scripts/diagnose.sh           # 单次测量
#   bash scripts/diagnose.sh --warm    # 暖机后再测(排除平台冷启动影响)
set -euo pipefail

CONFIG="${HOME}/.oc/config.json"
WARM=0
[ "${1:-}" = "--warm" ] && WARM=1

if [ -t 1 ]; then
  C_G=$'\033[32m'; C_R=$'\033[31m'; C_Y=$'\033[33m'; C_D=$'\033[2m'; C_0=$'\033[0m'
else
  C_G=""; C_R=""; C_Y=""; C_D=""; C_0=""
fi

# probe <name> <url>  压力一个 GET /zen/v1/models, 打印时间结果
probe() {
  local name="$1" url="$2"
  local stat
  stat=$(curl -sS -o /dev/null --max-time 45 \
    -w 'code=%{http_code} dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total} ip=%{remote_ip}' \
    "$url" 2>/dev/null) || stat="code=000 unreachable"
  printf "  %-16s %s\n" "$name" "$stat"
}

# 拼接探测量 URL: 已带 /zen/v1 或 /v1 则直接 +/models, 否则补 /zen/v1
probe_url() {
  local base="${1%/}"
  case "$base" in
    */zen/v1|*/v1) echo "${base}/models" ;;
    *) echo "${base}/zen/v1/models" ;;
  esac
}

# 根 /health 地址(网关信息用)
health_url() {
  python3 -c "import sys;u=sys.argv[1].rstrip('/');import re;print(u.rsplit('/',1)[0]+'/health' if re.search(r'/(zen/v1|v1)$',u) else u+'/health')" "$1"
}

read_endpoints() {
  python3 - "$CONFIG" <<'PY' 2>/dev/null || true
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
except Exception:
    raise SystemExit
for ep in cfg.get("endpoints", []):
    print(f"{ep.get('name')}\t{ep.get('url')}")
PY
}

onset() { echo "$(date +%H:%M:%S)"; }

echo "${C_D}[*] 时间 $(date '+%F %H:%M:%S') 模式 $([ $WARM -eq 1 ] && echo warm || echo single)${C_0}"
echo

BASE_URL="https://opencode.ai/zen/v1/models"
echo "${C_Y}[1] 基准: 直连 opencode.ai${C_0}"
probe "opencode.ai" "$BASE_URL"
BASE_OUT=$(curl -sS -o /dev/null --max-time 45 -w '%{time_starttransfer}' "$BASE_URL" 2>/dev/null || echo 0)

mapfile -t EPS < <(read_endpoints)
if [ ${#EPS[@]} -eq 0 ]; then
  echo "${C_R}~/.oc/config.json 没有端点, 先 oc add <name> <url>${C_0}"
  exit 1
fi

printf "\n${C_Y}[2] 当前端点${C_0}\n"
for line in "${EPS[@]}"; do
  name="${line%%$'\t'*}"; url="${line#*$'\t'}"
  echo "${C_Y}== $name ($url)${C_0}"
  if [ $WARM -eq 1 ]; then
    curl -sS -o /dev/null --max-time 30 "$(probe_url "$url")" >/dev/null 2>&1 || true
  fi
  probe "$name" "$(probe_url "$url")"
  hurl="$(health_url "$url")"
  hcode=$(curl -sS -o /tmp/diag-health.json --max-time 15 -w '%{http_code}' "$hurl" 2>/dev/null || echo 000)
  if [ "$hcode" = "200" ] && command -v python3 >/dev/null; then
    python3 - /tmp/diag-health.json <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    eps = d.get("endpoints")
    if eps:
        parts = [e["name"] + ("(exhausted)" if e.get("exhausted") else "") for e in eps]
        print(f"    [health] version={d.get('version')} available={d.get('available')}: {', '.join(parts)}")
except Exception:
    pass
PY
  fi
  rm -f "/tmp/hurgh.json$$"
done

printf "\n${C_Y}[3] 解读${C_0}\n"
echo "  ttfb(首字节)对比基准即为多跳新增延迟; code=429/503 可能端点被限流/枯竭"