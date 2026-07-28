// build.mjs
import { build } from 'esbuild';
import { SpinEsbuildPlugin } from "@spinframework/build-tools/plugins/esbuild";

const debug = process.argv.includes('--debug');

await build({
    entryPoints: ['./src/index.ts'],
    outfile: './build/bundle.js',
    bundle: true,
    format: 'esm',
    platform: 'browser',
    sourcemap: true,
    minify: true,
    loader: {
        '.ts': 'ts',
        '.tsx': 'tsx',
    },
    resolveExtensions: ['.ts', '.tsx', '.js'],
    plugins: [await SpinEsbuildPlugin({
        componentize: {
            debug,
            output: './dist/opencode-proxy.wasm',
            initLocation: 'http://test-deps.localhost',
        }
    })],
});
