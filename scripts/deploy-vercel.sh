#!/bin/bash
# 批量部署到多个 Vercel oc-proxy 项目（平台出口矩阵扩容用）
# 用法: VERCEL_TOKEN=<token> TEAM_ID=<team> [PROJECTS="v4 v5 ..."] ./scripts/deploy-vercel.sh
# 项目名生成: oc-proxy-$v，文件取构建产物 api/proxy.js + vercel.json
set -e
cd "$(dirname "$0")/.."

TOKEN="${VERCEL_TOKEN:?VERCEL_TOKEN 未设置}"
TEAM="${VERCEL_TEAM_ID:-}"
PROJECTS="${PROJECTS:-v4 v5 v6 v7 v8 v9 v10 v11 v12 v13}"

if [ ! -f api/proxy.js ]; then
  echo "缺少构建产物 api/proxy.js，先运行: node scripts/build.mjs" >&2
  exit 1
fi

for v in $PROJECTS; do
  echo "=== Deploying oc-proxy-$v ==="
  python3 -c "
import json
files = [
  {'file': 'api/proxy.js', 'data': open('api/proxy.js').read()},
  {'file': 'vercel.json', 'data': open('vercel.json').read()}
]
print(json.dumps({'name':'oc-proxy-$v','files':files,'target':'production'}))
" > /tmp/vercel_deploy_tmp.json

  URL="https://api.vercel.com/v13/deployments"
  [ -n "$TEAM" ] && URL="$URL?teamId=$TEAM"
  RESULT=$(curl -s "$URL" -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d @/tmp/vercel_deploy_tmp.json)
  ID=$(echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id') or d.get('error',{}).get('message',''))" 2>/dev/null)
  echo "  deployment: $ID"
  sleep 1
done
echo "Done."