// oc.ts - opencode proxy switcher CLI
// Build: scriptc build cli/oc.ts -o cli/oc
//
// 端点列表存储在 Cloudflare KV（key: "endpoints"），本地不存端点
// oc 通过 CF API 或 wrangler 读写 KV
//
// Usage:
//   oc                    Show current endpoint + router status
//   oc list               List all endpoints (from CF KV)
//   oc add <name> <url>   Add an endpoint to CF KV
//   oc use <name>         Switch client configs to an endpoint
//   oc del <name>         Delete an endpoint from CF KV
//   oc test [name]        Test endpoint(s) latency
//   oc import <file>      Import from file to CF KV
//   oc status             Show CF router health & exhaustion
//   oc cf-init ...        One-time Cloudflare config
//   oc current            Show current endpoint
//   oc help               Show this help
//
// Config:  ~/.oc/config.json  (仅存 CF 连接信息 + 当前选择，不存端点)
// Kimi:    ~/.kimi-code/config.toml        [providers.oc] base_url
// OpenCode: ~/.config/opencode/opencode.jsonc  provider.oc.baseURL
//
// CF Auth (二选一，oc 不存储任何凭据):
//   1. export CLOUDFLARE_API_TOKEN="..."   (环境变量，推荐)
//   2. wrangler login                      (OAuth，wrangler 自己管 token)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

// ── Paths ───────────────────────────────────────────────
const HOME = homedir();
const CONFIG_DIR = HOME + "/.oc";
const CONFIG_FILE = CONFIG_DIR + "/config.json";
const KIMI_CONFIG = HOME + "/.kimi-code/config.toml";
const OPENCODE_CONFIG = HOME + "/.config/opencode/opencode.jsonc";
const KIMI_PROVIDER = "oc";
const OPENCODE_PROVIDER = "oc";
const KV_KEY_ENDPOINTS = "endpoints";

// ── Types ───────────────────────────────────────────────
interface Endpoint {
  name: string;
  url: string;
}

interface CloudflareConfig {
  workerUrl: string;
  accountId: string;
  kvNamespaceId: string;
  workerName: string;
  cloudflareDir: string;
}

interface OcConfig {
  current: string | null;
  cloudflare?: CloudflareConfig;
}

// ── HTTP via curl (static-compatible, no fetch needed) ──
interface CurlResult {
  status: number;
  body: string;
}

