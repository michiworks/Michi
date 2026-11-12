import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  applyTurnEvent,
  createDurableTurn,
  extractBranchOverview,
  extractTurnMetadata,
  finalizeTurnContent,
  hasClosedFollowUpSentinels,
  selfTurnAssistantId,
  stripTurnMetadataSentinels,
  turnLeftAnswer,
  userMessageIdFor,
  userTurnAssistantId,
  type ChatStreamEvent,
} from '../src/index';

test('turn message ids keep the formats stored in data.db', () => {
  assert.equal(userTurnAssistantId('node-1', 'turn-1'), 'a-node-1-turn-1');
  assert.equal(selfTurnAssistantId('node-1', 'turn-1'), 'self-node-1-turn-1');
  assert.equal(userMessageIdFor('a-node-1-turn-1'), 'u-a-node-1-turn-1');
  assert.equal(createDurableTurn({
    turnId: 'turn-1', nodeId: 'node-1', workspaceId: 'ws', assistantId: 'self-node-1-turn-1',
    displayUserText: 'hi', startedAt: 1, keepUserMessage: true, selfInitiated: true,
  }).userMessage?.id, 'u-self-node-1-turn-1');
});

function event(
  name: ChatStreamEvent['event'],
  data: Record<string, unknown>,
): ChatStreamEvent {
  return { event: name, data } as ChatStreamEvent;
}

describe('durable turn projector', () => {
  test('creates a tool block when an update arrives before the initial call', () => {
    const initial = createDurableTurn({
      turnId: 'turn-3',
      assistantId: 'a-3',
      nodeId: 'node-3',
      workspaceId: 'ws-1',
      displayUserText: '',
      selfInitiated: true,
      startedAt: 100,
    });
    const updated = applyTurnEvent(initial, event('tool_call_update', {
      toolCallId: 'tool-late',
      title: 'Bash',
      status: 'failed',
      output: 'nope',
      seq: 1,
    }));

    assert.equal(updated.userMessage, null);
    assert.equal(updated.assistantMessage.toolCalls.length, 1);
    assert.equal(updated.assistantMessage.blocks[0]?.kind, 'tool');
  });

  test('replaces input snapshots once and preserves them across output updates and replay', () => {
    let snapshot = createDurableTurn({
      turnId: 'input-turn', assistantId: 'input-assistant', nodeId: 'input-node',
      workspaceId: 'ws-1', displayUserText: 'write it', startedAt: 100,
    });
    snapshot = applyTurnEvent(snapshot, event('tool_call', {
      toolCallId: 'write-1', title: 'Write', status: 'in_progress', inputJson: '{}', seq: 1,
    }));
    const inputJson = JSON.stringify({ file_path: '/tmp/app.ts', content: 'finished input' });
    const backfill = event('tool_call_update', {
      toolCallId: 'write-1', title: 'Write', status: 'in_progress', inputJson, seq: 2,
    });
    snapshot = applyTurnEvent(snapshot, backfill);
    assert.equal(snapshot.assistantMessage.toolCalls[0].inputJson, inputJson, 'snapshots replace instead of append');
    snapshot = applyTurnEvent(snapshot, event('tool_call_update', {
      toolCallId: 'write-1', title: '', status: 'completed', output: 'saved', seq: 3,
    }));
    const afterOutput = snapshot;
    snapshot = applyTurnEvent(snapshot, backfill);
    assert.equal(snapshot, afterOutput, 'replayed backfill must not regress completed state');
    assert.equal(snapshot.assistantMessage.toolCalls[0].inputJson, inputJson);
    assert.equal(snapshot.assistantMessage.toolCalls[0].output, 'saved');
    assert.equal(snapshot.assistantMessage.toolCalls[0].status, 'completed');
    assert.equal(snapshot.assistantMessage.blocks.filter((block) => block.kind === 'tool').length, 1);
  });
});


