import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const cli = join(root, "src", "cli.ts");
const fixture = join(root, "test", "fixtures", "server.ts");
let dir: string;

function config(variant: string): string {
  const path = join(dir, `${variant}.json`);
  writeFileSync(
    path,
    JSON.stringify({ mcpServers: { fixture: { command: "bun", args: ["run", fixture], env: { MCPLOCK_FIXTURE: variant } } } }),
  );
  return path;
}

async function run(...args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", cli, ...args, "--lock", join(dir, "mcp.lock.json")], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, out: out + err };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcplock-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("cli end to end", () => {
  test("init writes a lockfile with both tools", async () => {
    const r = await run("init", "--config", config("clean"));
    expect(r.code).toBe(0);
    const lock = JSON.parse(readFileSync(join(dir, "mcp.lock.json"), "utf8"));
    expect(Object.keys(lock.servers.fixture.tools).sort()).toEqual(["read_notes", "search_notes"]);
    expect(lock.servers.fixture.serverInfo.name).toBe("mcplock-fixture");
  }, 30_000);

  test("check against the same server is clean", async () => {
    const r = await run("check", "--config", config("clean"));
    expect(r.code).toBe(0);
    expect(r.out).toContain("no drift");
  }, 30_000);

  test("check against a drifted server exits 1 and names the change", async () => {
    const r = await run("check", "--config", config("drift"));
    expect(r.code).toBe(1);
    expect(r.out).toContain("description-changed  search_notes");
    expect(r.out).toContain("tool-added  delete_notes");
  }, 30_000);

  test("check --json emits structured changes", async () => {
    const r = await run("check", "--config", config("drift"), "--json");
    const parsed = JSON.parse(r.out);
    expect(parsed.changes.map((c: { kind: string }) => c.kind).sort()).toEqual(["description-changed", "tool-added"]);
  }, 30_000);

  test("check against a poisoned server exits 2 with high findings", async () => {
    const r = await run("check", "--config", config("poison"));
    expect(r.code).toBe(2);
    expect(r.out).toContain("HIGH");
    expect(r.out).toMatch(/secret-path|concealment|hidden-tag|invisible-unicode/);
  }, 30_000);

  test("check --update rewrites the lockfile", async () => {
    const r = await run("check", "--config", config("drift"), "--update");
    expect(r.code).toBe(1);
    const lock = JSON.parse(readFileSync(join(dir, "mcp.lock.json"), "utf8"));
    expect(Object.keys(lock.servers.fixture.tools)).toContain("delete_notes");
    const again = await run("check", "--config", config("drift"));
    expect(again.code).toBe(0);
  }, 45_000);

  test("scan reads the lockfile offline", async () => {
    const r = await run("scan");
    expect(r.code).toBe(0);
    expect(r.out).toContain("no suspicious");
  });

  test("configs lists the server", async () => {
    const r = await run("configs", "--config", config("clean"));
    expect(r.code).toBe(0);
    expect(r.out).toContain("fixture");
    expect(existsSync(join(dir, "clean.json"))).toBe(true);
  });

  test("unreachable server exits 3", async () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { broken: { command: "definitely-not-a-binary-xyz", args: [] } } }));
    const r = await run("init", "--config", path, "--timeout", "5000");
    expect(r.code).toBe(3);
  }, 15_000);
});
