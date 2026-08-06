// oc.ts - opencode proxy switcher CLI
// Build: scriptc build cli/oc.ts -o cli/oc
//
// 端点列表存储在 Cloudflare KV（key: "endpoints"），本地不存端点
// oc 通过 CF API 或 wrangler 读写 KV
//
// Usage:
//   oc init               Auto-configure (just login to CF, rest is automatic)
//   oc                    Show current endpoint + router status
//   oc list               List all endpoints (from CF KV)
//   oc add <name> <url>   Add an endpoint to CF KV
//   oc use <name>         Switch client configs to an endpoint
//   oc del <name>         Delete an endpoint from CF KV
//   oc test [name]        Test endpoint(s) latency
//   oc import <file>      Import from file to CF KV
//   oc status             Show CF router health & exhaustion
//   oc current            Show current endpoint
//   oc help               Show this help
//
// Privacy: oc stores NO credentials. Config only contains public worker info.
//   CF auth is handled entirely by wrangler or CLOUDFLARE_API_TOKEN env var.

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

// ── Default config (public info from repo wrangler.toml) ──
const DEFAULT_ACCOUNT_ID = "YOUR_ACCOUNT_ID";
const DEFAULT_KV_NAMESPACE_ID = "YOUR_KV_NAMESPACE_ID";
const DEFAULT_WORKER_NAME = "oc-router";
const DEFAULT_WORKER_URL = "https://YOUR_WORKER.workers.dev";

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
}

interface OcConfig {
  current: string | null;
  cloudflare?: CloudflareConfig;
  endpoints?: Endpoint[];  // Legacy format for migration
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
      const endpoints = obj.endpoints;

      let cloudflare: CloudflareConfig | undefined;
      if (typeof cf === "object" && cf !== null) {
        const cfObj = cf as Record<string, unknown>;
        cloudflare = {
          workerUrl: String(cfObj.workerUrl || DEFAULT_WORKER_URL),
          accountId: String(cfObj.accountId || DEFAULT_ACCOUNT_ID),
          kvNamespaceId: String(cfObj.kvNamespaceId || DEFAULT_KV_NAMESPACE_ID),
          workerName: String(cfObj.workerName || DEFAULT_WORKER_NAME),
        };
      }

      let legacyEndpoints: Endpoint[] | undefined;
      if (Array.isArray(endpoints)) {
        legacyEndpoints = [];
        for (let i = 0; i < endpoints.length; i++) {
          const item = endpoints[i];
          if (typeof item === "object" && item !== null) {
            const epObj = item as Record<string, unknown>;
            if (typeof epObj.name === "string" && typeof epObj.url === "string") {
              legacyEndpoints.push({ name: epObj.name, url: epObj.url });
            }
          }
        }
      }

      return { current, cloudflare, endpoints: legacyEndpoints };
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
  // Privacy: only save public info, never credentials
  const toSave: Record<string, unknown> = { current: cfg.current };
  if (cfg.cloudflare) {
    toSave.cloudflare = {
      workerUrl: cfg.cloudflare.workerUrl,
      accountId: cfg.cloudflare.accountId,
      kvNamespaceId: cfg.cloudflare.kvNamespaceId,
      workerName: cfg.cloudflare.workerName,
    };
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(toSave, null, 2) + "\n");
}

function requireCf(cfg: OcConfig): CloudflareConfig {
  if (!cfg.cloudflare) {
    console.log("Not configured. Run: oc init");
    process.exit(1);
  }
  return cfg.cloudflare;
}

// ── CF KV 读写 ──────────────────────────────────────────
// Privacy: no credentials stored. Auth via wrangler or CLOUDFLARE_API_TOKEN env.

