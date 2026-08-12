// oc.ts - opencode proxy switcher CLI
// Build: scriptc build cli/oc.ts -o cli/oc
//
// 端点列表存储在本地 ~/.oc/config.json（不存任何凭据）
// oc use 切换时自动更新本地的 opencode 配置（全局 + 项目级发现）
//
// Usage:
//   oc                    Show current endpoint
//   oc list               List all endpoints
//   oc add NAME URL       Add an endpoint
//   oc use NAME           Switch opencode config to an endpoint
//   oc del NAME           Delete an endpoint
//   oc test [NAME]        Check endpoint reachability (all if NAME omitted)
//   oc current            Show current endpoint
//   oc completion fish    Generate fish shell completions
//   oc help               Show this help

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

const HOME = homedir();
const CONFIG_FILE = HOME + "/.oc/config.json";
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

type JsonObject = Record<string, unknown>;

// ── Helpers ─────────────────────────────────────────────

const asObject = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;

// Strip // and /* */ comments plus trailing commas so JSON.parse can read
// opencode's jsonc configs. Strings pass through verbatim.
function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let lineComment = false;
  let blockComment = false;
  let pendingComma = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1] ?? "";
    if (lineComment) {
      if (c === "\n") {
        lineComment = false;
        out += c;
      }
      continue;
    }
    if (blockComment) {
      if (c === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next;
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }
    if (c === ",") {
      pendingComma = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      out += c;
      continue;
    }
    if (pendingComma) {
      if (c === "}" || c === "]") {
        pendingComma = false;
        out += c;
        continue;
      }
      out += ",";
      pendingComma = false;
    }
    if (c === '"') {
      out += c;
      inString = true;
      continue;
    }
    out += c;
  }
  return out;
}

function parseJsonc(text: string): JsonObject | null {
  try {
    return asObject(JSON.parse(stripJsonc(text)));
  } catch {
    return null;
  }
}

