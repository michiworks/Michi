import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { executeBash, resolveBashShell } from "../src/agents/tools/bash";

describe("resolveBashShell", () => {
  test("Windows prefers a PATH bash when present", () => {
    assert.deepEqual(resolveBashShell("win32", (name) => (name === "bash" ? "C:\\Git\\bin\\bash.exe" : null)), {
      command: "C:\\Git\\bin\\bash.exe",
      prefix: ["-c"],
    });
  });

  test("Windows falls back to cmd.exe", () => {
    const previous = process.env.ComSpec;
    process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
    try {
      assert.deepEqual(resolveBashShell("win32", () => null), {
        command: "C:\\Windows\\System32\\cmd.exe",
        prefix: ["/d", "/s", "/c"],
      });
    } finally {
      if (previous === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = previous;
    }
  });
});

test("bash output keeps a character that two reads split", { skip: process.platform === "win32" }, async () => {
  // The first two bytes of 中, a pause so they arrive as a read of their own, then the last byte.
  const result = await executeBash({ command: "printf '\\344\\270'; sleep 0.3; printf '\\255\\n'" }, "/tmp");
  const output = result.content[0];
  assert.equal(output.type, "text");
  assert.match(output.type === "text" ? output.text : "", /\n\n中/);
});
