import { describe, expect, test } from "bun:test";
import { canonicalize, serverDigest, toolHash } from "../src/hash.ts";

describe("canonicalize", () => {
  test("is key-order independent", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalize({ a: { c: 3, d: 2 }, b: 1 }));
  });
  test("keeps array order", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });
  test("drops undefined", () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe("toolHash", () => {
  const base = { name: "t", description: "d", inputSchema: { type: "object", properties: { x: { type: "string" } } } };
  test("is stable", () => {
    expect(toolHash(base)).toBe(toolHash({ ...base }));
    expect(toolHash(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  test("changes when the description changes", () => {
    expect(toolHash({ ...base, description: "d2" })).not.toBe(toolHash(base));
  });
  test("changes when a nested schema field changes", () => {
    const schema = { type: "object", properties: { x: { type: "string", description: "hi" } } };
    expect(toolHash({ ...base, inputSchema: schema })).not.toBe(toolHash(base));
  });
});

test("serverDigest ignores tool order", () => {
  expect(serverDigest(["a", "b"])).toBe(serverDigest(["b", "a"]));
  expect(serverDigest(["a"])).not.toBe(serverDigest(["a", "b"]));
});
