import type { Change } from "./lockfile.ts";
import type { Finding } from "./poison.ts";

const tty = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const red = paint("31");
export const yellow = paint("33");
export const green = paint("32");
export const dim = paint("2");
export const bold = paint("1");

function short(value: unknown, max = 160): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s === undefined) return "∅";
  const flat = s.replace(/\s+/g, " ");
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

export function formatChanges(changes: Change[]): string {
  if (changes.length === 0) return green("✓ no drift");
  const lines: string[] = [];
  let current = "";
  for (const c of changes) {
    if (c.server !== current) {
      current = c.server;
      lines.push(bold(`${c.server}`));
    }
    const label = c.tool ? `${c.kind}  ${c.tool}` : c.kind;
    const colour = c.kind.endsWith("added") ? yellow : c.kind.endsWith("removed") ? red : red;
    lines.push(`  ${colour("!")} ${label}`);
    if (c.before !== undefined) lines.push(dim(`      - ${short(c.before)}`));
    if (c.after !== undefined) lines.push(dim(`      + ${short(c.after)}`));
  }
  return lines.join("\n");
}

export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return green("✓ no suspicious tool text");
  const colour = { high: red, medium: yellow, low: dim };
  const lines: string[] = [];
  for (const f of findings) {
    lines.push(`${colour[f.severity](f.severity.toUpperCase().padEnd(6))} ${bold(`${f.server}/${f.tool}`)} ${dim(f.field)}  ${f.rule}: ${f.message}`);
    lines.push(dim(`       ${f.excerpt}`));
  }
  return lines.join("\n");
}
