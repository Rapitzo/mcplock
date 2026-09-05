import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ServerSpec, Transport } from "./config.ts";
import { canonicalize, serverDigest, toolHash, type ToolRecord } from "./hash.ts";
import type { ServerInfo } from "./connect.ts";

export interface LockedTool {
  hash: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

export interface LockedServer {
  transport: Transport;
  command?: string;
  args?: string[];
  url?: string;
  source: string;
  serverInfo?: ServerInfo;
  digest: string;
  lockedAt: string;
  tools: Record<string, LockedTool>;
}

export interface Lockfile {
  version: 1;
  generatedAt: string;
  servers: Record<string, LockedServer>;
}

export function readLockfile(path: string): Lockfile | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Lockfile;
  if (parsed.version !== 1 || typeof parsed.servers !== "object") {
    throw new Error(`${path}: unsupported lockfile format`);
  }
  return parsed;
}

export function writeLockfile(path: string, lock: Lockfile): void {
  writeFileSync(path, JSON.stringify(lock, null, 2) + "\n");
}

export function buildLockedServer(spec: ServerSpec, tools: ToolRecord[], serverInfo?: ServerInfo, now = new Date()): LockedServer {
  const locked: Record<string, LockedTool> = {};
  for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    locked[tool.name] = {
      hash: toolHash(tool),
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
    };
  }
  return {
    transport: spec.transport,
    ...(spec.command ? { command: spec.command, args: spec.args ?? [] } : {}),
    ...(spec.url ? { url: spec.url } : {}),
    source: spec.source,
    ...(serverInfo ? { serverInfo } : {}),
    digest: serverDigest(Object.values(locked).map((t) => t.hash)),
    lockedAt: now.toISOString(),
    tools: locked,
  };
}

export type ChangeKind =
  | "server-added"
  | "server-removed"
  | "launch-changed"
  | "tool-added"
  | "tool-removed"
  | "description-changed"
  | "input-schema-changed"
  | "output-schema-changed"
  | "annotations-changed";

export interface Change {
  server: string;
  kind: ChangeKind;
  tool?: string;
  before?: unknown;
  after?: unknown;
}

/** Field-level diff between the locked surface and what the server serves now. */
export function diffServer(name: string, locked: LockedServer | undefined, current: LockedServer | undefined): Change[] {
  const changes: Change[] = [];
  if (!locked && !current) return changes;
  if (!locked) return [{ server: name, kind: "server-added", after: Object.keys(current!.tools) }];
  if (!current) return [{ server: name, kind: "server-removed", before: Object.keys(locked.tools) }];

  const launchBefore = canonicalize([locked.transport, locked.command, locked.args, locked.url]);
  const launchAfter = canonicalize([current.transport, current.command, current.args, current.url]);
  if (launchBefore !== launchAfter) {
    changes.push({ server: name, kind: "launch-changed", before: launchBefore, after: launchAfter });
  }
  if (locked.digest === current.digest) return changes;

  const names = new Set([...Object.keys(locked.tools), ...Object.keys(current.tools)]);
  for (const tool of [...names].sort()) {
    const a = locked.tools[tool];
    const b = current.tools[tool];
    if (!a) {
      changes.push({ server: name, kind: "tool-added", tool, after: b.description });
      continue;
    }
    if (!b) {
      changes.push({ server: name, kind: "tool-removed", tool, before: a.description });
      continue;
    }
    if (a.hash === b.hash) continue;
    if (a.description !== b.description) {
      changes.push({ server: name, kind: "description-changed", tool, before: a.description, after: b.description });
    }
    if (canonicalize(a.inputSchema) !== canonicalize(b.inputSchema)) {
      changes.push({ server: name, kind: "input-schema-changed", tool, before: a.inputSchema, after: b.inputSchema });
    }
    if (canonicalize(a.outputSchema ?? null) !== canonicalize(b.outputSchema ?? null)) {
      changes.push({ server: name, kind: "output-schema-changed", tool, before: a.outputSchema, after: b.outputSchema });
    }
    if (canonicalize(a.annotations ?? null) !== canonicalize(b.annotations ?? null)) {
      changes.push({ server: name, kind: "annotations-changed", tool, before: a.annotations, after: b.annotations });
    }
  }
  return changes;
}