function curlGet(url: string, headers: string[], timeoutMs: number): CurlResult {
  const headerArgs: string[] = [];
  for (let i = 0; i < headers.length; i++) {
    headerArgs.push("-H");
    headerArgs.push(headers[i]);
  }
  const args = ["-s", "-w", "\\n%{http_code}", "--max-time", String(timeoutMs / 1000)];
  for (let i = 0; i < headerArgs.length; i++) {
    args.push(headerArgs[i]);
  }
  args.push(url);
  const cmd = "curl " + args.map((a) => "'" + a.replace(/'/g, "'\\''") + "'").join(" ");
  try {
    const out = execSync(cmd, { timeout: timeoutMs + 2000, stdio: ["pipe", "pipe", "pipe"] }).toString();
    const lastNl = out.lastIndexOf("\n");
    const statusStr = out.slice(lastNl + 1).trim();
    const body = out.slice(0, lastNl);
    const status = parseInt(statusStr, 10);
    return { status: isNaN(status) ? 0 : status, body };
  } catch {
    return { status: 0, body: "" };
  }
}

function curlPut(url: string, headers: string[], body: string, timeoutMs: number): CurlResult {
  const headerArgs: string[] = [];
  for (let i = 0; i < headers.length; i++) {
    headerArgs.push("-H");
    headerArgs.push(headers[i]);
  }
  const args = ["-s", "-w", "\\n%{http_code}", "-X", "PUT", "--max-time", String(timeoutMs / 1000)];
  for (let i = 0; i < headerArgs.length; i++) {
    args.push(headerArgs[i]);
  }
  args.push("-d");
  args.push("@-");
  args.push(url);
  const cmd = "curl " + args.map((a) => "'" + a.replace(/'/g, "'\\''") + "'").join(" ");
  try {
    const out = execSync(cmd, {
      input: body,
      timeout: timeoutMs + 2000,
      stdio: ["pipe", "pipe", "pipe"],
    }).toString();
    const lastNl = out.lastIndexOf("\n");
    const statusStr = out.slice(lastNl + 1).trim();
    const respBody = out.slice(0, lastNl);
    const status = parseInt(statusStr, 10);
    return { status: isNaN(status) ? 0 : status, body: respBody };
  } catch {
    return { status: 0, body: "" };
  }
}

// ── Config I/O ──────────────────────────────────────────
function loadConfig(): OcConfig {
  if (!existsSync(CONFIG_FILE)) {
    return { current: null };
  }
  try {
    const raw = readFileSync(CONFIG_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      const current = typeof obj.current === "string" ? obj.current : null;
      const cf = obj.cloudflare;
      if (typeof cf === "object" && cf !== null) {
        const cfObj = cf as Record<string, unknown>;
        return {
          current,
          cloudflare: {
            workerUrl: String(cfObj.workerUrl || ""),
            accountId: String(cfObj.accountId || ""),
            kvNamespaceId: String(cfObj.kvNamespaceId || ""),
            workerName: String(cfObj.workerName || ""),
            cloudflareDir: String(cfObj.cloudflareDir || ""),
          },
        };
      }
      return { current };
    }
    return { current: null };
  } catch {
    return { current: null };
  }
}

function saveConfig(cfg: OcConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
}

function requireCf(cfg: OcConfig): CloudflareConfig {
  if (!cfg.cloudflare) {
    console.log("Cloudflare not configured. Run: oc cf-init");
    process.exit(1);
  }
  return cfg.cloudflare;
}

// ── CF KV 读写 ──────────────────────────────────────────
async function kvGet(cf: CloudflareConfig, key: string): Promise<string | null> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (token) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/storage/kv/namespaces/${cf.kvNamespaceId}/values/${key}`;
    const res = curlGet(url, [`Authorization: Bearer ${token}`], 10_000);
    if (res.status === 404) return null;
    if (res.status >= 200 && res.status < 300) return res.body;
    // fall through to wrangler
  }
  try {
    const out = execSync(`wrangler kv key get ${key}`, {
      cwd: cf.cloudflareDir,
      timeout: 15_000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: cf.accountId },
    }).toString();
    return out.trim() || null;
  } catch {
    return null;
  }
}

async function kvPut(cf: CloudflareConfig, key: string, value: string): Promise<boolean> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (token) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/storage/kv/namespaces/${cf.kvNamespaceId}/values/${key}`;
    const res = curlPut(url, [`Authorization: Bearer ${token}`, "Content-Type: text/plain"], value, 10_000);
    if (res.status >= 200 && res.status < 300) return true;
  }
  try {
    execSync(`wrangler kv key put ${key}`, {
      cwd: cf.cloudflareDir,
      input: value,
      timeout: 15_000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: cf.accountId },
    });
    return true;
  } catch {
    return false;
  }
}

async function loadEndpoints(cf: CloudflareConfig): Promise<Endpoint[]> {
  const raw = await kvGet(cf, KV_KEY_ENDPOINTS);
  if (!raw) {
    const empty: Endpoint[] = [];
    return empty;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const result: Endpoint[] = [];
      for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i];
        if (typeof item === "object" && item !== null) {
          const obj = item as Record<string, unknown>;
          if (typeof obj.name === "string" && typeof obj.url === "string") {
            result.push({ name: obj.name, url: obj.url });
          }
        }
      }
      return result;
    }
    const empty: Endpoint[] = [];
    return empty;
  } catch {
    const empty: Endpoint[] = [];
    return empty;
  }
}