test('replay is deterministic across clocks; unstamped legacy tools have no invented duration', () => {
  const initial = createDurableTurn({ turnId: 'times', assistantId: 'a-times', nodeId: 'node-times', workspaceId: 'ws', displayUserText: '', startedAt: 1 });
  const frames = [event('tool_call', { toolCallId: 't', title: 'Read', status: 'running', observedAt: 100, seq: 1 }),
    event('tool_call_update', { toolCallId: 't', title: '', status: 'completed', observedAt: 800, seq: 2 }),
    event('done', { stopReason: 'end_turn', completedAt: 900, observedAt: 905, seq: 3 })];
  const first = frames.reduce(applyTurnEvent, initial);
  const realNow = Date.now;
  try {
    Date.now = () => 9_000_000;
    assert.deepEqual(frames.reduce(applyTurnEvent, initial), first);
  } finally { Date.now = realNow; }
  assert.equal(first.assistantMessage.toolCalls[0].endedAt! - first.assistantMessage.toolCalls[0].startedAt!, 700);
  const legacy = [event('tool_call', { toolCallId: 'old', title: 'Read', status: 'running' }), event('done', { stopReason: 'end_turn' })].reduce(applyTurnEvent, initial);
  assert.equal(legacy.assistantMessage.toolCalls[0].startedAt, undefined);
  assert.equal(legacy.assistantMessage.toolCalls[0].endedAt, undefined);
});

test('text blocks carry backend-observed start/end times that replay deterministically', () => {
  const initial = createDurableTurn({ turnId: 'text-times', assistantId: 'a-text', nodeId: 'n', workspaceId: 'ws', displayUserText: '', startedAt: 1 });
  const frames = [
    event('thought', { text: 'plan ', observedAt: 100, seq: 1 }),
    event('thought', { text: 'more', observedAt: 150, seq: 2 }),
    event('tool_call', { toolCallId: 't', title: 'Bash', status: 'running', observedAt: 200, seq: 3 }),
    event('tool_call_update', { toolCallId: 't', title: '', status: 'completed', observedAt: 300, seq: 4 }),
    event('chunk', { text: 'Answer', observedAt: 400, seq: 5 }),
    event('chunk', { text: ' text', observedAt: 450, seq: 6 }),
    event('done', { stopReason: 'end_turn', completedAt: 900, observedAt: 905, seq: 7 }),
  ];
  const first = frames.reduce(applyTurnEvent, initial);
  const realNow = Date.now;
  try {
    Date.now = () => 9_000_000;
    assert.deepEqual(frames.reduce(applyTurnEvent, initial), first);
  } finally { Date.now = realNow; }
  const [thinking, tool, answer] = first.assistantMessage.blocks;
  // A block starts on its first frame (later fragments do not move it) and ends
  // when the next block opens; the trailing block ends with the turn.
  assert.deepEqual(thinking, { id: 'a-text-b-0', kind: 'thinking', rawText: 'plan more', streaming: false, startedAt: 100, endedAt: 200 });
  assert.equal(tool.kind, 'tool');
  assert.deepEqual(answer, { id: 'a-text-b-2', kind: 'answer', rawText: 'Answer text', streaming: false, startedAt: 400, endedAt: 900 });
});

test('unstamped legacy text frames get no invented start/end times', () => {
  const initial = createDurableTurn({ turnId: 'legacy-text', assistantId: 'a-legacy', nodeId: 'n', workspaceId: 'ws', displayUserText: '', startedAt: 1 });
  const snapshot = [
    event('thought', { text: 'old thought' }),
    event('chunk', { text: 'old answer' }),
    event('done', { stopReason: 'end_turn' }),
  ].reduce(applyTurnEvent, initial);
  for (const block of snapshot.assistantMessage.blocks) {
    assert.equal('startedAt' in block, false);
    assert.equal('endedAt' in block, false);
  }
});

