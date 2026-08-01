// oc.ts - opencode proxy switcher CLI
// Build: scriptc build cli/oc.ts -o cli/oc
//
// Provider name injected into both Kimi Code and OpenCode: "oc"
//
// Install:
//   scriptc build cli/oc.ts -o cli/oc
//   cp cli/oc ~/bin/oc
//   # Add ~/bin to PATH (fish):
//   #   fish_add_path ~/bin        >> ~/.config/fish/config.fish
//   # Add ~/bin to PATH (zsh):
//   #   export PATH="$HOME/bin:$PATH"  >> ~/.zshrc
//   # Add ~/bin to PATH (bash):
//   #   export PATH="$HOME/bin:$PATH"  >> ~/.bashrc
//
// Uninstall:
//   rm ~/bin/oc
//   rm -rf ~/.oc
//
// Usage:
//   oc                    Show current endpoint
//   oc list               List all endpoints
//   oc add <name> <url>   Add an endpoint
//   oc use <name>         Switch to an endpoint
//   oc del <name>         Delete an endpoint
//   oc test [name]        Test endpoint(s) latency
//   oc import <file>      Import from file (name|url per line)
//   oc current            Show current endpoint
//   oc help               Show this help
//
// Config:  ~/.oc/config.json
// Kimi:    ~/.kimi-code/config.toml        [providers.oc] base_url
// OpenCode: ~/.config/opencode/opencode.json  provider.oc.baseURL

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

// ── Paths ───────────────────────────────────────────────
const HOME = homedir();
const CONFIG_DIR = HOME + "/.oc";
const CONFIG_FILE = CONFIG_DIR + "/config.json";
const KIMI_CONFIG = HOME + "/.kimi-code/config.toml";
const OPENCODE_CONFIG = HOME + "/.config/opencode/opencode.json";
const KIMI_PROVIDER = "oc";
const OPENCODE_PROVIDER = "oc";

// ── Types ───────────────────────────────────────────────
interface Endpoint {
  name: string;
  url: string;
}

interface OcConfig {
  endpoints: Endpoint[];
  current: string | null;
}

interface TestResult {
  name: string;
  status: number;
  ms: number;
}

// ── Config I/O ──────────────────────────────────────────
function loadConfig(): OcConfig {
  if (!existsSync(CONFIG_FILE)) {
    return { endpoints: [], current: null };
  }
  try {
    const raw = readFileSync(CONFIG_FILE, "utf8");
    return JSON.parse(raw) as OcConfig;
  } catch {
    return { endpoints: [], current: null };
  }
}

function saveConfig(cfg: OcConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
}