async function saveEndpoints(cf: CloudflareConfig, endpoints: Endpoint[]): Promise<void> {
  const ok = await kvPut(cf, KV_KEY_ENDPOINTS, JSON.stringify(endpoints));
  if (ok) {
    console.log(`  ✓ CF KV synced (${endpoints.length} endpoints)`);
  } else {
    console.log("  ✗ CF KV write failed. Set CLOUDFLARE_API_TOKEN or run: wrangler login");
    process.exit(1);
  }
}

function findEndpoint(endpoints: Endpoint[], name: string): Endpoint | null {
  for (let i = 0; i < endpoints.length; i++) {
    if (endpoints[i].name === name) return endpoints[i];
  }
  const lower = name.toLowerCase();
  for (let i = 0; i < endpoints.length; i++) {
    if (endpoints[i].name.toLowerCase() === lower) return endpoints[i];
  }
  const idx = parseInt(name, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= endpoints.length) {
    return endpoints[idx - 1];
  }
  return null;
}

// ── Update Kimi Code config.toml ────────────────────────
function updateKimi(url: string): void {
  if (!existsSync(KIMI_CONFIG)) {
    console.log("  ⚠ Kimi Code config.toml not found");
    return;
  }
  const content = readFileSync(KIMI_CONFIG, "utf8");
  const lines = content.split("\n");
  const header = "[providers." + KIMI_PROVIDER + "]";
  let inSec = false;
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === header) { inSec = true; continue; }
    if (line.startsWith("[") && inSec) { inSec = false; break; }
    if (inSec && /^base_url\s*=/.test(line)) {
      lines[i] = 'base_url = "' + url + '"';
      found = true;
      break;
    }
  }

  if (found) {
    writeFileSync(KIMI_CONFIG, lines.join("\n"));
    console.log("  ✓ Kimi Code  -> providers." + KIMI_PROVIDER);
  } else {
    console.log("  ⚠ base_url not found in [providers." + KIMI_PROVIDER + "]");
  }
}

// ── Update OpenCode opencode.jsonc ───────────────────────
function updateOpenCode(url: string): void {
  if (!existsSync(OPENCODE_CONFIG)) {
    console.log("  ⚠ OpenCode opencode.jsonc not found");
    return;
  }
  let json: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(OPENCODE_CONFIG, "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      json = parsed as Record<string, unknown>;
    } else {
      console.log("  ⚠ opencode.jsonc is not valid JSON object");
      return;
    }
  } catch {
    console.log("  ⚠ opencode.jsonc is not valid JSON");
    return;
  }

  const providerObj = json.provider;
  if (typeof providerObj !== "object" || providerObj === null) {
    console.log(`  ⚠ Provider "${OPENCODE_PROVIDER}" not found in opencode.jsonc`);
    return;
  }
  const providers = providerObj as Record<string, unknown>;
  const provider = providers[OPENCODE_PROVIDER];
  if (typeof provider !== "object" || provider === null) {
    console.log(`  ⚠ Provider "${OPENCODE_PROVIDER}" not found in opencode.jsonc`);
    return;
  }

  const prov = provider as Record<string, unknown>;
  const options = prov.options;
  if (typeof options === "object" && options !== null) {
    const opts = options as Record<string, unknown>;
    if (typeof opts.baseURL === "string") {
      opts.baseURL = url;
      writeFileSync(OPENCODE_CONFIG, JSON.stringify(json, null, 2) + "\n");
      console.log("  ✓ OpenCode  -> provider." + OPENCODE_PROVIDER);
      return;
    }
  }
  if (typeof prov.baseURL === "string") {
    prov.baseURL = url;
    writeFileSync(OPENCODE_CONFIG, JSON.stringify(json, null, 2) + "\n");
    console.log("  ✓ OpenCode  -> provider." + OPENCODE_PROVIDER);
    return;
  }
  console.log(`  ⚠ baseURL not found in provider "${OPENCODE_PROVIDER}"`);
}

// ── Commands ────────────────────────────────────────────

