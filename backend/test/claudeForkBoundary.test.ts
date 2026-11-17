/**
 * A forked chat's CLI is told when its fork happened (ClaudeForkBoundary),
 * at the fork and at every later resume: background work the copied history
 * launched runs in the parent, and the child's CLI must not report it as
 * "didn't finish before the previous session ended".
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClaudeForkBoundary, RuntimeHost } from 'michi-runtime';
import { claudeTestOptions } from './helpers/claudeTestOptions';
import { michiTestHost } from './helpers/michiTestHost';
import { newScriptedSession, restoreClaudeSpawn, scriptedChildren, stubClaudeSpawn } from './helpers/claudeScriptedChild';

beforeEach(() => stubClaudeSpawn());
afterEach(() => restoreClaudeSpawn());

function hostRecordingBoundaries(saved: ClaudeForkBoundary[]): RuntimeHost {
  const base = michiTestHost();
  return {
    ...base,
    bindings: {
      ...base.bindings,
      forkAnchors: {
        ...base.bindings.forkAnchors,
        saveClaudeForkBoundary: (input) => { saved.push(input); },
        readClaudeForkBoundary: (nodeId, nativeSessionId) =>
          saved.find((b) => b.nodeId === nodeId && b.nativeSessionId === nativeSessionId)?.boundaryAt ?? null,
      },
    },
  };
}

test('a fork saves its boundary for the child session and every spawn of that session passes it', async () => {
  const saved: ClaudeForkBoundary[] = [];
  const { session, child: plain } = await newScriptedSession({ options: claudeTestOptions({ host: hostRecordingBoundaries(saved) }) });
  try {
    assert.equal((plain as any).spawnArgs.env.CLAUDE_CODE_RESUME_SOURCE_ALIVE, undefined, 'not a fork');

    await session.spawnFresh('native-parent');
    const fork = (scriptedChildren.at(-1) as any).spawnArgs;
    assert.equal(fork.forkSession, true);
    assert.deepEqual(saved, [{ nodeId: 'node-steer', nativeSessionId: fork.sessionId, boundaryAt: fork.env.CLAUDE_CODE_RESUME_SOURCE_ALIVE }]);
    assert.ok(!Number.isNaN(Date.parse(saved[0].boundaryAt)));

    await session.spawnResume(fork.sessionId);
    assert.equal((scriptedChildren.at(-1) as any).spawnArgs.env.CLAUDE_CODE_RESUME_SOURCE_ALIVE, saved[0].boundaryAt);

    await session.spawnResume('native-other');
    assert.equal((scriptedChildren.at(-1) as any).spawnArgs.env.CLAUDE_CODE_RESUME_SOURCE_ALIVE, undefined, 'no boundary saved for it');
  } finally { await session.dispose(); }
});
