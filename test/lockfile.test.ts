import { describe, expect, test } from "bun:test";
import type { ServerSpec } from "../src/config.ts";
import { buildLockedServer, diffServer } from "../src/lockfile.ts";

const spec: ServerSpec = { name: "s", source: "/cfg", transport: "stdio", command: "bun", args: ["x"] };
const t1 = { name: "a", description: "A", inputSchema: { type: "object" } };
const t2 = { name: "b", description: "B", inputSchema: { type: "object" } };

describe("diffServer", () => {
  test("identical surface has no changes", () => {
    const l = buildLockedServer(spec, [t1, t2]);
    const c = buildLockedServer(spec, [t2, t1]);
    expect(l.digest).toBe(c.digest);
    expect(diffServer("s", l, c)).toEqual([]);
  });
  test("description change", () => {
    const l = buildLockedServer(spec, [t1]);
    const c = buildLockedServer(spec, [{ ...t1, description: "A changed" }]);
    const d = diffServer("s", l, c);
    expect(d.map((x) => x.kind)).toEqual(["description-changed"]);
    expect(d[0].before).toBe("A");
    expect(d[0].after).toBe("A changed");
  });
  test("schema change only", () => {
    const l = buildLockedServer(spec, [t1]);
    const c = buildLockedServer(spec, [{ ...t1, inputSchema: { type: "object", properties: { x: {} } } }]);
    expect(diffServer("s", l, c).map((x) => x.kind)).toEqual(["input-schema-changed"]);
  });
  test("tool added and removed", () => {
    const l = buildLockedServer(spec, [t1]);
    const c = buildLockedServer(spec, [t2]);
    expect(diffServer("s", l, c).map((x) => `${x.kind}:${x.tool}`)).toEqual(["tool-removed:a", "tool-added:b"]);
  });
  test("launch command change is reported even with identical tools", () => {
    const l = buildLockedServer(spec, [t1]);
    const c = buildLockedServer({ ...spec, args: ["y"] }, [t1]);
    expect(diffServer("s", l, c).map((x) => x.kind)).toEqual(["launch-changed"]);
  });
  test("server added / removed", () => {
    const l = buildLockedServer(spec, [t1]);
    expect(diffServer("s", undefined, l)[0].kind).toBe("server-added");
    expect(diffServer("s", l, undefined)[0].kind).toBe("server-removed");
  });
});