async function cmdCurrent(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.current) {
    console.log("No endpoint selected. Use: oc use <name>");
    return;
  }
  const cf = requireCf(cfg);
  const endpoints = await loadEndpoints(cf);
  const ep = findEndpoint(endpoints, cfg.current);

  if (!ep && cfg.current === "cf-router") {
    console.log("Current: cf-router");
    console.log("URL:     " + cf.workerUrl + "/zen/v1");
  } else if (!ep) {
    console.log(`Current endpoint "${cfg.current}" not found in CF KV.`);
    return;
  } else {
    console.log("Current: " + ep.name);
    console.log("URL:     " + ep.url);
  }

  try {
    const res = curlGet(cf.workerUrl + "/health", [], 3000);
    if (res.status === 200 && res.body.length > 0) {
      const parsed: unknown = JSON.parse(res.body);
      if (typeof parsed === "object" && parsed !== null) {
        const data = parsed as Record<string, unknown>;
        const available = data.available;
        const epsRaw = data.endpoints;
        if (Array.isArray(epsRaw)) {
          const exhausted: string[] = [];
          for (let i = 0; i < epsRaw.length; i++) {
            const e = epsRaw[i];
            if (typeof e === "object" && e !== null) {
              const epObj = e as Record<string, unknown>;
              if (epObj.exhausted === true && typeof epObj.name === "string") {
                exhausted.push(epObj.name);
              }
            }
          }
          if (exhausted.length === 0) {
            console.log(`Router:  ${available} ✓`);
          } else {
            const names = exhausted.join(", ");
            console.log(`Router:  ${available}  ✗ ${names}`);
          }
        }
      }
    }
  } catch {
    // 路由不可达时不干扰输出
  }
}

async function cmdList(): Promise<void> {
  const cfg = loadConfig();
  const cf = requireCf(cfg);
  const endpoints = await loadEndpoints(cf);
  if (endpoints.length === 0) {
    console.log("No endpoints in CF KV. Use: oc add <name> <url>");
    return;
  }
  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    const marker = ep.name === cfg.current ? " ←" : "";
    console.log(`  ${i + 1}. ${ep.name}${marker}`);
    console.log("     " + ep.url);
  }
}

async function cmdAdd(args: string[]): Promise<void> {
  if (args.length < 2) {
    console.log("Usage: oc add <name> <url>");
    return;
  }
  const name = args[0];
  const url = args[1];
  const cfg = loadConfig();
  const cf = requireCf(cfg);
  const endpoints = await loadEndpoints(cf);
  if (findEndpoint(endpoints, name)) {
    console.log(`Endpoint "${name}" already exists.`);
    return;
  }
  endpoints.push({ name, url });
  await saveEndpoints(cf, endpoints);
  console.log("✓ Added: " + name + " -> " + url);
}

async function cmdUse(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.log("Usage: oc use <name>");
    return;
  }
  const name = args.join(" ");
  const cfg = loadConfig();
  const cf = requireCf(cfg);

  let url: string;
  if (name === "cf-router") {
    url = cf.workerUrl + "/zen/v1";
  } else {
    const endpoints = await loadEndpoints(cf);
    const ep = findEndpoint(endpoints, name);
    if (!ep) {
      console.log(`Endpoint "${name}" not found. Run "oc list" to see options.`);
      process.exit(1);
    }
    url = ep.url;
  }

  console.log("Switching to: " + name);
  console.log("URL:          " + url);
  console.log("");
  updateKimi(url);
  updateOpenCode(url);
  cfg.current = name;
  saveConfig(cfg);
  console.log("");
  console.log("✓ Done.");
}

async function cmdDel(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.log("Usage: oc del <name>");
    return;
  }
  const name = args.join(" ");
  const cfg = loadConfig();
  const cf = requireCf(cfg);
  const endpoints = await loadEndpoints(cf);
  const ep = findEndpoint(endpoints, name);
  if (!ep) {
    console.log(`Endpoint "${name}" not found.`);
    process.exit(1);
  }
  const idx = endpoints.indexOf(ep);
  endpoints.splice(idx, 1);
  await saveEndpoints(cf, endpoints);
  if (cfg.current === ep.name) {
    cfg.current = null;
    saveConfig(cfg);
  }
  console.log("✓ Deleted: " + ep.name);
}