async function kvGet(cf: CloudflareConfig, key: string): Promise<string | null> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (token) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/storage/kv/namespaces/${cf.kvNamespaceId}/values/${key}`;
    const res = curlGet(url, [`Authorization: Bearer ${token}`], 10_000);
    if (res.status === 404) return null;
    if (res.status >= 200 && res.status < 300) return res.body;
  }
  try {
    const out = execSync(`wrangler kv key get ${key} --account-id ${cf.accountId}`, {
      timeout: 15_000,
      stdio: ["pipe", "pipe", "pipe"],
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
    execSync(`wrangler kv key put ${key} --account-id ${cf.accountId}`, {
      input: value,
      timeout: 15_000,
      stdio: ["pipe", "pipe", "pipe"],
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
    console.log("  ✗ CF KV write failed. Run: wrangler login");
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

async function cmdInit(): Promise<void> {
  console.log("oc init - one-step Cloudflare setup");
  console.log("");

  const cfg = loadConfig();

  // Already configured?
  if (cfg.cloudflare) {
    console.log("  ✓ Already configured:");
    console.log(`    Worker: ${cfg.cloudflare.workerUrl}`);
    console.log(`    KV:     ${cfg.cloudflare.kvNamespaceId}`);

    // Migrate legacy endpoints if present
    if (cfg.endpoints && cfg.endpoints.length > 0) {
      console.log("");
      console.log(`  Migrating ${cfg.endpoints.length} legacy endpoints to CF KV...`);
      const existing = await loadEndpoints(cfg.cloudflare);
      if (existing.length === 0) {
        await saveEndpoints(cfg.cloudflare, cfg.endpoints);
        console.log("  ✓ Migrated to CF KV");
      } else {
        console.log(`  ⚠ CF KV already has ${existing.length} endpoints, skipping`);
      }
      cfg.endpoints = undefined;
      saveConfig(cfg);
    }

    // Verify connectivity
    console.log("");
    console.log("  Verifying connection...");
    const res = curlGet(cfg.cloudflare.workerUrl + "/health", [], 5000);
    if (res.status === 200) {
      console.log("  ✓ Router is reachable");
    } else {
      console.log("  ⚠ Router not reachable (status: " + res.status + ")");
    }
    return;
  }

  // Step 1: wrangler login
  console.log("  Checking wrangler auth...");
  let loggedIn = false;
  try {
    execSync("wrangler whoami", { stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
    loggedIn = true;
    console.log("  ✓ wrangler authenticated");
  } catch {
    console.log("  ✗ Not authenticated");
    console.log("");
    console.log("  Opening browser for Cloudflare login...");
    console.log("  Please authorize in the browser window.");
    console.log("");
    try {
      execSync("wrangler login", { stdio: "inherit", timeout: 120000 });
    } catch {
      console.log("");
      console.log("  ✗ Login failed. Try: wrangler login");
      return;
    }
    // Verify
    try {
      execSync("wrangler whoami", { stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
      console.log("  ✓ wrangler authenticated");
      loggedIn = true;
    } catch {
      console.log("  ✗ Auth verification failed");
      return;
    }
  }

  if (!loggedIn) return;

  // Step 2: Save config (all defaults from repo, no user input needed)
  console.log("");
  console.log("  Saving config...");
  cfg.cloudflare = {
    workerUrl: DEFAULT_WORKER_URL,
    accountId: DEFAULT_ACCOUNT_ID,
    kvNamespaceId: DEFAULT_KV_NAMESPACE_ID,
    workerName: DEFAULT_WORKER_NAME,
  };
  saveConfig(cfg);
  console.log("  ✓ Config saved");

  // Step 3: Migrate legacy endpoints
  if (cfg.endpoints && cfg.endpoints.length > 0) {
    console.log("");
    console.log(`  Migrating ${cfg.endpoints.length} legacy endpoints...`);
    const existing = await loadEndpoints(cfg.cloudflare);
    if (existing.length === 0) {
      await saveEndpoints(cfg.cloudflare, cfg.endpoints);
      console.log("  ✓ Migrated to CF KV");
    } else {
      console.log(`  ⚠ CF KV already has ${existing.length} endpoints, skipping`);
    }
    cfg.endpoints = undefined;
    saveConfig(cfg);
  }

  // Step 4: Verify
  console.log("");
  console.log("  Verifying connection...");
  const res = curlGet(DEFAULT_WORKER_URL + "/health", [], 5000);
  if (res.status === 200) {
    console.log("  ✓ Router is reachable");
  } else {
    console.log("  ⚠ Router not reachable (status: " + res.status + ")");
  }

  console.log("");
  console.log("  ✓ Done! You can now use:");
  console.log("    oc list    - list endpoints");
  console.log("    oc use <n> - switch endpoint");
  console.log("    oc add <name> <url> - add endpoint");
}

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
    // silent
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

function printHelp(): void {
  console.log("oc - opencode proxy switcher");
  console.log("");
  console.log("Usage:");
  console.log("  oc init               Auto-configure (just login to CF)");
  console.log("  oc                    Show current endpoint + router status");
  console.log("  oc list               List all endpoints (from CF KV)");
  console.log("  oc add <name> <url>   Add an endpoint to CF KV");
  console.log("  oc use <name>         Switch client configs to an endpoint");
  console.log("  oc del <name>         Delete an endpoint from CF KV");
  console.log("  oc test [name]        Test endpoint(s) latency");
  console.log("  oc import <file>      Import from file to CF KV");
  console.log("  oc status             Show CF router health & exhaustion");
  console.log("  oc current            Show current endpoint");
  console.log("  oc help               Show this help");
  console.log("");
  console.log("Privacy: oc stores NO credentials.");
  console.log("  Config only contains public worker info (URL, account ID, KV ID).");
  console.log("  CF auth is handled by wrangler or CLOUDFLARE_API_TOKEN env var.");
  console.log("");
  console.log("Install:");
  console.log("  curl -fsSL https://github.com/3kaiu/opencode-proxy/raw/main/install.sh | sh");
  console.log("");
  console.log("Uninstall:");
  console.log("  rm ~/bin/oc && rm -rf ~/.oc");
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
    case "init":    await cmdInit(); break;
    case "list":    await cmdList(); break;
    case "add":     await cmdAdd(args); break;
    case "use":     await cmdUse(args); break;
    case "del":     await cmdDel(args); break;
    case "test":    await cmdTest(args); break;
    case "import":  await cmdImport(args); break;
    case "status":  await cmdStatus(); break;
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
