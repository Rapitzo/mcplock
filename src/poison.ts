import type { LockedTool } from "./lockfile.ts";

export type Severity = "high" | "medium" | "low";

export interface Finding {
  server: string;
  tool: string;
  /** Where in the tool surface the text lives: "description" or "inputSchema.<path>". */
  field: string;
  rule: string;
  severity: Severity;
  message: string;
  excerpt: string;
}

interface Rule {
  id: string;
  severity: Severity;
  message: string;
  pattern: RegExp;
}

/** Text patterns that mark tool descriptions designed to steer the model rather than describe the tool. */
const RULES: Rule[] = [
  {
    id: "instruction-override",
    severity: "high",
    message: "Overrides prior instructions",
    pattern: /\b(ignore|disregard|forget|override)\b[^.]{0,40}\b(previous|prior|above|earlier|all|system)\b[^.]{0,20}\b(instructions?|rules?|guidance|prompt)\b/i,
  },
  {
    id: "concealment",
    severity: "high",
    message: "Instructs the model to hide behaviour from the user",
    pattern:
      /\b(do not|don'?t|never|without|avoid)\b[^.]{0,30}\b(tell|telling|inform|informing|mention|mentioning|reveal|revealing|show|showing|disclose|disclosing|alert|alerting|ask|asking|notify|notifying)\b[^.]{0,20}\b(the\s+)?users?\b|\bkeep (this|it) (secret|hidden|quiet)\b/i,
  },
  {
    id: "secret-path",
    severity: "high",
    message: "References a private key or credential store",
    pattern: /(~|\$HOME|\/home\/\w+|\/Users\/\w+|\.)?\/?\.(ssh|aws|gnupg|gpg|kube|docker\/config\.json)\b|\bid_(rsa|ed25519|ecdsa|dsa)\b|\bcredentials\.json\b|\bwallet\.dat\b|\bkeystore\b|\bkeychain\b/i,
  },
  {
    id: "config-file",
    severity: "medium",
    message: "References a dotfile that commonly holds secrets",
    pattern: /(^|[\s"'`(\/])\.(env(\.\w+)?|netrc|npmrc|pypirc|git-credentials)\b/i,
  },
  {
    id: "hidden-tag",
    severity: "high",
    message: "Contains a pseudo-system tag",
    pattern: /<\s*\/?\s*(important|system|hidden|secret|instructions?|admin|assistant|developer|note_to_ai|ai_only)\b[^>]*>/i,
  },
  {
    id: "credential-mention",
    severity: "medium",
    message: "Mentions secrets or credentials",
    pattern: /\b(api[\s_-]?keys?|secret[\s_-]?keys?|access[\s_-]?tokens?|private[\s_-]?keys?|passwords?|passphrases?|seed phrases?|mnemonics?|bearer tokens?|session cookies?)\b/i,
  },
  {
    id: "cross-tool-steering",
    severity: "medium",
    message: "Tells the model how to use other tools",
    pattern: /\b(instead of|rather than|before|after|whenever|every time)\b[^.]{0,20}\b(you\s+)?(use|using|call|calling|invoke|invoking|run|running)\b[^.]{0,40}\btools?\b|\bwhen (the user|you) (asks?|wants?)[^.]{0,60}\b(also|first|always)\b/i,
  },
  {
    id: "exfiltration",
    severity: "medium",
    message: "Sends data to an external destination",
    pattern: /\b(send|post|upload|forward|transmit|submit|email)\b[^.]{0,40}\b(to|at)\b[^.]{0,10}(https?:\/\/|[\w.-]+@[\w.-]+\.\w+)/i,
  },
  {
    id: "base64-blob",
    severity: "medium",
    message: "Contains a long base64-looking blob",
    pattern: /[A-Za-z0-9+/]{80,}={0,2}/,
  },
  {
    id: "external-url",
    severity: "low",
    message: "Contains a URL",
    pattern: /https?:\/\/[^\s)]+/i,
  },
];

/** Zero-width, bidi-control and Unicode tag characters: invisible to a human reading the description. */
const INVISIBLE = /[\u200B-\u200F\u2060-\u2064\uFEFF\u202A-\u202E\u2066-\u2069]|\u{E0001}|[\u{E0020}-\u{E007F}]/u;

const OVERSIZED_CHARS = 1500;

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 50);
  const end = Math.min(text.length, index + length + 50);
  const slice = text.slice(start, end).replace(/\s+/g, " ");
  return (start > 0 ? "…" : "") + slice + (end < text.length ? "…" : "");
}