async function cmdTest(args: string[]): Promise<void> {
  const cfg = loadConfig();
  const cf = requireCf(cfg);
  let endpoints = await loadEndpoints(cf);
  if (args.length > 0) {
    const name = args.join(" ");
    const ep = findEndpoint(endpoints, name);
    if (!ep) {
      console.log(`Endpoint "${name}" not found.`);
      process.exit(1);
    }
    const single: Endpoint[] = [ep];
    endpoints = single;
  }
  if (endpoints.length === 0) {
    console.log("No endpoints to test.");
    return;
  }
  console.log("Testing endpoints (/models, 5s timeout)...\n");

  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    const base = ep.url.replace(/\/+$/, "");
    const start = Date.now();
    const res = curlGet(base + "/models", [], 5000);
    const ms = Date.now() - start;
    const label = ep.name.padEnd(14);
    if (res.status === 0) {
      console.log(`  ${label} ✗ ERR`);
    } else {
      const sym = res.status === 200 ? "✓" : "✗";
      console.log(`  ${label} ${sym} ${res.status}  ${ms}ms`);
    }
  }
}

async function cmdImport(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.log("Usage: oc import <file>");
    return;
  }
  const file = args[0];
  if (!existsSync(file)) {
    console.log("File not found: " + file);
    process.exit(1);
  }
  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");
  const cfg = loadConfig();
  const cf = requireCf(cfg);
  const endpoints = await loadEndpoints(cf);
  let added = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sep = trimmed.indexOf("|");
    if (sep === -1) continue;
    const name = trimmed.slice(0, sep).trim();
    const url = trimmed.slice(sep + 1).trim();
    if (!name || !url) continue;
    if (!findEndpoint(endpoints, name)) {
      endpoints.push({ name, url });
      added++;
    }
  }
  if (added > 0) {
    await saveEndpoints(cf, endpoints);
    console.log(`✓ Imported ${added} endpoints (${endpoints.length} total)`);
  } else {
    console.log("No new endpoints to import.");
  }
}

async function cmdStatus(): Promise<void> {
  const cfg = loadConfig();
  const cf = requireCf(cfg);
  const res = curlGet(cf.workerUrl + "/health", [], 5000);
  if (res.status !== 200 || res.body.length === 0) {
    console.log("✗ Cannot reach CF router at " + cf.workerUrl);
    process.exit(1);
  }
  try {
    const parsed: unknown = JSON.parse(res.body);
    if (typeof parsed === "object" && parsed !== null) {
      const data = parsed as Record<string, unknown>;
      console.log(`Router:    ${cf.workerUrl}`);
      console.log(`Version:   ${data.version}`);
      console.log(`Available: ${data.available}`);
      console.log("");
      const epsRaw = data.endpoints;
      if (Array.isArray(epsRaw)) {
        for (let i = 0; i < epsRaw.length; i++) {
          const e = epsRaw[i];
          if (typeof e === "object" && e !== null) {
            const epObj = e as Record<string, unknown>;
            const name = typeof epObj.name === "string" ? epObj.name : "unknown";
            const mark = epObj.exhausted === true ? "✗ exhausted" : "✓ available";
            console.log(`  ${name.padEnd(12)} ${mark}`);
          }
        }
      }
    }
  } catch {
    console.log("✗ Cannot parse router response");
    process.exit(1);
  }
}

