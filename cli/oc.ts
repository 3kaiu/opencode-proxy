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
import { execSync } from "node:child_process";

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
  for (const ep of cfg.endpoints) {
    if (ep.name === name) return ep;
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
  const raw = readFileSync(OPENCODE_CONFIG, "utf8");

  // Find the provider key, then the baseURL within its block
  const key = '"' + OPENCODE_PROVIDER + '"';
  let pos = 0;
  while (true) {
    const idx = raw.indexOf(key, pos);
    if (idx === -1) {
      console.log('  ⚠ Provider "' + OPENCODE_PROVIDER + '" not found in opencode.json');
      return;
    }
    // Verify it's a JSON key (followed by optional whitespace then :)
    let after = idx + key.length;
    while (after < raw.length && (raw[after] === " " || raw[after] === "\t" || raw[after] === "\n")) {
      after++;
    }
    if (raw[after] === ":") {
      // Found the right key. Now find "baseURL" after it.
      const bKey = '"baseURL"';
      const bIdx = raw.indexOf(bKey, after);
      if (bIdx === -1) {
        console.log('  ⚠ baseURL not found in provider "' + OPENCODE_PROVIDER + '"');
        return;
      }
      // Find the value: skip past colon to the opening quote
      const colonIdx = raw.indexOf(":", bIdx);
      let qStart = colonIdx + 1;
      while (qStart < raw.length && raw[qStart] !== '"') {
        qStart++;
      }
      const qEnd = raw.indexOf('"', qStart + 1);
      if (qStart === -1 || qEnd === -1) {
        console.log("  ⚠ Malformed baseURL value");
        return;
      }
      // Replace just the URL value between quotes
      const updated = raw.slice(0, qStart + 1) + url + raw.slice(qEnd);
      writeFileSync(OPENCODE_CONFIG, updated);
      console.log("  ✓ OpenCode  -> provider." + OPENCODE_PROVIDER);
      return;
    }
    pos = idx + 1;
  }
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
    console.log('Current endpoint "' + cfg.current + '" not found in list.');
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
  for (const ep of cfg.endpoints) {
    const marker = ep.name === cfg.current ? " ←" : "";
    console.log("  " + ep.name + marker);
    console.log("    " + ep.url);
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
    console.log('Endpoint "' + name + '" already exists.');
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
  const name = args[0];
  const cfg = loadConfig();
  const ep = findEndpoint(cfg, name);
  if (!ep) {
    console.log('Endpoint "' + name + '" not found. Run "oc list" to see options.');
    return;
  }
  console.log("Switching to: " + ep.name);
  console.log("URL:          " + ep.url);
  console.log("");
  updateKimi(ep.url);
  updateOpenCode(ep.url);
  cfg.current = name;
  saveConfig(cfg);
  console.log("");
  console.log("✓ Done.");
}

function cmdDel(args: string[]): void {
  if (args.length < 1) {
    console.log("Usage: oc del <name>");
    return;
  }
  const name = args[0];
  const cfg = loadConfig();
  let idx = -1;
  for (let i = 0; i < cfg.endpoints.length; i++) {
    if (cfg.endpoints[i].name === name) { idx = i; break; }
  }
  if (idx === -1) {
    console.log('Endpoint "' + name + '" not found.');
    return;
  }
  cfg.endpoints.splice(idx, 1);
  if (cfg.current === name) {
    cfg.current = null;
  }
  saveConfig(cfg);
  console.log("✓ Deleted: " + name);
}

function cmdTest(args: string[]): void {
  const cfg = loadConfig();
  let endpoints: Endpoint[] = cfg.endpoints;
  if (args.length > 0) {
    const ep = findEndpoint(cfg, args[0]);
    if (!ep) {
      console.log('Endpoint "' + args[0] + '" not found.');
      return;
    }
    endpoints = [ep];
  }
  if (endpoints.length === 0) {
    console.log("No endpoints to test.");
    return;
  }
  console.log("Testing endpoints (curl /models, 5s timeout)...\n");
  for (const ep of endpoints) {
    const label = ep.name;
    const pad = label.length < 12 ? 12 - label.length : 0;
    let padding = "";
    for (let p = 0; p < pad; p++) { padding += " "; }
    process.stdout.write("  " + label + padding + " ");
    try {
      const out = execSync(
        "curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 5 " + ep.url + "/models",
        { timeout: 10000 }
      ).toString().trim();
      const parts = out.split(" ");
      const code = parts[0];
      const time = parts.length > 1 ? parts[1] : "?";
      const ok = code === "200";
      const sym = ok ? "✓" : "✗";
      console.log(sym + " " + code + "  " + (parseFloat(time) * 1000).toFixed(0) + "ms");
    } catch {
      console.log("✗ ERR");
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
  console.log("✓ Imported " + added + " endpoints (" + cfg.endpoints.length + " total)");
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
  console.log("  # fish:  fish_add_path ~/bin             >> ~/.config/fish/config.fish");
  console.log("  # zsh:   export PATH=\"$HOME/bin:$PATH\"   >> ~/.zshrc");
  console.log("  # bash:  export PATH=\"$HOME/bin:$PATH\"   >> ~/.bashrc");
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
function main(): void {
  const argv = process.argv;
  const cmd = argv.length > 2 ? argv[2] : "current";
  const args = argv.slice(3);

  switch (cmd) {
    case "list":    cmdList(); break;
    case "add":     cmdAdd(args); break;
    case "use":     cmdUse(args); break;
    case "del":     cmdDel(args); break;
    case "test":    cmdTest(args); break;
    case "import":  cmdImport(args); break;
    case "current": cmdCurrent(); break;
    case "help":
    case "--help":
    case "-h":
      printHelp(); break;
    default:
      console.log('Unknown command: ' + cmd);
      console.log("");
      printHelp();
      break;
  }
}

main();
