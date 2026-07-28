# opencode-proxy

Reverse proxy for [opencode.ai](https://opencode.ai) zen endpoint. Deployed across multiple free serverless/edge platforms to rotate exit IPs and bypass Cloudflare same-site filtering.

## Why?

opencode.ai is behind Cloudflare. If you proxy requests from Cloudflare Workers, the request is blocked (same-site). By deploying on platforms with different exit IPs (AWS, Google, Akamai), requests go through cleanly.

## Platforms

| Platform | Free Tier | Exit IP | CC Required | Status |
|----------|-----------|---------|-------------|--------|
| **Val Town** | 100K/day | AWS | No | ✅ Deployed |
| **Supabase** | 500K/month | AWS | No | ✅ Deployed |
| **Vercel** | 1M/month | AWS | No | ⏳ Import repo at vercel.com |
| **Deno Deploy** | 1M/month | Google | No | ⏳ Link repo at console.deno.com |
| **Fermyon Cloud** | 100K/month, 500 req/hr | Akamai | No | ⏳ `cd fermyon && npm i && spin deploy` |
| **Render** | 750 hrs/month | AWS | No | ⏳ render.com -> Blueprint -> import repo |
| **scriptc** | ∞ (needs VPS) | VPS IP | VPS dependent | 📦 Backup: compile to native binary |

## Quick Deploy

### Val Town (fastest)
1. Go to [val.town](https://val.town) → New Val → HTTP
2. Paste contents of `valtown/proxy.ts`
3. Your endpoint: `https://<username>-<val-id>.web.val.run/zen/v1`

### Supabase
1. Go to [supabase.com](https://supabase.com) → New Project
2. Edge Functions → Deploy → paste `supabase/functions/proxy/index.ts`
3. Your endpoint: `https://<project-ref>.supabase.co/functions/v1/proxy/zen/v1`

### Vercel
1. Go to [vercel.com](https://vercel.com) → Import `3kaiu/opencode-proxy`
2. Auto-detected: Edge Function at `api/proxy.ts`
3. Your endpoint: `https://<project>.vercel.app/zen/v1`

### Deno Deploy
1. Go to [console.deno.com](https://console.deno.com) → New Project → Link `3kaiu/opencode-proxy`
2. Entrypoint: `deno/main.ts`
3. Your endpoint: `https://<project>.deno.dev/zen/v1`

### Fermyon Cloud
```bash
cd fermyon
npm install
spin plugins install cloud  # one-time
spin login                   # GitHub OAuth
spin deploy
```
Endpoint: `https://opencode-proxy-<hash>.fermyon.app/zen/v1`

### Render
1. Go to [render.com](https://render.com) → New → Blueprint
2. Connect `3kaiu/opencode-proxy` repo
3. Auto-detected from `render/render.yaml`
4. Your endpoint: `https://opencode-proxy.onrender.com/zen/v1`

### scriptc (native binary, needs VPS)
```bash
npm i -g scriptc
scriptc build scriptc/proxy.ts -o opencode-proxy
./opencode-proxy  # listens on :8787
```

## Usage

```bash
# List models
curl https://<your-proxy-endpoint>/zen/v1/models

# Chat completion (free model, no API key needed)
curl https://<your-proxy-endpoint>/zen/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-free",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Free Models (no API key)

- `deepseek-v4-flash-free`
- `mimo-v2.5-free`
- `ling-3.0-flash-free`
- `nemotron-3-ultra-free`
- `north-mini-code-free`
- `laguna-s-2.1-free`

## Architecture

```
shared/
  proxy.ts       # Core: handlePreflight + proxyToOpenCode
  detection.ts   # Rate-limit detection (403/429 → trigger redeploy)
  redeploy.ts    # Self-redeploy via deploy hooks

api/proxy.ts           # Vercel Edge (standalone)
valtown/proxy.ts       # Val Town (standalone)
supabase/.../index.ts  # Supabase Edge (standalone)
deno/main.ts           # Deno Deploy (imports shared/)
netlify/.../proxy.ts   # Netlify Edge (standalone)
fermyon/src/index.ts   # Fermyon Spin WASM (standalone)
render/server.js       # Render Docker/Node.js (standalone)
scriptc/proxy.ts       # scriptc native binary (standalone)
```

## License

MIT