function cmdCfInit(args: string[]): void {
  if (args.length < 4) {
    console.log("Usage: oc cf-init <worker-url> <account-id> <kv-namespace-id> <cloudflare-dir>");
    console.log("");
    console.log("  worker-url:      Worker 公网 URL");
    console.log("  account-id:      Dashboard URL 中的 hex ID");
    console.log("  kv-namespace-id: KV namespace ID（wrangler.toml 中的 id）");
    console.log("  cloudflare-dir:  本仓库 cloudflare/ 目录的绝对路径");
    console.log("");
    console.log("Example:");
    console.log("  oc cf-init https://my-router.xxx.workers.dev abc123... 9a32f1... /path/to/cloudflare");
    console.log("");
    console.log("CF Auth (oc 不存储凭据，二选一):");
    console.log("  export CLOUDFLARE_API_TOKEN='...'   # 环境变量");
    console.log("  wrangler login                      # OAuth 浏览器授权");
    return;
  }
  const workerUrl = args[0].replace(/\/+$/, "");
  const hostMatch = workerUrl.match(/^https?:\/\/([^.]+)\./);
  const workerName = hostMatch ? hostMatch[1] : "oc-router";

  const cfg = loadConfig();
  cfg.cloudflare = {
    workerUrl,
    accountId: args[1],
    kvNamespaceId: args[2],
    workerName,
    cloudflareDir: args[3],
  };
  saveConfig(cfg);
  console.log("✓ Cloudflare config saved (no credentials stored).");
  console.log(`  Worker:     ${workerName}`);
  console.log(`  URL:        ${workerUrl}`);
  console.log(`  KV:         ${args[2]}`);
  console.log(`  Dir:        ${args[3]}`);
  console.log("");
  console.log("CF Auth (pick one):");
  console.log("  export CLOUDFLARE_API_TOKEN='...'");
  console.log("  wrangler login");
  console.log("");
  console.log('Then run "oc add <name> <url>" to add endpoints.');
}

function printHelp(): void {
  console.log("oc - opencode proxy switcher");
  console.log("");
  console.log("Usage:");
  console.log("  oc                    Show current endpoint + router status");
  console.log("  oc list               List all endpoints (from CF KV)");
  console.log("  oc add <name> <url>   Add an endpoint to CF KV");
  console.log("  oc use <name>         Switch client configs to an endpoint");
  console.log("  oc del <name>         Delete an endpoint from CF KV");
  console.log("  oc test [name]        Test endpoint(s) latency");
  console.log("  oc import <file>      Import from file to CF KV");
  console.log("  oc status             Show CF router health & exhaustion");
  console.log("  oc cf-init ...        One-time Cloudflare config");
  console.log("  oc current            Show current endpoint");
  console.log("  oc help               Show this help");
  console.log("");
  console.log("Endpoints are stored in Cloudflare KV, not locally.");
  console.log("CF Auth (oc stores no credentials):");
  console.log("  export CLOUDFLARE_API_TOKEN='...'   # env var, direct API");
  console.log("  wrangler login                      # OAuth, wrangler manages token");
  console.log("");
  console.log("Install:");
  console.log("  curl -fsSL https://github.com/3kaiu/opencode-proxy/raw/main/install.sh | sh");
  console.log("");
  console.log("Uninstall:");
  console.log("  rm ~/bin/oc");
  console.log("  rm -rf ~/.oc");
  console.log("");
  console.log("Config:  " + CONFIG_FILE);
  console.log("Kimi:    ~/.kimi-code/config.toml         [providers.oc] base_url");
  console.log("OpenCode: ~/.config/opencode/opencode.jsonc  provider.oc.baseURL");
}

// ── Main ────────────────────────────────────────────────
async function main(): Promise<void> {
  const argv = process.argv;
  const cmd = argv.length > 2 ? argv[2] : "current";
  const args = argv.slice(3);

  switch (cmd) {
    case "list":    await cmdList(); break;
    case "add":     await cmdAdd(args); break;
    case "use":     await cmdUse(args); break;
    case "del":     await cmdDel(args); break;
    case "test":    await cmdTest(args); break;
    case "import":  await cmdImport(args); break;
    case "status":  await cmdStatus(); break;
    case "cf-init": cmdCfInit(args); break;
    case "current": await cmdCurrent(); break;
    case "help":
    case "--help":
    case "-h":
      printHelp(); break;
    default:
      console.log("Unknown command: " + cmd);
      console.log("");
      printHelp();
      process.exit(1);
      break;
  }
}

main();
