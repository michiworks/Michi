/**
 * Michi Memory is the one memory store: the sessions Michi spawns keep none
 * of the runtime's own (RuntimeConfigPort.features.nativeMemory is false in
 * Michi's host). Claude Code starts with CLAUDE_CODE_DISABLE_AUTO_MEMORY=1,
 * which outranks the user's settings files: its auto memory is neither read
 * into the session nor written from it, and CLAUDE.md and rules still load.
 * Codex's side is in runtime/test/codexCapabilities.test.ts and the Codex
 * adapter golden; what the runtimes kept before is imported
 * (memoryNativeImport.test.ts).
 */
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeTestOptions } from './helpers/claudeTestOptions';
import { michiTestHost } from './helpers/michiTestHost';
import { newScriptedSession, restoreClaudeSpawn, stubClaudeSpawn } from './helpers/claudeScriptedChild';

describe('Claude Code auto memory in the sessions Michi spawns', () => {
  beforeEach(() => stubClaudeSpawn());
  afterEach(() => restoreClaudeSpawn());

  test('is off in every spawn', async () => {
    const { session, child } = await newScriptedSession();
    try {
      assert.deepEqual((child as any).spawnArgs.env, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
    } finally { await session.dispose(); }
  });

  test('stays as the user configured it for a host that keeps the runtime\'s own memory', async () => {
    const base = michiTestHost();
    const host = { ...base, config: { ...base.config, features: { ...base.config.features, nativeMemory: () => true } } };
    const { session, child } = await newScriptedSession({ options: claudeTestOptions({ host }) });
    try {
      assert.equal((child as any).spawnArgs.env, undefined);
    } finally { await session.dispose(); }
  });
});
