#!/bin/bash
cd "$(dirname "$0")"

# Build
npx esbuild worker.ts --bundle --format=esm --target=es2022 --outfile=dist/worker.js --minify

# Deploy with credentials from environment
export CLOUDFLARE_EMAIL=${CLOUDFLARE_EMAIL:-"cf@seei.dev"}
export CLOUDFLARE_API_KEY=${CLOUDFLARE_API_KEY:-""}

if [ -z "$CLOUDFLARE_API_KEY" ]; then
  echo "Error: CLOUDFLARE_API_KEY not set"
  exit 1
fi

# Deploy using wrangler with explicit parameters
npx wrangler deploy dist/worker.js \
  --name oc-router \
  --compatibility-date 2025-07-01 \
  --no-bundle
