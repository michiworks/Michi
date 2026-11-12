import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { candidateNames, exeName, findOnPath, isRunnableFile, resolveNamedBinary, standardInstallDirs } from "../src/core/executableLookup";

describe("executableLookup", () => {
  test("isRunnableFile takes an executable file only, never a folder", (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "michi-runnable-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "tool");
    fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
    fs.mkdirSync(path.join(dir, "folder"));
    assert.equal(isRunnableFile(file, "linux"), true);
    assert.equal(isRunnableFile(path.join(dir, "folder"), "linux"), false);
    assert.equal(isRunnableFile(path.join(dir, "folder"), "win32"), false);
    assert.equal(isRunnableFile(path.join(dir, "missing"), "linux"), false);
  });

  test("candidateNames adds Windows suffixes and leaves POSIX names alone", () => {
    assert.deepEqual(candidateNames("claude", "win32"), ["claude.exe", "claude.cmd", "claude.bat", "claude"]);
    assert.deepEqual(candidateNames("claude.exe", "win32"), ["claude.exe"]);
    assert.deepEqual(candidateNames("claude", "darwin"), ["claude"]);
  });

  test("exeName appends .exe only on Windows when no suffix is present", () => {
    assert.equal(exeName("kiro-cli", "win32"), "kiro-cli.exe");
    assert.equal(exeName("kiro-cli.exe", "win32"), "kiro-cli.exe");
    assert.equal(exeName("kiro-cli", "linux"), "kiro-cli");
  });

  test("findOnPath walks a Windows PATH", () => {
    const env = { PATH: "C:\\empty;C:\\Tools" };
    const hit = path.join("C:\\Tools", "claude.exe");
    const found = findOnPath("claude", {
      platform: "win32",
      env,
      fs: {
        exists: (filePath) => filePath === hit,
        isRunnable: (filePath) => filePath === hit,
      },
    });
    assert.equal(found, hit);
  });

  test("resolveNamedBinary finds Toolbox + npm locations on Windows", () => {
    const home = "C:\\Users\\nan";
    const env = {
      PATH: "",
      LOCALAPPDATA: "C:\\Users\\nan\\AppData\\Local",
      APPDATA: "C:\\Users\\nan\\AppData\\Roaming",
    };
    const toolbox = path.join(env.LOCALAPPDATA, "Toolbox", "bin", "codex.exe");
    const result = resolveNamedBinary("codex", {
      platform: "win32",
      home,
      env,
      fs: {
        exists: (filePath) => filePath === toolbox,
        isRunnable: (filePath) => filePath === toolbox,
      },
    });
    assert.equal(result.found, toolbox);
    assert.ok(standardInstallDirs({ platform: "win32", home, env }).some((dir) => dir.includes("Toolbox")));
  });

  test("isRunnableFile accepts only regular files, following symlinks", { skip: process.platform === "win32" }, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "michi-runnable-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const folder = path.join(dir, "agy");
    const executable = path.join(dir, "tool");
    const plain = path.join(dir, "notes");
    const link = path.join(dir, "link");
    fs.mkdirSync(folder, { mode: 0o755 });
    fs.writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(plain, "", { mode: 0o644 });
    fs.symlinkSync(executable, link);

    assert.equal(isRunnableFile(folder), false);
    assert.equal(isRunnableFile(executable), true);
    assert.equal(isRunnableFile(plain), false);
    assert.equal(isRunnableFile(link), true);
    assert.equal(isRunnableFile(path.join(dir, "missing")), false);
    assert.equal(isRunnableFile(plain, "win32"), true);
    assert.equal(isRunnableFile(folder, "win32"), false);
  });

  test("resolveNamedBinary skips a candidate that cannot run and records why", () => {
    const files = new Set(["/stale/claude", "/agentspaces/cecelia/bin/claude"]);
    const result = resolveNamedBinary("claude", {
      platform: "linux",
      home: "/home/u",
      env: { PATH: "/stale" },
      fs: { exists: (filePath) => files.has(filePath), isRunnable: (filePath) => files.has(filePath) },
      unusableReason: (filePath) => (filePath === "/stale/claude" ? "exit 1: not associated with any tool" : null),
    });
    assert.equal(result.found, "/agentspaces/cecelia/bin/claude");
    assert.ok(result.tried.includes("/stale/claude (exit 1: not associated with any tool)"));
  });
});