test('terminal interruption preserves the unanswered question without persisting an actionable approval', () => {
  let snapshot = createDurableTurn({ turnId: 'question', assistantId: 'a-question', nodeId: 'n', workspaceId: 'ws', displayUserText: '', startedAt: 1 });
  snapshot = applyTurnEvent(snapshot, event('user_input_request', { requestId: 1, questions: [{ question: 'Continue?', options: [], multiSelect: false }], seq: 1 }));
  snapshot = applyTurnEvent(snapshot, event('done', { stopReason: 'cancel', completedAt: 20, seq: 2 }));
  const block = snapshot.assistantMessage.blocks[0];
  assert.equal(block.kind, 'user-input');
  if (block.kind === 'user-input') {
    assert.equal(block.interaction?.status, 'interrupted');
    assert.equal(block.interaction?.questions[0].id, 'question:input:1:q:0');
  }
});

test('a turn left an answer when its finalized content or a tool, image or question remains', () => {
  const cases: Array<[string, Array<{ kind: string }>, boolean]> = [
    ['', [], false],
    ['All done.', [], true],
    ['[TITLE: Notes]\n[FOLLOW-UP 1/3: Next?]', [], false],
    ['Title: Notes\n', [], false],
    ['[BRANCH-OVERVIEW: planned it]', [], false],
    ['', [{ kind: 'thinking' }, { kind: 'answer' }], false],
    ['', [{ kind: 'tool' }], true],
    ['', [{ kind: 'image' }], true],
    ['', [{ kind: 'user-input' }], true],
  ];
  for (const [raw, blocks, expected] of cases) {
    assert.equal(turnLeftAnswer(finalizeTurnContent(raw), blocks), expected, JSON.stringify([raw, blocks]));
  }
});

test('a sentinel prefix quoted in prose keeps the rest of the answer visible', () => {
  const raw = [
    '[TITLE: Plan]',
    '- P1.5 chatStreamRunner is missing `[BRANCH-OVERVIEW:`',
    '- P1.6 nightly',
    '',
    '[FOLLOW-UP 1/3: a?]',
    '[FOLLOW-UP 2/3: b?]',
    '[FOLLOW-UP 3/3: c?]',
    '[BRANCH-OVERVIEW: planned the cleanup]',
  ].join('\n');
  assert.equal(finalizeTurnContent(raw), '- P1.5 chatStreamRunner is missing `[BRANCH-OVERVIEW:`\n- P1.6 nightly');
  // Inline code is never a sentinel, even when a `]` follows on the same line.
  assert.equal(
    stripTurnMetadataSentinels('quote `[TITLE:` and `]`, or `[FOLLOW-UP 1/3: q?]` here\n[TITLE: real]'),
    'quote `[TITLE:` and `]`, or `[FOLLOW-UP 1/3: q?]` here\n',
  );
});

test('persisted content and metadata read quoted title and overview prefixes as prose, like the visible text', () => {
  const answers = [
    'a\n- x 少了 `[TITLE:`\n- next',
    'a\n- x 少了 [TITLE:\n- see [docs](x) tail',
    'quote `[TITLE:` and `]` here\nbody',
    'use `[TITLE: x]` and `[BRANCH-OVERVIEW: y]` here\nbody',
    'a\nmissing [BRANCH-OVERVIEW:\n- see [docs](x) tail',
  ];
  for (const answer of answers) {
    const raw = `${answer}\n\n[FOLLOW-UP 1/3: q?]\n[FOLLOW-UP 2/3: r?]\n[FOLLOW-UP 3/3: s?]\n[BRANCH-OVERVIEW: o]`;
    assert.equal(finalizeTurnContent(raw), answer);
    assert.deepEqual(extractTurnMetadata(raw), { followUps: ['q?', 'r?', 's?'], branchOverview: 'o' });
  }
  assert.equal(extractTurnMetadata('[TITLE:\tReal ]\nbody').title, 'Real');
});

