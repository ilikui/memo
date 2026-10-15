import test from "node:test";
import assert from "node:assert/strict";
import { buildLineDiff } from "../web/conflict-diff.js";

test("identical content is represented as unchanged lines", () => {
  const result = buildLineDiff("alpha\nbeta", "alpha\nbeta");
  assert.equal(result.fallback, false);
  assert.deepEqual(result.lines.map(line => [line.kind, line.text, line.lineNumber]), [
    ["same", "alpha", 1],
    ["same", "beta", 2],
  ]);
});

test("reports local removals and server additions", () => {
  const result = buildLineDiff("alpha\nlocal\nomega", "alpha\nserver\nomega");
  assert.deepEqual(result.lines.map(line => [line.kind, line.marker, line.text]), [
    ["same", " ", "alpha"],
    ["removed", "−", "local"],
    ["added", "+", "server"],
    ["same", " ", "omega"],
  ]);
});

test("handles inserted and deleted lines at document boundaries", () => {
  const result = buildLineDiff("middle\nlast", "first\nmiddle");
  assert.deepEqual(result.lines.map(line => [line.kind, line.text]), [
    ["added", "first"],
    ["same", "middle"],
    ["removed", "last"],
  ]);
});

test("preserves empty documents and trailing empty lines", () => {
  assert.deepEqual(buildLineDiff("", "").lines.map(line => line.text), [""]);
  assert.deepEqual(buildLineDiff("a\n", "a").lines.map(line => [line.kind, line.text]), [
    ["same", "a"],
    ["removed", ""],
  ]);
});

test("falls back before allocating a large LCS matrix", () => {
  const result = buildLineDiff("a\nb\nc", "x\ny\nz", 4);
  assert.equal(result.fallback, true);
  assert.deepEqual(result.localLines, ["a", "b", "c"]);
  assert.deepEqual(result.serverLines, ["x", "y", "z"]);
  assert.deepEqual(result.lines, []);
});

test("uses text data as plain values without interpreting markup", () => {
  const result = buildLineDiff("<script>alert(1)</script>", "safe");
  assert.equal(result.lines[0].text, "<script>alert(1)</script>");
});
