/**
 * Michi's wording for the Codex adapter (michiCodexOptions.ts): each member
 * reads hostText/codex.ts at every call, with the arguments the adapter
 * passes, and the factory's options carry it, with the skill library's mount.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { michiCodexHostText } from '../src/agents/michiCodexOptions';
import { codexAdapterOptions } from '../src/agents/runtimeFactories';
import * as codexText from '../src/agents/hostText/codex';
import { notifySkillLibraryChanged } from '../src/services/skills/events';
import { skillMountsRoot } from '../src/services/skills/paths';
import { michiTestHost } from './helpers/michiTestHost';

/** Stubs `target[name]`, calls `invoke`, and checks the stub got exactly `args` and its value came back. */
function expectDelegation(t: TestContext, target: object, name: string, invoke: () => unknown, args: unknown[]): void {
  const result = Symbol(name);
  const stub = t.mock.method(target as Record<string, (...a: any[]) => any>, name, () => result);
  assert.equal(invoke(), result);
  assert.equal(stub.mock.callCount(), 1);
  assert.deepEqual(stub.mock.calls[0].arguments, args);
}

/** Temporarily replaces an exported constant; the module object holds it as a plain property. */
function withExport<T>(target: object, name: string, value: unknown, run: () => T): T {
  const holder = target as Record<string, unknown>;
  const original = holder[name];
  holder[name] = value;
  try { return run(); } finally { holder[name] = original; }
}

test('turnMetadataInstruction → hostText/codex buildCodexTurnMetadataInstruction', (t) => {
  const text = michiCodexHostText();
  expectDelegation(t, codexText, 'buildCodexTurnMetadataInstruction',
    () => text.turnMetadataInstruction!('sentinel', false), ['sentinel', false]);
  t.mock.restoreAll();
  expectDelegation(t, codexText, 'buildCodexTurnMetadataInstruction',
    () => text.turnMetadataInstruction!('sentinel'), ['sentinel']);
});

test('the turn-metadata protocol text matches the direct calls', () => {
  const text = michiCodexHostText();
  for (const enableFollowUps of [true, false]) {
    assert.equal(text.turnMetadataInstruction!('sentinel', enableFollowUps), codexText.buildCodexTurnMetadataInstruction('sentinel', enableFollowUps));
  }
});

test('titleInstructions → hostText/codex TITLE_INSTRUCTIONS, read at each call', () => {
  const text = michiCodexHostText();
  assert.equal(text.titleInstructions!(), codexText.TITLE_INSTRUCTIONS);
  withExport(codexText, 'TITLE_INSTRUCTIONS', 'swapped', () => {
    assert.equal(text.titleInstructions!(), 'swapped');
  });
});

test("the factory's Codex options carry Michi's wording", () => {
  const { hostText } = codexAdapterOptions({ host: michiTestHost() }, {});
  assert.deepEqual(Object.keys(hostText ?? {}).sort(), ['titleInput', 'titleInstructions', 'turnMetadataInstruction']);
  assert.equal(hostText!.titleInstructions!(), codexText.TITLE_INSTRUCTIONS);
  assert.equal(hostText!.turnMetadataInstruction!('sentinel', true), codexText.buildCodexTurnMetadataInstruction('sentinel', true));
});

test("the factory's Codex options give app-server the library's flat Codex mount and its changes; none in cloud mode", () => {
  const { skillRoots, onSkillRootsChanged } = codexAdapterOptions({ host: michiTestHost() }, {});
  const root = path.join(skillMountsRoot(), 'codex');
  assert.deepEqual(skillRoots!(), [root]);
  assert.ok(fs.statSync(root).isDirectory());
  let changes = 0;
  const unsubscribe = onSkillRootsChanged!(() => { changes += 1; });
  notifySkillLibraryChanged();
  unsubscribe();
  notifySkillLibraryChanged();
  assert.equal(changes, 1);
  const cloud = codexAdapterOptions({ host: michiTestHost() }, { MICHI_CLOUD: '1' });
  assert.equal(cloud.skillRoots, undefined);
  assert.equal(cloud.onSkillRootsChanged, undefined);
});

test("app-server starts without the backend's own environment; the binary cache still follows MICHI_DATA_DIR", () => {
  const env = { MICHI_DATA_DIR: '/fixture/data', MICHI_REMOTE_TOKEN: 'fixture-token', NODE_ENV: 'production', OPENAI_API_KEY: 'fixture-key', CODEX_HOME: '/fixture/codex' };
  const options = codexAdapterOptions({ host: michiTestHost() }, env);
  assert.equal(options.binaryCacheFile, path.join('/fixture/data', 'cache', 'codex-binary.json'));
  assert.deepEqual(Object.keys(options.spawnEnv!()).sort(), ['CODEX_HOME', 'OPENAI_API_KEY']);
  assert.equal(env.MICHI_REMOTE_TOKEN, 'fixture-token', "the caller's environment is left alone");
});