test('the branch overview is the last unquoted one-line marker with text', () => {
  assert.equal(extractBranchOverview('End with `[BRANCH-OVERVIEW: one line]`.'), null);
  assert.equal(extractBranchOverview('Body.\n[BRANCH-OVERVIEW:\nsummary]'), null);
  assert.equal(extractBranchOverview('Use `[BRANCH-OVERVIEW: example]`.\n[BRANCH-OVERVIEW: real]'), 'real');
  assert.equal(extractBranchOverview('[BRANCH-OVERVIEW: first]\nBody.\n[BRANCH-OVERVIEW: last ]'), 'last');
  assert.equal(extractBranchOverview('[BRANCH-OVERVIEW: kept]\n[BRANCH-OVERVIEW:   ]'), 'kept');
  assert.deepEqual(extractTurnMetadata('[BRANCH-OVERVIEW: first]\n[BRANCH-OVERVIEW: last]'), { branchOverview: 'last' });
});

test('reads prose titles, the last [FOLLOW-UPS:] block and the trailing follow-up group', () => {
  assert.deepEqual(extractTurnMetadata('Title: How birds navigate\n\n#### Overview\nBody text here.'), { title: 'How birds navigate' });
  assert.equal(finalizeTurnContent('Title: How birds navigate\n\n#### Overview\nBody text here.'), '#### Overview\nBody text here.');
  assert.deepEqual(
    extractTurnMetadata('Earlier I wrote [FOLLOW-UPS: old1 | old2 | old3]. Now the real answer.\n\n[FOLLOW-UPS: new1? | new2? | new3?]').followUps,
    ['new1?', 'new2?', 'new3?'],
  );
  const raw = [
    '[TITLE: T]',
    'When the model writes [FOLLOW-UP 1/3: foo] inline, the parser groups',
    'them — see below.',
    '',
    '[FOLLOW-UP 1/3: real q1?]',
    '[FOLLOW-UP 2/3: real q2?]',
    '[FOLLOW-UP 3/3: real q3?]',
  ].join('\n');
  assert.deepEqual(extractTurnMetadata(raw), { title: 'T', followUps: ['real q1?', 'real q2?', 'real q3?'] });
  assert.deepEqual(extractTurnMetadata('just some prose with no sentinels'), {});
});

describe('hasClosedFollowUpSentinels', () => {
  for (const [text, closed] of [
    ['[FOLLOW-UP 3/3: c?]', true],
    ['[FOLLOW-UP 3: c?]', true],
    ['[FOLLOW-UP 3/3: c?\n', true],
    ['[FOLLOW-UP 3/3: c', false],
    ['[FOLLOW-UP 3: c?', false],
    ['[FOLLOW-UP 2/3: b?]', false],
    // Another follow-up on its line ends an unclosed one, which is then dropped.
    ['[FOLLOW-UP 3/3: c? [FOLLOW-UP 1/3: a?]', false],
  ] as const) {
    test(`${JSON.stringify(text)} is ${closed ? '' : 'not '}closed`, () => {
      assert.equal(hasClosedFollowUpSentinels(text), closed);
      if (closed) assert.equal(extractTurnMetadata(`Answer.\n[FOLLOW-UP 1/3: a?]\n[FOLLOW-UP 2/3: b?]\n${text}`).followUps?.[2], 'c?');
    });
  }
});

test('an empty third follow-up does not finish the sentinels, as the renderers drop it', () => {
  for (const text of [
    '[FOLLOW-UP 3/3: ]',
    '[FOLLOW-UP 3/3:]\n',
    'Answer.\n[FOLLOW-UP 1/3: a?]\n[FOLLOW-UP 2/3: b?]\n[FOLLOW-UP 3/3: ]',
    // No line group: the lost-`]` reading.
    'Answer [FOLLOW-UP 1/3: a? [FOLLOW-UP 2/3: b? [FOLLOW-UP 3/3: ]',
  ]) {
    assert.equal(hasClosedFollowUpSentinels(text), false, JSON.stringify(text));
    assert.equal(extractTurnMetadata(text).followUps?.[2], undefined, JSON.stringify(text));
  }
  assert.equal(hasClosedFollowUpSentinels('Answer [FOLLOW-UP 1/3: a? [FOLLOW-UP 2/3: b? [FOLLOW-UP 3/3: c?]'), true);
});

