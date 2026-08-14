#!/usr/bin/env bash
# 抓取指定平台端点的完整 429/错误报文（请求头+请求体+响应头+响应体）
# 用法: bash scripts/capture-429.sh <endpoint-url> <label>
set -uo pipefail

URL="${1:?endpoint url}"
LABEL="${2:-$(echo "$URL" | sed -E 's|https?://[^.]*\.([^.]+)\..*|\1|')}"
OUT="/tmp/oc429-${LABEL}"
mkdir -p "$OUT"

TS=$(date +%s)
REQ_BODY='{"model":"deepseek-v4-flash-free","stream":false,"messages":[{"role":"user","content":"hi"}],"max_tokens":2}'

echo "== [$LABEL] $URL" | tee "$OUT/summary.txt"

# curl -v 抓完整头; -D 存响应头; -o 存响应体; -w 存统计
curl -sv -m 60 \
  -X POST "$URL/zen/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Accept: */*" \
  -H "User-Agent: opencode-proxy-analyzer/1.0" \
  -H "Authorization: Bearer x" \
  -d "$REQ_BODY" \
  -D "$OUT/response.headers" \
  -o "$OUT/response.body" \
  -w "code=%{http_code} ttfb=%{time_starttransfer}s total=%{time_total}s dns=%{time_namelookup}s connect=%{time_connect}s\n" \
  2>"$OUT/request.verbose" | tee -a "$OUT/summary.txt"

{
  echo "=== REQUEST (curl verbose) ==="
  cat "$OUT/request.verbose"
  echo
  echo "=== REQUEST BODY ==="
  echo "$REQ_BODY"
  echo
  echo "=== RESPONSE HEADERS ==="
  cat "$OUT/response.headers"
  echo
  echo "=== RESPONSE BODY ==="
  cat "$OUT/response.body"
} >> "$OUT/summary.txt"

echo "saved: $OUT/summary.txt"