function cmdExists(cmd: string): boolean {
  try {
    return spawnSync("which", [cmd], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end--;
  return value.slice(0, end);
}

function log(ok: boolean, message: string): void {
  console.log("  " + (ok ? "✓" : "-") + " " + message);
}

// ── Config I/O ──────────────────────────────────────────

function loadConfig(): OcConfig {
  try {
    const root = parseJsonc(readFileSync(CONFIG_FILE, "utf8"));
    const endpoints: Endpoint[] = [];
    if (Array.isArray(root?.endpoints)) {
      for (const item of root.endpoints) {
        const ep = asObject(item);
        if (ep && typeof ep.name === "string" && typeof ep.url === "string") {
          endpoints.push({ name: ep.name, url: ep.url });
        }
      }
    }
    return { current: typeof root?.current === "string" ? root.current : null, endpoints };
  } catch {
    return { current: null, endpoints: [] };
  }
}

function saveConfig(cfg: OcConfig): void {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify({ current: cfg.current, endpoints: cfg.endpoints }, null, 2) + "\n");
}

function findEndpoint(endpoints: Endpoint[], name: string): Endpoint | null {
  for (const ep of endpoints) {
    if (ep.name === name) return ep;
  }
  const lower = name.toLowerCase();
  for (const ep of endpoints) {
    if (ep.name.toLowerCase() === lower) return ep;
  }
  const idx = parseInt(name, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= endpoints.length) {
    return endpoints[idx - 1];
  }
  return null;
}

// ── Update OpenCode configs ─────────────────────────────

// Discover existing opencode config files: global config dir, ~/.opencode,
// then project-level opencode.json(c) in cwd and parent dirs, plus .opencode/
// dirs walking up from cwd. opencode.jsonc is loaded after opencode.json,
// so when both exist the jsonc baseURL wins.
function discoverOpenCodeConfigs(): string[] {
  const result: string[] = [];
  const seen: string[] = [];
  const consider = (dir: string) => {
    for (const name of ["opencode.jsonc", "opencode.json"]) {
      const file = join(dir, name);
      if (seen.indexOf(file) === -1 && existsSync(file)) {
        seen.push(file);
        result.push(file);
      }
    }
  };
  consider(HOME + "/.config/opencode");
  consider(HOME + "/.opencode");
  let dir = process.cwd();
  while (true) {
    consider(dir);
    consider(join(dir, ".opencode"));
    const parent = dirname(dir);
    if (parent === dir || dir === HOME) break;
    dir = parent;
  }
  return result;
}

// scriptc static builds silently drop nested property assignment on JSON.parse
// results, so opencode config files are edited as raw: parse first to validate,
// then splice the string value in. Returns "updated"/"unchanged"/"failed" so
// callers can tell a real parse error apart from "already on the right URL".
function updateSingleOpenCode(configPath: string, url: string): "updated" | "unchanged" | "failed" {
  try {
    const original = readFileSync(configPath, "utf8");
    if (!parseJsonc(original)) return "failed";
    const next = editOpenCodeConfig(original, url);
    if (next === original) return "unchanged";
    writeFileSync(configPath, next);
    return "updated";
  } catch {
    return "failed";
  }
}

// Find the index of a `"key":` property, skipping whitespace before the colon.
function findKey(text: string, key: string, from: number): number {
  const needle = '"' + key + '"';
  let idx = text.indexOf(needle, from);
  while (idx !== -1) {
    let i = idx + needle.length;
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
    if (text[i] === ":") return idx;
    idx = text.indexOf(needle, idx + 1);
  }
  return -1;
}

// Index of the `{` opening the object that `keyIdx` points at.
function findBlockBody(text: string, keyIdx: number): number {
  const colon = text.indexOf(":", keyIdx);
  if (colon === -1) return -1;
  let i = colon + 1;
  while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  return text[i] === "{" ? i : -1;
}

// Index of the `}` closing the object opened at `openIdx`, skipping strings
// and comments.
function findBlockEnd(text: string, openIdx: number): number {
  let depth = 0;
  let inString = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1] ?? "";
    if (inString) {
      if (c === "\\") {
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function isEmptyBlock(text: string, openIdx: number, closeIdx: number): boolean {
  for (let i = openIdx + 1; i < closeIdx; i++) {
    const c = text[i];
    if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") return false;
  }
  return true;
}

// Replace the string value of the property at `keyIdx` and return the new
// text, or the original text when the value is not a quoted string.
function replaceStringValue(text: string, keyIdx: number, value: string): string {
  const colon = text.indexOf(":", keyIdx);
  if (colon === -1) return text;
  let i = colon + 1;
  while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  if (text[i] !== '"') return text;
  const valueStart = i;
  i++;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
    } else if (text[i] === '"') {
      return text.slice(0, valueStart + 1) + value + text.slice(i);
    } else {
      i++;
    }
  }
  return text;
}

// Splice `chunk` right before the root object's closing brace.
function insertBeforeRootClose(text: string, chunk: string): string {
  const close = text.lastIndexOf("}");
  if (close === -1) return text;
  return text.slice(0, close) + chunk + text.slice(close);
}

// Fetch models from the proxy endpoint
function fetchModels(url: string): Record<string, { name: string }> | null {
  // Only keep deepseek-v4-flash-free as requested
  return {
    "deepseek-v4-flash-free": { name: "deepseek-v4-flash-free" }
  };
}

function editOpenCodeConfig(text: string, url: string): string {
  const ocEntry =
    '"oc": {\n' +
    '      "npm": "@ai-sdk/openai-compatible",\n' +
    '      "name": "oc proxy",\n' +
    '      "options": { "baseURL": "' + url + '" },\n' +
    '      "request": { "headers": {}, "body": { "apiKey": "public" } }\n' +
    "    }";
  const providerIdx = findKey(text, "provider", 0);
  if (providerIdx === -1) {
    const rootOpen = text.indexOf("{");
    const rootClose = text.lastIndexOf("}");
    if (rootOpen === -1 || rootClose === -1) return text;
    let before = rootClose;
    while (before > rootOpen && (text[before - 1] === " " || text[before - 1] === "\t" || text[before - 1] === "\n" || text[before - 1] === "\r")) before--;
    const tail = text.slice(before, rootClose);
    if (before === rootOpen + 1 || (before > rootOpen + 1 && isEmptyBlock(text, rootOpen, before))) {
      const chunk = '"provider": {\n    ' + ocEntry + "\n  }";
      return text.slice(0, rootOpen + 1) + "\n  " + chunk + "\n" + text.slice(rootClose);
    }
    const hasTrailingComma = before > rootOpen && text[before - 1] === ",";
    const separator = hasTrailingComma ? "\n  " : ",\n  ";
    const chunk = '"provider": {\n    ' + ocEntry + "\n  }";
    return text.slice(0, before) + separator + chunk + tail + text.slice(rootClose);
  }
  const providerBody = findBlockBody(text, providerIdx);
  if (providerBody === -1) return text;
  const providerEnd = findBlockEnd(text, providerBody);
  if (providerEnd === -1) return text;
  const ocIdx = findKey(text, "oc", providerBody);
  if (ocIdx === -1 || ocIdx > providerEnd) {
    const chunk = (isEmptyBlock(text, providerBody, providerEnd) ? "" : ",\n    ") + ocEntry;
    return text.slice(0, providerEnd) + chunk + text.slice(providerEnd);
  }
  const ocBody = findBlockBody(text, ocIdx);
  if (ocBody === -1 || ocBody > providerEnd) return text;
  const ocEnd = findBlockEnd(text, ocBody);
  if (ocEnd === -1 || ocEnd > providerEnd) return text;
  const urlIdx = findKey(text, "baseURL", ocIdx);
  if (urlIdx !== -1 && urlIdx < ocEnd) return replaceStringValue(text, urlIdx, url);
  const optionsIdx = findKey(text, "options", ocIdx);
  if (optionsIdx !== -1 && optionsIdx < ocEnd) {
    const optionsBody = findBlockBody(text, optionsIdx);
    if (optionsBody !== -1 && optionsBody < ocEnd) {
      return text.slice(0, optionsBody + 1) + ' "baseURL": "' + url + '",' + text.slice(optionsBody + 1);
    }
    return text;
  }
  const chunk = (isEmptyBlock(text, ocBody, ocEnd) ? "" : ",\n      ") + '"options": { "baseURL": "' + url + '" }';
  return text.slice(0, ocEnd) + chunk + text.slice(ocEnd);
}

function updateOpenCode(url: string): void {
  const configs = discoverOpenCodeConfigs();
  let updated = 0;
  let unchanged = 0;
  let failed = 0;
  for (const configPath of configs) {
    const result = updateSingleOpenCode(configPath, url);
    if (result === "updated") updated++;
    else if (result === "unchanged") unchanged++;
    else failed++;
  }
  if (updated > 0) {
    log(true, "OpenCode -> updated " + updated + " config(s)");
    if (unchanged > 0) log(false, "  " + unchanged + " config(s) already up to date");
    return;
  }
  if (configs.length > 0 && unchanged === configs.length) {
    log(true, "OpenCode -> up to date (" + unchanged + " config(s))");
    return;
  }
  if (configs.length > 0) {
    log(false, "OpenCode -> skipped (" + failed + " config(s) not parseable)");
    return;
  }
  if (!(cmdExists("opencode") || existsSync(HOME + "/.opencode"))) {
    log(false, "OpenCode -> skipped (not installed)");
    return;
  }
  const defaultPath = HOME + "/.config/opencode/opencode.jsonc";
  mkdirSync(dirname(defaultPath), { recursive: true });
  const models = fetchModels(url);
  const config: Record<string, unknown> = {
    provider: {
      [PROVIDER]: {
        npm: "@ai-sdk/openai-compatible",
        name: "oc proxy",
        options: { baseURL: url },
        request: { headers: {}, body: { apiKey: "public" } },
        models: models || {},
      },
    },
  };
  writeFileSync(defaultPath, JSON.stringify(config, null, 2) + "\n");
  log(true, "OpenCode -> created provider." + PROVIDER);
}

// ── Commands ────────────────────────────────────────────

function cmdCurrent(): void {
  const cfg = loadConfig();
  const ep = cfg.current ? findEndpoint(cfg.endpoints, cfg.current) : null;
  if (!ep) {
    console.log("No endpoint selected. Use: oc use NAME");
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
    console.log("  " + (i + 1) + ". " + ep.name + (ep.name === cfg.current ? " ←" : ""));
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
  if (!/^https?:\/\/\S+$/.test(url)) {
    console.log("Invalid URL: " + url);
    return;
  }
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
  const cfg = loadConfig();
  const ep = findEndpoint(cfg.endpoints, args.join(" "));
  if (!ep) {
    console.log('Endpoint "' + args.join(" ") + '" not found. Run "oc list" to see options.');
    process.exit(1);
  }
  console.log("Switching to: " + ep.name);
  console.log("URL:          " + ep.url);
  console.log("");
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
  const cfg = loadConfig();
  const ep = findEndpoint(cfg.endpoints, args.join(" "));
  if (!ep) {
    console.log('Endpoint "' + args.join(" ") + '" not found.');
    process.exit(1);
  }
  cfg.endpoints.splice(cfg.endpoints.indexOf(ep), 1);
  if (cfg.current === ep.name) {
    cfg.current = null;
  }
  saveConfig(cfg);
  console.log("✓ Deleted: " + ep.name);
}

function cmdTest(args: string[]): void {
  const cfg = loadConfig();
  const name = args.length > 0 ? args.join(" ") : "";
  if (name) {
    const ep = findEndpoint(cfg.endpoints, name);
    if (!ep) {
      console.log('Endpoint "' + name + '" not found.');
      return;
    }
    probeEndpoints([ep]);
    return;
  }
  if (cfg.endpoints.length === 0) {
    console.log("No endpoints. Use: oc add NAME URL");
    return;
  }
  probeEndpoints(cfg.endpoints);
}

function probeEndpoints(endpoints: Endpoint[]): void {
  for (const ep of endpoints) {
    const probe = stripTrailingSlashes(ep.url) + "/models";
    let status: string;
    try {
      const res = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code} %{time_total}", "-m", "5", probe]);
      status = res.status === 0 ? String(res.stdout).trim() : "unreachable";
    } catch {
      status = "unreachable";
    }
    console.log(status.startsWith("2") || status.startsWith("3") ? "  ✓" : "  ✗", ep.name + "  " + status);
  }
}

function cmdCompletion(): void {
  const lines = [
    "# Fish completions for oc (opencode proxy switcher)",
    "",
    "complete -c oc -f -n \"__fish_use_subcommand\" -a list -d \"List all endpoints\"",
    "complete -c oc -f -n \"__fish_use_subcommand\" -a add -d \"Add an endpoint\"",
    "complete -c oc -f -n \"__fish_use_subcommand\" -a use -d \"Switch to an endpoint\"",
    "complete -c oc -f -n \"__fish_use_subcommand\" -a del -d \"Delete an endpoint\"",
    "complete -c oc -f -n \"__fish_use_subcommand\" -a test -d \"Check endpoint reachability\"",
    "complete -c oc -f -n \"__fish_use_subcommand\" -a current -d \"Show current endpoint\"",
    "complete -c oc -f -n \"__fish_use_subcommand\" -a help -d \"Show help\"",
    "",
    "function __oc_endpoint_names",
    "    oc list 2>/dev/null | string trim | string replace -r '^\\d+\\.\\s+(\\S+).*' '$1'",
    "end",
    "",
    "complete -c oc -f -n \"__fish_seen_subcommand_from use\" -a \"(__oc_endpoint_names)\"",
    "complete -c oc -f -n \"__fish_seen_subcommand_from del\" -a \"(__oc_endpoint_names)\"",
    "complete -c oc -f -n \"__fish_seen_subcommand_from test\" -a \"(__oc_endpoint_names)\"",
  ];
  for (const line of lines) {
    console.log(line);
  }
}

function printHelp(): void {
  console.log("oc - opencode proxy switcher");
  console.log("");
  console.log("Usage:");
  console.log("  oc                    Show current endpoint");
  console.log("  oc list               List all endpoints");
  console.log("  oc add NAME URL       Add an endpoint");
  console.log("  oc use NAME           Switch opencode config to an endpoint");
  console.log("  oc del NAME           Delete an endpoint");
  console.log("  oc test [NAME]        Check endpoint reachability");
  console.log("  oc current            Show current endpoint");
  console.log("  oc completion fish    Generate fish shell completions");
  console.log("  oc help               Show this help");
  console.log("");
  console.log("Config:  " + CONFIG_FILE);
  console.log("OpenCode: ~/.config/opencode/opencode.json(c) / ~/.opencode / 项目级 .opencode 与 opencode.json(c)");
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
    case "list": cmdList(); break;
    case "add": cmdAdd(args); break;
    case "use": cmdUse(args); break;
    case "del": cmdDel(args); break;
    case "test": cmdTest(args); break;
    case "current": cmdCurrent(); break;
    case "completion": cmdCompletion(); break;
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
