import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Transport = "stdio" | "http" | "sse";

export interface ServerSpec {
  name: string;
  /** Config file the spec came from. */
  source: string;
  transport: Transport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

/** Known client config locations. Order matters only for reporting. */
export function defaultConfigPaths(cwd: string = process.cwd()): string[] {
  const home = homedir();
  return [
    join(cwd, ".mcp.json"),
    join(cwd, ".cursor", "mcp.json"),
    join(cwd, ".vscode", "mcp.json"),
    join(home, ".claude.json"),
    join(home, ".config", "Claude", "claude_desktop_config.json"),
    join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    join(home, ".cursor", "mcp.json"),
    join(home, ".config", "Code", "User", "mcp.json"),
  ];
}

function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (whole, name: string) => process.env[name] ?? whole);
}

function expandEnvMap(map: unknown): Record<string, string> | undefined {
  if (!map || typeof map !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = expandEnv(v);
  }
  return out;
}

function toSpec(name: string, raw: unknown, source: string): ServerSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const type = typeof r.type === "string" ? r.type.toLowerCase() : undefined;
  if (typeof r.url === "string") {
    const transport: Transport = type === "sse" ? "sse" : "http";
    return { name, source, transport, url: expandEnv(r.url), headers: expandEnvMap(r.headers) };
  }
  if (typeof r.command === "string") {
    const args = Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === "string").map(expandEnv) : [];
    return {
      name,
      source,
      transport: "stdio",
      command: expandEnv(r.command),
      args,
      env: expandEnvMap(r.env),
      cwd: typeof r.cwd === "string" ? expandEnv(r.cwd) : undefined,
    };
  }
  return null;
}

/** Parse one client config. Accepts `mcpServers` (Claude, Cursor, .mcp.json) and `servers` (VS Code). */
export function loadConfig(path: string, cwd: string = process.cwd()): ServerSpec[] {
  const text = readFileSync(path, "utf8");
  const json = JSON.parse(text) as Record<string, unknown>;
  const specs: ServerSpec[] = [];
  const buckets: Array<Record<string, unknown>> = [];
  if (json.mcpServers && typeof json.mcpServers === "object") buckets.push(json.mcpServers as Record<string, unknown>);
  if (json.servers && typeof json.servers === "object") buckets.push(json.servers as Record<string, unknown>);
  // Claude Code keeps per-project servers under projects[<path>].mcpServers.
  if (json.projects && typeof json.projects === "object") {
    const projects = json.projects as Record<string, Record<string, unknown>>;
    const project = projects[cwd];
    if (project?.mcpServers && typeof project.mcpServers === "object") buckets.push(project.mcpServers as Record<string, unknown>);
  }
  for (const bucket of buckets) {
    for (const [name, raw] of Object.entries(bucket)) {
      const spec = toSpec(name, raw, path);
      if (spec) specs.push(spec);
    }
  }
  return specs;
}

export interface Discovery {
  specs: ServerSpec[];
  scanned: string[];
  skipped: Array<{ path: string; reason: string }>;
}

/** Load explicit paths, or every default path that exists. Same-name servers with identical launch config are deduped. */
export function discoverServers(paths?: string[], cwd: string = process.cwd()): Discovery {
  const candidates = paths && paths.length > 0 ? paths : defaultConfigPaths(cwd).filter((p) => existsSync(p));
  const specs: ServerSpec[] = [];
  const scanned: string[] = [];
  const skipped: Discovery["skipped"] = [];
  const seen = new Map<string, string>();
  for (const path of candidates) {
    if (!existsSync(path)) {
      skipped.push({ path, reason: "not found" });
      continue;
    }
    let loaded: ServerSpec[];
    try {
      loaded = loadConfig(path, cwd);
    } catch (err) {
      skipped.push({ path, reason: (err as Error).message });
      continue;
    }
    scanned.push(path);
    for (const spec of loaded) {
      const signature = JSON.stringify([spec.transport, spec.command, spec.args, spec.url]);
      const prior = seen.get(spec.name);
      if (prior === signature) continue;
      if (prior !== undefined) spec.name = `${spec.name}@${shortSource(path)}`;
      seen.set(spec.name, signature);
      specs.push(spec);
    }
  }
  return { specs, scanned, skipped };
}

function shortSource(path: string): string {
  return path.replace(homedir(), "~");
}
