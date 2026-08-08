#!/bin/bash
cd "$(dirname "$0")"
npx esbuild worker.ts --bundle --format=esm --target=es2022 --outfile=dist/worker.js --minify