function findEndpoint(cfg: OcConfig, name: string): Endpoint | null {
  // Exact match
  for (const ep of cfg.endpoints) {
    if (ep.name === name) return ep;
  }
  // Case-insensitive match
  const lower = name.toLowerCase();
  for (const ep of cfg.endpoints) {
    if (ep.name.toLowerCase() === lower) return ep;
  }
  // Numeric index match (1-based)
  const idx = parseInt(name, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= cfg.endpoints.length) {
    return cfg.endpoints[idx - 1];
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

// ── Update OpenCode opencode.json ───────────────────────
function updateOpenCode(url: string): void {
  if (!existsSync(OPENCODE_CONFIG)) {
    console.log("  ⚠ OpenCode opencode.json not found");
    return;
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(readFileSync(OPENCODE_CONFIG, "utf8")) as Record<string, unknown>;
  } catch {
    console.log("  ⚠ opencode.json is not valid JSON");
    return;
  }

  const providers = json.provider as Record<string, Record<string, unknown>> | undefined;
  const provider = providers?.[OPENCODE_PROVIDER];
  if (!provider) {
    console.log(`  ⚠ Provider "${OPENCODE_PROVIDER}" not found in opencode.json`);
    return;
  }

  // baseURL may live at provider.options.baseURL or provider.baseURL
  const options = provider.options as Record<string, unknown> | undefined;
  if (options && typeof options.baseURL === "string") {
    options.baseURL = url;
  } else if (typeof provider.baseURL === "string") {
    provider.baseURL = url;
  } else {
    console.log(`  ⚠ baseURL not found in provider "${OPENCODE_PROVIDER}"`);
    return;
  }

  writeFileSync(OPENCODE_CONFIG, JSON.stringify(json, null, 2) + "\n");
  console.log("  ✓ OpenCode  -> provider." + OPENCODE_PROVIDER);
}

// ── Commands ────────────────────────────────────────────

function cmdCurrent(): void {
  const cfg = loadConfig();
  if (!cfg.current) {
    console.log("No endpoint selected. Use: oc use <name>");
    return;
  }
  const ep = findEndpoint(cfg, cfg.current);
  if (!ep) {
    console.log(`Current endpoint "${cfg.current}" not found in list.`);
    return;
  }
  console.log("Current: " + ep.name);
  console.log("URL:     " + ep.url);
}

function cmdList(): void {
  const cfg = loadConfig();
  if (cfg.endpoints.length === 0) {
    console.log("No endpoints. Use: oc add <name> <url>");
    return;
  }
  for (let i = 0; i < cfg.endpoints.length; i++) {
    const ep = cfg.endpoints[i];
    const marker = ep.name === cfg.current ? " ←" : "";
    console.log(`  ${i + 1}. ${ep.name}${marker}`);
    console.log("     " + ep.url);
  }
}

function cmdAdd(args: string[]): void {
  if (args.length < 2) {
    console.log("Usage: oc add <name> <url>");
    return;
  }
  const name = args[0];
  const url = args[1];
  const cfg = loadConfig();
  if (findEndpoint(cfg, name)) {
    console.log(`Endpoint "${name}" already exists.`);
    return;
  }
  cfg.endpoints.push({ name, url });
  saveConfig(cfg);
  console.log("✓ Added: " + name + " -> " + url);
}

function cmdUse(args: string[]): void {
  if (args.length < 1) {
    console.log("Usage: oc use <name>");
    return;
  }
  const name = args.join(" ");
  const cfg = loadConfig();
  const ep = findEndpoint(cfg, name);
  if (!ep) {
    console.log(`Endpoint "${name}" not found. Run "oc list" to see options.`);
    process.exitCode = 1;
    return;
  }
  console.log("Switching to: " + ep.name);
  console.log("URL:          " + ep.url);
  console.log("");
  updateKimi(ep.url);
  updateOpenCode(ep.url);
  cfg.current = ep.name;
  saveConfig(cfg);
  console.log("");
  console.log("✓ Done.");
}

function cmdDel(args: string[]): void {
  if (args.length < 1) {
    console.log("Usage: oc del <name>");
    return;
  }
  const name = args.join(" ");
  const cfg = loadConfig();
  const ep = findEndpoint(cfg, name);
  if (!ep) {
    console.log(`Endpoint "${name}" not found.`);
    process.exitCode = 1;
    return;
  }
  const idx = cfg.endpoints.indexOf(ep);
  cfg.endpoints.splice(idx, 1);
  if (cfg.current === ep.name) {
    cfg.current = null;
  }
  saveConfig(cfg);
  console.log("✓ Deleted: " + ep.name);
}

async function cmdTest(args: string[]): Promise<void> {
  const cfg = loadConfig();
  let endpoints: Endpoint[] = cfg.endpoints;
  if (args.length > 0) {
    const name = args.join(" ");
    const ep = findEndpoint(cfg, name);
    if (!ep) {
      console.log(`Endpoint "${name}" not found.`);
      process.exitCode = 1;
      return;
    }
    endpoints = [ep];
  }
  if (endpoints.length === 0) {
    console.log("No endpoints to test.");
    return;
  }
  console.log("Testing endpoints (/models, 5s timeout)...\n");

  // scriptc native fetch — no curl dependency, parallel probing
  const results = await Promise.all(
    endpoints.map(async (ep): Promise<TestResult> => {
      const base = ep.url.replace(/\/+$/, "");
      const start = Date.now();
      try {
        const res = await fetch(base + "/models", {
          signal: AbortSignal.timeout(5000),
        });
        return { name: ep.name, status: res.status, ms: Date.now() - start };
      } catch {
        return { name: ep.name, status: 0, ms: Date.now() - start };
      }
    }),
  );

  for (const r of results) {
    const label = r.name.padEnd(14);
    if (r.status === 0) {
      console.log(`  ${label} ✗ ERR`);
    } else {
      const sym = r.status === 200 ? "✓" : "✗";
      console.log(`  ${label} ${sym} ${r.status}  ${r.ms}ms`);
    }
  }
}

function cmdImport(args: string[]): void {
  if (args.length < 1) {
    console.log("Usage: oc import <file>");
    return;
  }
  const file = args[0];
  if (!existsSync(file)) {
    console.log("File not found: " + file);
    process.exitCode = 1;
    return;
  }
  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");
  const cfg = loadConfig();
  let added = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sep = trimmed.indexOf("|");
    if (sep === -1) continue;
    const name = trimmed.slice(0, sep).trim();
    const url = trimmed.slice(sep + 1).trim();
    if (!name || !url) continue;
    if (!findEndpoint(cfg, name)) {
      cfg.endpoints.push({ name, url });
      added++;
    }
  }
  saveConfig(cfg);
  console.log(`✓ Imported ${added} endpoints (${cfg.endpoints.length} total)`);
}

function printHelp(): void {
  console.log("oc - opencode proxy switcher");
  console.log("");
  console.log("Usage:");
  console.log("  oc                    Show current endpoint");
  console.log("  oc list               List all endpoints");
  console.log("  oc add <name> <url>   Add an endpoint");
  console.log("  oc use <name>         Switch to an endpoint");
  console.log("  oc del <name>         Delete an endpoint");
  console.log("  oc test [name]        Test endpoint(s) latency");
  console.log("  oc import <file>      Import from file (name|url per line)");
  console.log("  oc current            Show current endpoint");
  console.log("  oc help               Show this help");
  console.log("");
  console.log("Install:");
  console.log("  scriptc build cli/oc.ts -o cli/oc");
  console.log("  cp cli/oc ~/bin/oc");
  console.log('  # fish:  fish_add_path ~/bin             >> ~/.config/fish/config.fish');
  console.log('  # zsh:   export PATH="$HOME/bin:$PATH"   >> ~/.zshrc');
  console.log('  # bash:  export PATH="$HOME/bin:$PATH"   >> ~/.bashrc');
  console.log("");
  console.log("Uninstall:");
  console.log("  rm ~/bin/oc");
  console.log("  rm -rf ~/.oc");
  console.log("");
  console.log("Config:  " + CONFIG_FILE);
  console.log("Kimi:    ~/.kimi-code/config.toml         [providers.oc] base_url");
  console.log("OpenCode: ~/.config/opencode/opencode.json  provider.oc.baseURL");
}

// ── Main ────────────────────────────────────────────────
async function main(): Promise<void> {
  const argv = process.argv;
  const cmd = argv.length > 2 ? argv[2] : "current";
  const args = argv.slice(3);

  switch (cmd) {
    case "list":    cmdList(); break;
    case "add":     cmdAdd(args); break;
    case "use":     cmdUse(args); break;
    case "del":     cmdDel(args); break;
    case "test":    await cmdTest(args); break;
    case "import":  cmdImport(args); break;
    case "current": cmdCurrent(); break;
    case "help":
    case "--help":
    case "-h":
      printHelp(); break;
    default:
      console.log("Unknown command: " + cmd);
      console.log("");
      printHelp();
      process.exitCode = 1;
      break;
  }
}

main();
