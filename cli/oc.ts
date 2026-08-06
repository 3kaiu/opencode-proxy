// oc.ts - opencode proxy switcher CLI
// Build: scriptc build cli/oc.ts -o cli/oc
//
// 端点列表存储在本地 ~/.oc/config.json
// oc use 切换时自动更新 kimi-code 和 opencode 配置
// 如果没有 oc 供应商段，自动创建
//
// Usage:
//   oc                    Show current endpoint
//   oc list               List all endpoints
//   oc add NAME URL       Add an endpoint
//   oc use NAME           Switch client configs to an endpoint
//   oc del NAME           Delete an endpoint
//   oc current            Show current endpoint
//   oc completion fish    Generate fish shell completions
//   oc help               Show this help

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

// ── Paths ───────────────────────────────────────────────
const HOME = homedir();
const CONFIG_DIR = HOME + "/.oc";
const CONFIG_FILE = CONFIG_DIR + "/config.json";
const KIMI_CONFIG = HOME + "/.kimi-code/config.toml";
const OPENCODE_CONFIG = HOME + "/.config/opencode/opencode.jsonc";
const PROVIDER = "oc";

// ── Types ───────────────────────────────────────────────
interface Endpoint {
  name: string;
  url: string;
}

interface OcConfig {
  current: string | null;
  endpoints: Endpoint[];
}

// ── Config I/O ──────────────────────────────────────────
function loadConfig(): OcConfig {
  if (!existsSync(CONFIG_FILE)) {
    return { current: null, endpoints: [] };
  }
  try {
    const raw = readFileSync(CONFIG_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      const current = typeof obj.current === "string" ? obj.current : null;
      const endpoints: Endpoint[] = [];
      if (Array.isArray(obj.endpoints)) {
        for (let i = 0; i < obj.endpoints.length; i++) {
          const item = obj.endpoints[i];
          if (typeof item === "object" && item !== null) {
            const ep = item as Record<string, unknown>;
            if (typeof ep.name === "string" && typeof ep.url === "string") {
              endpoints.push({ name: ep.name, url: ep.url });
            }
          }
        }
      }
      return { current, endpoints };
    }
    return { current: null, endpoints: [] };
  } catch {
    return { current: null, endpoints: [] };
  }
}

function saveConfig(cfg: OcConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify({ current: cfg.current, endpoints: cfg.endpoints }, null, 2) + "\n");
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
  const header = "[providers." + PROVIDER + "]";

  if (!existsSync(KIMI_CONFIG)) {
    // Create config with oc provider section
    const content = header + "\ntype = \"openai\"\nbase_url = \"" + url + "\"\n";
    writeFileSync(KIMI_CONFIG, content);
    console.log("  ✓ Kimi Code  -> created [providers." + PROVIDER + "]");
    return;
  }

  const content = readFileSync(KIMI_CONFIG, "utf8");
  const lines = content.split("\n");
  let inSec = false;
  let foundBase = false;
  let foundSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === header) { inSec = true; foundSection = true; continue; }
    if (line.startsWith("[") && inSec) { inSec = false; break; }
    if (inSec && /^base_url\s*=/.test(line)) {
      lines[i] = 'base_url = "' + url + '"';
      foundBase = true;
      break;
    }
  }

  if (foundSection && foundBase) {
    writeFileSync(KIMI_CONFIG, lines.join("\n"));
    console.log("  ✓ Kimi Code  -> updated [providers." + PROVIDER + "]");
  } else if (foundSection && !foundBase) {
    // Section exists but no base_url — add it
    const newLines: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      newLines.push(lines[i]);
      if (lines[i].trim() === header) {
        newLines.push('base_url = "' + url + '"');
      }
    }
    writeFileSync(KIMI_CONFIG, newLines.join("\n"));
    console.log("  ✓ Kimi Code  -> added base_url to [providers." + PROVIDER + "]");
  } else {
    // No section — append
    const append = "\n" + header + "\ntype = \"openai\"\nbase_url = \"" + url + "\"\n";
    writeFileSync(KIMI_CONFIG, content + append);
    console.log("  ✓ Kimi Code  -> created [providers." + PROVIDER + "]");
  }
}

// ── Update OpenCode opencode.jsonc ───────────────────────
function updateOpenCode(url: string): void {
  // Find all opencode config files
  const configs = [
    HOME + "/.config/opencode/opencode.jsonc",
    HOME + "/code/opencode.jsonc",
    HOME + "/self/opencode-x/.opencode/opencode.jsonc",
  ];

  let updated = 0;
  for (const configPath of configs) {
    if (!existsSync(configPath)) continue;
    if (updateSingleOpenCode(configPath, url)) updated++;
  }

  if (updated === 0) {
    // No existing config, create global one
    const defaultPath = HOME + "/.config/opencode/opencode.jsonc";
    const json = {
      provider: {
        [PROVIDER]: {
          npm: "@ai-sdk/openai-compatible",
          name: "oc proxy",
          options: { baseURL: url },
        },
      },
    };
    mkdirSync(HOME + "/.config/opencode", { recursive: true });
    writeFileSync(defaultPath, JSON.stringify(json, null, 2) + "\n");
    console.log("  ✓ OpenCode   -> created provider." + PROVIDER);
  } else {
    console.log("  ✓ OpenCode   -> updated " + updated + " config(s)");
  }
}

