# opencode-proxy - scriptc adapter

TypeScript → native binary proxy. Compiles to ~200KB, no Node.js runtime needed.

## Build

```bash
# Install scriptc (requires Node ≥20 + clang)
npm install -g scriptc

# Build for current platform
scriptc build proxy.ts -o opencode-proxy

# Cross-compile for Linux ARM64 (requires zig)
SCRIPTC_CC=zigcc SCRIPTC_TARGET=aarch64-linux-gnu.2.36 scriptc build proxy.ts -o opencode-proxy-linux-arm64

# Cross-compile for Linux x86_64
SCRIPTC_CC=zigcc SCRIPTC_TARGET=x86_64-linux-gnu.2.36 scriptc build proxy.ts -o opencode-proxy-linux-x64

# Check coverage (should be 100% static)
scriptc coverage proxy.ts
```

## Deploy to VPS

```bash
# Copy binary to server
scp opencode-proxy-linux-arm64 vps:/usr/local/bin/opencode-proxy

# Create systemd service
ssh vps 'cat > /etc/systemd/system/opencode-proxy.service << EOF
[Unit]
Description=opencode-proxy (scriptc native)
After=network.target

[Service]
ExecStart=/usr/local/bin/opencode-proxy
Restart=always
RestartSec=3
Environment=PORT=8787

[Install]
WantedBy=multi-user.target
EOF'

# Enable and start
ssh vps 'systemctl daemon-reload && systemctl enable --now opencode-proxy'
```

## Why scriptc?

- **Tiny binary**: ~200KB vs 100MB+ Node.js image
- **Fast startup**: ~2.4ms vs ~100ms Node.js
- **Low memory**: 1-4MB RSS vs 30-50MB Node.js
- **No runtime**: No Node.js, npm, or dependencies on the server
- **Dedicated IP**: Exit IP is the VPS's IP, not shared serverless infrastructure

## Limitations

- Experimental (v0.0.17) — but differentially tested against Node.js
- Requires a VPS (Oracle Cloud free tier recommended, but needs CC)
- No auto-scaling or scale-to-zero