export interface ScanContext {
  /** Tool names served by OTHER servers in the same config. Mentioning one is the shadowing signature. */
  foreignToolNames?: Iterable<string>;
}

function scanText(server: string, tool: string, field: string, text: string, ctx: ScanContext): Finding[] {
  const findings: Finding[] = [];
  if (!text) return findings;
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    findings.push({
      server,
      tool,
      field,
      rule: rule.id,
      severity: rule.severity,
      message: rule.message,
      excerpt: excerptAround(text, match.index, match[0].length),
    });
  }
  const invisible = INVISIBLE.exec(text);
  if (invisible) {
    const codepoint = invisible[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
    findings.push({
      server,
      tool,
      field,
      rule: "invisible-unicode",
      severity: "high",
      message: `Contains invisible character U+${codepoint}`,
      excerpt: excerptAround(text, invisible.index, invisible[0].length).replace(INVISIBLE, "�"),
    });
  }
  for (const foreign of ctx.foreignToolNames ?? []) {
    if (foreign.length < 4) continue;
    const re = new RegExp(`(^|[^\\w])${foreign.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w]|$)`);
    const m = re.exec(text);
    if (m) {
      findings.push({
        server,
        tool,
        field,
        rule: "tool-shadowing",
        severity: "high",
        message: `Mentions "${foreign}", a tool served by a different server`,
        excerpt: excerptAround(text, m.index, m[0].length),
      });
      break;
    }
  }
  if (field === "description" && text.length > OVERSIZED_CHARS) {
    findings.push({
      server,
      tool,
      field,
      rule: "oversized",
      severity: "low",
      message: `Description is ${text.length} characters`,
      excerpt: excerptAround(text, 0, 0),
    });
  }
  return findings;
}

/** Walk a JSON schema and yield every human-readable string an LLM will read. */
function* schemaStrings(node: unknown, path: string): Generator<[string, string]> {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) yield* schemaStrings(node[i], `${path}[${i}]`);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    if (typeof value === "string" && (key === "description" || key === "title" || key === "default" || key === "examples")) {
      yield [here, value];
    } else if (Array.isArray(value) && (key === "enum" || key === "examples")) {
      for (const [i, item] of value.entries()) if (typeof item === "string") yield [`${here}[${i}]`, item];
    } else if (typeof value === "object") {
      yield* schemaStrings(value, here);
    }
  }
}

export function scanTool(server: string, name: string, tool: Pick<LockedTool, "description" | "inputSchema">, ctx: ScanContext = {}): Finding[] {
  const findings = scanText(server, name, "description", tool.description, ctx);
  for (const [path, text] of schemaStrings(tool.inputSchema, "inputSchema")) {
    findings.push(...scanText(server, name, path, text, ctx));
  }
  return findings;
}

/** Scan every tool on every server; each server's tools are checked against the union of the others' names. */
export function scanServers(servers: Record<string, { tools: Record<string, Pick<LockedTool, "description" | "inputSchema">> }>): Finding[] {
  const findings: Finding[] = [];
  const names = Object.keys(servers);
  for (const server of names) {
    const foreign = new Set<string>();
    for (const other of names) {
      if (other === server) continue;
      for (const t of Object.keys(servers[other].tools)) foreign.add(t);
    }
    for (const t of Object.keys(servers[server].tools)) foreign.delete(t);
    for (const [name, tool] of Object.entries(servers[server].tools)) {
      findings.push(...scanTool(server, name, tool, { foreignToolNames: foreign }));
    }
  }
  return findings.sort((a, b) => rank(b.severity) - rank(a.severity));
}

export function rank(s: Severity): number {
  return s === "high" ? 3 : s === "medium" ? 2 : 1;
}
