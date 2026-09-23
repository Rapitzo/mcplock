#!/usr/bin/env bun
import { resolve } from "node:path";
import { discoverServers, type ServerSpec } from "./config.ts";
import { fetchTools } from "./connect.ts";
import { buildLockedServer, diffServer, readLockfile, writeLockfile, type Change, type Lockfile, type LockedServer } from "./lockfile.ts";
import { rank, scanServers, type Finding, type Severity } from "./poison.ts";
import { bold, dim, formatChanges, formatFindings, green, red, yellow } from "./report.ts";

const EXIT = { ok: 0, drift: 1, poison: 2, error: 3 } as const;

interface Options {
  command: string;
  configs: string[];
  lock: string;
  servers: string[];
  timeoutMs: number;
  json: boolean;
  verbose: boolean;
  update: boolean;
  live: boolean;
  failOn: Severity | "none";
}

const HELP = `mcplock: lockfile and tool-poisoning scanner for MCP servers

Usage
  mcplock init    [options]   connect to every configured server, write mcp.lock.json, scan for poisoned text
  mcplock check   [options]   reconnect, diff against the lockfile, exit non-zero on drift or poisoned text
  mcplock scan    [options]   scan tool text for prompt-injection patterns (lockfile by default, --live to fetch)
  mcplock configs [options]   list the client configs and servers mcplock can see

Options
  --config <path>     client config to read (repeatable). Default: every known Claude/Cursor/VS Code/.mcp.json path that exists
  --lock <path>       lockfile path. Default: ./mcp.lock.json
  --server <name>     only this server (repeatable)
  --timeout <ms>      per-server connect+list timeout. Default: 20000
  --fail-on <level>   high | medium | low | none. Findings at or above this level fail the run. Default: high
  --update            with check: rewrite the lockfile after reporting drift
  --live              with scan: fetch tools from servers instead of reading the lockfile
  --json              machine-readable output
  --verbose           pass server stderr through
  -h, --help

Exit codes  0 clean · 1 drift · 2 poisoned text at/above --fail-on · 3 config or connection error`;

function parse(argv: string[]): Options {
  const o: Options = {
    command: "",
    configs: [],
    lock: "mcp.lock.json",
    servers: [],
    timeoutMs: 20_000,
    json: false,
    verbose: false,
    update: false,
    live: false,
    failOn: "high",
  };
  const rest = [...argv];
  const need = (flag: string): string => {
    const v = rest.shift();
    if (v === undefined) throw new Error(`${flag} needs a value`);
    return v;
  };
  while (rest.length) {
    const a = rest.shift()!;
    switch (a) {
      case "--config": o.configs.push(resolve(need(a))); break;
      case "--lock": o.lock = resolve(need(a)); break;
      case "--server": o.servers.push(need(a)); break;
      case "--timeout": o.timeoutMs = Number(need(a)); break;
      case "--fail-on": {
        const v = need(a);
        if (!["high", "medium", "low", "none"].includes(v)) throw new Error(`--fail-on: unknown level "${v}"`);
        o.failOn = v as Options["failOn"];
        break;
      }
      case "--json": o.json = true; break;
      case "--verbose": o.verbose = true; break;
      case "--update": o.update = true; break;
      case "--live": o.live = true; break;
      case "-h": case "--help": o.command = "help"; break;
      default:
        if (a.startsWith("-")) throw new Error(`unknown flag ${a}`);
        if (o.command) throw new Error(`unexpected argument ${a}`);
        o.command = a;
    }
  }
  if (!o.command) o.command = "help";
  return o;
}

function log(o: Options, line: string): void {
  if (!o.json) console.log(line);
}

async function collect(o: Options): Promise<{ servers: Record<string, LockedServer>; errors: string[]; specs: ServerSpec[] }> {
  const { specs: all, scanned, skipped } = discoverServers(o.configs);
  const specs = o.servers.length ? all.filter((s) => o.servers.includes(s.name)) : all;
  if (scanned.length === 0) throw new Error("no client config found; pass --config <path>");
  for (const s of skipped) if (o.configs.length) log(o, yellow(`skip ${s.path}: ${s.reason}`));
  if (specs.length === 0) throw new Error(`no servers found in ${scanned.join(", ")}`);
  const servers: Record<string, LockedServer> = {};
  const errors: string[] = [];
  const results = await Promise.all(
    specs.map(async (spec) => {
      try {
        const { tools, serverInfo } = await fetchTools(spec, o.timeoutMs, o.verbose);
        return { spec, locked: buildLockedServer(spec, tools, serverInfo) };
      } catch (err) {
        return { spec, error: (err as Error).message };
      }
    }),
  );
  for (const r of results) {
    if ("locked" in r && r.locked) {
      servers[r.spec.name] = r.locked;
      log(o, `${green("✓")} ${r.spec.name} ${dim(`${Object.keys(r.locked.tools).length} tools · ${r.locked.digest.slice(0, 19)}`)}`);
    } else if ("error" in r) {
      errors.push(`${r.spec.name}: ${r.error}`);
      log(o, `${red("✗")} ${r.spec.name} ${dim(r.error)}`);
    }
  }
  return { servers, errors, specs };
}

