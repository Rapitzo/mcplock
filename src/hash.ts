import { createHash } from "node:crypto";

/** Tool surface as seen by the client. This is what an agent trusts. */
export interface ToolRecord {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

/** Deterministic JSON: sorted object keys, arrays kept in order, undefined dropped. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function toolHash(tool: ToolRecord): string {
  const subject = {
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema ?? null,
    outputSchema: tool.outputSchema ?? null,
    annotations: tool.annotations ?? null,
  };
  return "sha256:" + sha256Hex(canonicalize(subject));
}

/** Order-independent digest over a server's tool hashes. */
export function serverDigest(toolHashes: string[]): string {
  return "sha256:" + sha256Hex([...toolHashes].sort().join("\n"));
}