function updateSingleOpenCode(configPath: string, url: string): boolean {
  let json: Record<string, unknown>;

  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      json = parsed as Record<string, unknown>;
    } else {
      return false;
    }
  } catch {
    return false;
  }

  // Ensure provider object exists
  if (typeof json.provider !== "object" || json.provider === null) {
    json.provider = {};
  }
  const providers = json.provider as Record<string, unknown>;

  // Ensure our provider section exists
  if (typeof providers[PROVIDER] !== "object" || providers[PROVIDER] === null) {
    providers[PROVIDER] = {
      npm: "@ai-sdk/openai-compatible",
      name: "oc proxy",
      options: { baseURL: url },
    };
    writeFileSync(configPath, JSON.stringify(json, null, 2) + "\n");
    return true;
  }

  const prov = providers[PROVIDER] as Record<string, unknown>;

  // Always use options.baseURL
  if (typeof prov.options !== "object" || prov.options === null) {
    prov.options = {};
  }
  (prov.options as Record<string, unknown>).baseURL = url;
  writeFileSync(configPath, JSON.stringify(json, null, 2) + "\n");
  return true;
}

// ── Commands ────────────────────────────────────────────

function cmdCurrent(): void {
  const cfg = loadConfig();
  if (!cfg.current) {
    console.log("No endpoint selected. Use: oc use NAME");
    return;
  }
  const ep = findEndpoint(cfg.endpoints, cfg.current);
  if (!ep) {
    console.log('Current endpoint "' + cfg.current + '" not found.');
    return;
  }
  console.log("Current: " + ep.name);
  console.log("URL:     " + ep.url);
}

function cmdList(): void {
  const cfg = loadConfig();
  if (cfg.endpoints.length === 0) {
    console.log("No endpoints. Use: oc add NAME URL");
    return;
  }
  for (let i = 0; i < cfg.endpoints.length; i++) {
    const ep = cfg.endpoints[i];
    const marker = ep.name === cfg.current ? " ←" : "";
    console.log("  " + (i + 1) + ". " + ep.name + marker);
    console.log("     " + ep.url);
  }
}

function cmdAdd(args: string[]): void {
  if (args.length < 2) {
    console.log("Usage: oc add NAME URL");
    return;
  }
  const name = args[0];
  const url = args[1];
  const cfg = loadConfig();
  if (findEndpoint(cfg.endpoints, name)) {
    console.log('Endpoint "' + name + '" already exists.');
    return;
  }
  cfg.endpoints.push({ name, url });
  saveConfig(cfg);
  console.log("✓ Added: " + name + " -> " + url);
}

function cmdUse(args: string[]): void {
  if (args.length < 1) {
    console.log("Usage: oc use NAME");
    return;
  }
  const name = args.join(" ");
  const cfg = loadConfig();
  const ep = findEndpoint(cfg.endpoints, name);
  if (!ep) {
    console.log('Endpoint "' + name + '" not found. Run "oc list" to see options.');
    process.exit(1);
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
    console.log("Usage: oc del NAME");
    return;
  }
  const name = args.join(" ");
  const cfg = loadConfig();
  const ep = findEndpoint(cfg.endpoints, name);
  if (!ep) {
    console.log('Endpoint "' + name + '" not found.');
    process.exit(1);
  }
  const idx = cfg.endpoints.indexOf(ep);
  cfg.endpoints.splice(idx, 1);
  if (cfg.current === ep.name) {
    cfg.current = null;
  }
  saveConfig(cfg);
  console.log("✓ Deleted: " + ep.name);
}

function cmdCompletion(args: string[]): void {
  if (args.length < 1 || args[0] !== "fish") {
    console.log("Usage: oc completion fish");
    return;
  }
  const lines = [
    "# Fish completions for oc (opencode proxy switcher)",
    "",
    "complete -c oc -f -n \"__fish_use_subcommand\" -a list -d \"List all endpoints\"",
    "complete -c oc -f -n \"__fish_use_subcommand\" -a add -d \"Add an endpoint\"",
    "complete -c oc -f -n \"__fish_use_subcommand\" -a use -d \"Switch to an endpoint\"",
    "complete -c oc -f -n \"__fish_use_subcommand\" -a del -d \"Delete an endpoint\"",
    "complete -c oc -f -n \"__fish_use_subcommand\" -a current -d \"Show current endpoint\"",
    "complete -c oc -f -n \"__fish_use_subcommand\" -a help -d \"Show help\"",
    "",
    "function __oc_endpoint_names",
    "    oc list 2>/dev/null | string trim | string replace -r '^\\d+\\.\\s+(\\S+).*' '$1'",
    "end",
    "",
    "complete -c oc -f -n \"__fish_seen_subcommand_from use\" -a \"(__oc_endpoint_names)\"",
    "complete -c oc -f -n \"__fish_seen_subcommand_from del\" -a \"(__oc_endpoint_names)\"",
  ];
  for (let i = 0; i < lines.length; i++) {
    console.log(lines[i]);
  }
}

function printHelp(): void {
  console.log("oc - opencode proxy switcher");
  console.log("");
  console.log("Usage:");
  console.log("  oc                    Show current endpoint");
  console.log("  oc list               List all endpoints");
  console.log("  oc add NAME URL       Add an endpoint");
  console.log("  oc use NAME           Switch client configs to an endpoint");
  console.log("  oc del NAME           Delete an endpoint");
  console.log("  oc current            Show current endpoint");
  console.log("  oc completion fish    Generate fish shell completions");
  console.log("  oc help               Show this help");
  console.log("");
  console.log("Config:  " + CONFIG_FILE);
  console.log("Kimi:    ~/.kimi-code/config.toml");
  console.log("OpenCode: ~/.config/opencode/opencode.jsonc");
  console.log("");
  console.log("Install:");
  console.log("  curl -fsSL https://github.com/3kaiu/opencode-proxy/raw/main/install.sh | sh");
  console.log("");
  console.log("Uninstall:");
  console.log("  rm ~/bin/oc && rm -rf ~/.oc");
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
    case "current": cmdCurrent(); break;
    case "completion": cmdCompletion(args); break;
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