function failing(findings: Finding[], failOn: Options["failOn"]): Finding[] {
  if (failOn === "none") return [];
  return findings.filter((f) => rank(f.severity) >= rank(failOn));
}

async function cmdInit(o: Options): Promise<number> {
  const { servers, errors } = await collect(o);
  const lock: Lockfile = { version: 1, generatedAt: new Date().toISOString(), servers };
  const findings = scanServers(servers);
  writeLockfile(o.lock, lock);
  if (o.json) console.log(JSON.stringify({ lock: o.lock, servers: Object.keys(servers), errors, findings }, null, 2));
  else {
    console.log(`\n${bold("wrote")} ${o.lock} ${dim(`(${Object.keys(servers).length} servers)`)}`);
    console.log(formatFindings(findings));
  }
  if (failing(findings, o.failOn).length) return EXIT.poison;
  return errors.length ? EXIT.error : EXIT.ok;
}

async function cmdCheck(o: Options): Promise<number> {
  const lock = readLockfile(o.lock);
  if (!lock) throw new Error(`${o.lock} not found; run "mcplock init" first`);
  const { servers, errors } = await collect(o);
  const names = new Set([...Object.keys(lock.servers), ...Object.keys(servers)]);
  if (o.servers.length) for (const n of [...names]) if (!o.servers.includes(n)) names.delete(n);
  const changes: Change[] = [];
  for (const name of [...names].sort()) {
    if (!servers[name] && errors.some((e) => e.startsWith(`${name}:`))) continue; // unreachable, not removed
    changes.push(...diffServer(name, lock.servers[name], servers[name]));
  }
  const findings = scanServers(servers);
  // New findings only: text that was already locked was already seen.
  const known = new Set(scanServers(lock.servers).map((f) => `${f.server}/${f.tool}/${f.field}/${f.rule}`));
  const fresh = findings.filter((f) => !known.has(`${f.server}/${f.tool}/${f.field}/${f.rule}`));
  if (o.json) console.log(JSON.stringify({ changes, findings: fresh, errors }, null, 2));
  else {
    console.log("\n" + formatChanges(changes));
    if (fresh.length) console.log("\n" + formatFindings(fresh));
  }
  if (o.update && changes.length) {
    for (const name of Object.keys(servers)) lock.servers[name] = servers[name];
    for (const c of changes) if (c.kind === "server-removed") delete lock.servers[c.server];
    lock.generatedAt = new Date().toISOString();
    writeLockfile(o.lock, lock);
    log(o, dim(`updated ${o.lock}`));
  }
  if (failing(fresh, o.failOn).length) return EXIT.poison;
  if (changes.length) return EXIT.drift;
  return errors.length ? EXIT.error : EXIT.ok;
}

async function cmdScan(o: Options): Promise<number> {
  let servers: Record<string, LockedServer>;
  let errors: string[] = [];
  if (o.live) ({ servers, errors } = await collect(o));
  else {
    const lock = readLockfile(o.lock);
    if (!lock) throw new Error(`${o.lock} not found; run "mcplock init" or pass --live`);
    servers = lock.servers;
    if (o.servers.length) servers = Object.fromEntries(Object.entries(servers).filter(([n]) => o.servers.includes(n)));
  }
  const findings = scanServers(servers);
  if (o.json) console.log(JSON.stringify({ findings, errors }, null, 2));
  else console.log(formatFindings(findings));
  if (failing(findings, o.failOn).length) return EXIT.poison;
  return errors.length ? EXIT.error : EXIT.ok;
}

function cmdConfigs(o: Options): number {
  const d = discoverServers(o.configs);
  if (o.json) {
    console.log(JSON.stringify(d, null, 2));
    return EXIT.ok;
  }
  for (const path of d.scanned) {
    console.log(bold(path));
    for (const s of d.specs.filter((s) => s.source === path)) {
      const launch = s.transport === "stdio" ? `${s.command} ${(s.args ?? []).join(" ")}` : s.url;
      console.log(`  ${s.name} ${dim(`[${s.transport}] ${launch}`)}`);
    }
  }
  for (const s of d.skipped) console.log(yellow(`skip ${s.path}: ${s.reason}`));
  if (d.scanned.length === 0) console.log(yellow("no client config found"));
  return EXIT.ok;
}

async function main(): Promise<number> {
  let o: Options;
  try {
    o = parse(process.argv.slice(2));
  } catch (err) {
    console.error(red((err as Error).message));
    console.error(HELP);
    return EXIT.error;
  }
  try {
    switch (o.command) {
      case "init": return await cmdInit(o);
      case "check": return await cmdCheck(o);
      case "scan": return await cmdScan(o);
      case "configs": return cmdConfigs(o);
      case "help": console.log(HELP); return EXIT.ok;
      default:
        console.error(red(`unknown command "${o.command}"`));
        console.error(HELP);
        return EXIT.error;
    }
  } catch (err) {
    console.error(red((err as Error).message));
    return EXIT.error;
  }
}

process.exit(await main());