test('a follow-up or overview runs to the last ] of its line, so it may contain brackets', () => {
  // Shapes from real replies: each used to stop at its first `]`.
  const followUps = [
    '为什么不直接复用预热好的进程？',
    'sidecar 和回答里的 [TITLE:] 给出的标题不一致时，用户看到的是哪个？',
    '会不会误杀 app/[slug]/page.tsx 和 [::]:5050？',
  ];
  const branchOverview = "把 `.toggle[aria-pressed='true']` 改成淡色";
  const raw = `[TITLE: t]\nbody\n\n${followUps.map((q, i) => `[FOLLOW-UP ${i + 1}/3: ${q}]`).join('\n')}\n[BRANCH-OVERVIEW: ${branchOverview}]`;
  assert.deepEqual(extractTurnMetadata(raw), { title: 't', followUps, branchOverview });
  assert.equal(finalizeTurnContent(raw), 'body');
  assert.equal(stripTurnMetadataSentinels(raw.slice('[TITLE: t]\n'.length)), 'body\n\n');

  // Streaming never shows part of a follow-up, then hides it again.
  let shown = '';
  for (let end = 1; end <= raw.length; end += 1) {
    const visible = stripTurnMetadataSentinels(raw.slice(0, end));
    assert.ok(visible.startsWith(shown), `visible text shrank at ${end}`);
    shown = visible;
  }
  assert.equal(shown, 'body\n\n');
});

test('follow-up lines: text before the first one, several on a line, examples in code, a lost ]', () => {
  // Kiro sometimes starts the first sentinel on the answer's last line.
  assert.deepEqual(
    extractTurnMetadata('就可以一起删掉。[FOLLOW-UP 1/3: a?]\n[FOLLOW-UP 2/3: b?]\n[FOLLOW-UP 3/3: c?]').followUps,
    ['a?', 'b?', 'c?'],
  );
  assert.equal(finalizeTurnContent('就可以一起删掉。[FOLLOW-UP 1/3: a?]\n[FOLLOW-UP 2/3: b?]'), '就可以一起删掉。');
  const oneLine = 'body\n[FOLLOW-UP 1/3: a [x]?] [FOLLOW-UP 2/3: b?]\n[FOLLOW-UP 3/3: c?]';
  assert.deepEqual(extractTurnMetadata(oneLine).followUps, ['a [x]?', 'b?', 'c?']);
  assert.equal(stripTurnMetadataSentinels(oneLine), 'body\n');
  // A reply that shows the format in a code block keeps its own follow-ups.
  const quoting = 'like this:\n```\n[FOLLOW-UP 1/3: example [TITLE:] ?]\n```\nend\n[FOLLOW-UP 1/3: real?]';
  assert.deepEqual(extractTurnMetadata(quoting).followUps, ['real?']);
  // Text after the last `]` on the line stays visible.
  assert.equal(stripTurnMetadataSentinels('[FOLLOW-UP 1/3: a [x]?] tail\nmore'), 'tail\nmore');
  assert.equal(stripTurnMetadataSentinels('body\n[BRANCH-OVERVIEW: read `a[0]`] tail'), 'body\n');
  assert.equal(stripTurnMetadataSentinels('body\n[BRANCH-OVERVIEW: read `a[0]`] tail\n'), 'body\ntail\n');
  // Without a closing `]` the old reading still applies.
  assert.deepEqual(extractTurnMetadata('body\n[FOLLOW-UP 1/3: a?\n[FOLLOW-UP 2/3: b?]').followUps, ['a?', 'b?']);
});
