import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveNode, saveWorkspace } from '../src/services/dbRepository';
import {
  buildCompatibleResumeContext,
  chooseResumeStrategy,
  COMPAT_TRANSCRIPT_BUDGET,
  type ResumeSignature,
  type TranscriptMessage,
} from '../src/services/resumeStrategy';

const target: ResumeSignature = {
  runtimeId: 'kiro',
  providerId: null,
  modelId: 'sonnet',
  reasoning: null,
};

describe('resume strategy', () => {
  test('attempts native restore when a legacy binding has no signature', () => {
    const decision = chooseResumeStrategy({
      existingChatId: 'sid-1',
      liveSessionMatches: false,
      nativeResumeAvailable: true,
      existingSignature: null,
      targetSignature: target,
    });
    assert.equal(decision.strategy, 'exact');
    assert.equal(decision.reason, 'native_resume_available');
  });
});

describe('compatible resume context of a long transcript', () => {
  let dir: string;
  const oldDataDir = process.env.MICHI_DATA_DIR;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-resume-context-'));
    process.env.MICHI_DATA_DIR = dir;
    closeDb();
    initDb();
    saveWorkspace({ id: 'ws', name: 'Workspace', created_at: 1, updated_at: 1 });
    saveNode({ id: 'n1', workspace_id: 'ws', parent_node_id: null, kind: 'chat', title: 'Long', status: 'idle',
      minimized: 0, spawned_by_agent: 0, created_at: 1 });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
    if (oldDataDir === undefined) delete process.env.MICHI_DATA_DIR;
    else process.env.MICHI_DATA_DIR = oldDataDir;
  });

  function setOverviews(entries: Array<{ at: number; text: string }>): void {
    getDb().prepare('UPDATE nodes SET branch_overview = ? WHERE id = ?').run(JSON.stringify(entries), 'n1');
  }

  /**
   * Ten turns whose rendered messages are 993 characters, so message k
   * starts at 1000k: with a 7000 budget the start keeps messages 0-1 (turn
   * 0), the end messages 16-19 (turns 8-9), and turns 1-7 are cut. Message k
   * is stored at 100k; turn t's overview is recorded at 100(2t+1)+50.
   */
  function tenTurns(): TranscriptMessage[] {
    return Array.from({ length: 20 }, (_, k): TranscriptMessage => {
      const user = k % 2 === 0;
      const tag = `${user ? 'Q' : 'A'}${Math.floor(k / 2)} `;
      return { role: user ? 'user' : 'assistant', content: tag.padEnd(user ? 987 : 982, '.'), createdAt: 100 * k };
    });
  }

  test('keeps far more than the former 8k + 16k of a long conversation', () => {
    const messages = Array.from({ length: 100 }, (_, k): TranscriptMessage => ({
      role: k % 2 === 0 ? 'user' : 'assistant', content: `${k % 2 === 0 ? 'Q' : 'A'}${Math.floor(k / 2)} `.padEnd(1500, '.'),
    }));
    const context = buildCompatibleResumeContext(messages, { nodeId: 'n1' })!;
    // Q8 starts about 24k in and Q35 about 45k from the end: the former cut dropped both.
    for (const kept of ['Q0 ', 'Q8 ', 'Q35 ', 'A49 ']) assert.ok(context.includes(kept), kept);
    assert.equal(context.includes('Q20 '), false, 'the middle is still cut');
    assert.ok(context.length <= COMPAT_TRANSCRIPT_BUDGET + 1_000, `${context.length}`);
    assert.match(context, /\[\.\.\. omitted \d+ chars from the middle of the prior transcript \.\.\.\]/);
  });

  test('puts the summaries of the cut turns in their place, and says where read_node finds the messages', () => {
    setOverviews([
      { at: 0, text: 'Legacy snapshot' },
      ...Array.from({ length: 10 }, (_, t) => ({ at: 100 * (2 * t + 1) + 50, text: `Turn ${t} decided D${t}` })),
    ]);
    const context = buildCompatibleResumeContext(tenTurns(), { nodeId: 'n1' }, { budget: 7_000 })!;
    const lines = context.split('\n');
    const heading = lines.findIndex((line) => line.startsWith('Summaries the agent wrote'));
    assert.ok(heading > 0, context);
    assert.match(lines[heading], /not checked against the messages/);
    assert.deepEqual(lines.slice(heading + 1, heading + 8), [1, 2, 3, 4, 5, 6, 7].map((t) => `- Turn ${t} decided D${t}`));
    for (const absent of ['Legacy snapshot', 'D0', 'D8', 'D9']) assert.equal(context.includes(absent), false, absent);
    assert.match(lines[heading + 8], /^To read the omitted messages, call read_node with nodeId "n1", from "head", offset 3;/);
    assert.ok(context.indexOf('Q0 ') < context.indexOf('Summaries') && context.indexOf('Summaries') < context.indexOf('Q8 '));
  });

  test('keeps the newest summaries when they do not fit, and says how many were left out', () => {
    setOverviews(Array.from({ length: 10 }, (_, t) => ({ at: 100 * (2 * t + 1) + 50, text: `S${t} `.padEnd(300, '.') })));
    const context = buildCompatibleResumeContext(tenTurns(), { nodeId: 'n1' }, { budget: 7_000 })!;
    assert.match(context, /\(4 earlier summaries left out for length\)/);
    for (const t of [5, 6, 7]) assert.ok(context.includes(`- S${t} `), `S${t}`);
    for (const t of [1, 4]) assert.equal(context.includes(`S${t} `), false, `S${t}`);
  });

  test('without message times it still points at read_node, with no summaries', () => {
    setOverviews([{ at: 350, text: 'Turn 1 decided D1' }]);
    const untimed = tenTurns().map(({ role, content }) => ({ role, content }));
    const context = buildCompatibleResumeContext(untimed, { nodeId: 'n1' }, { budget: 7_000 })!;
    assert.equal(context.includes('D1'), false);
    assert.match(context, /call read_node with nodeId "n1", from "head", offset 3/);
  });

  test('a smaller budget keeps less', () => {
    const messages = tenTurns();
    const small = buildCompatibleResumeContext(messages, { nodeId: 'n1' }, { budget: 7_000 })!;
    const whole = buildCompatibleResumeContext(messages, { nodeId: 'n1' })!;
    assert.ok(small.length < 8_000, `${small.length}`);
    assert.ok(whole.includes('Q5 ') && !whole.includes('omitted'), 'under the default budget nothing is cut');
  });
});
