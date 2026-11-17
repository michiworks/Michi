import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  TURN_ENDED_EARLY,
  applyTurnEvent,
  autoContinueLabel,
  buildContinuationPrompt,
  conversationEnding,
  createDurableTurn,
  parseAutoContinueSource,
  parseTurnEndMark,
  turnEndMarkOf,
  turnEndNote,
  type ChatStreamEvent,
  type ContinuationMessage,
} from '../src/index';

describe('turn end marks', () => {
  test('a Stop and the early stops leave a mark; a finished or failed turn none', () => {
    assert.equal(turnEndMarkOf('cancelled'), 'stopped');
    assert.equal(turnEndMarkOf('cancel'), 'stopped');
    assert.equal(turnEndMarkOf('max_tokens'), 'max_tokens');
    assert.equal(turnEndMarkOf('max_turn_requests'), 'max_turn_requests');
    assert.equal(turnEndMarkOf('refusal'), 'refusal');
    for (const reason of ['end_turn', 'error', '', null, undefined]) assert.equal(turnEndMarkOf(reason), undefined);
    assert.equal(parseTurnEndMark('stopped'), 'stopped');
    assert.equal(parseTurnEndMark('end_turn'), undefined);
  });

  test('the line reads "Stopped", or the wording the Spaces Home and Today use', () => {
    assert.equal(turnEndNote('stopped'), 'Stopped');
    assert.equal(turnEndNote('max_turn_requests'), 'Stopped early: it reached its step limit');
    assert.equal(conversationEnding({ status: 'completed', stopReason: 'max_tokens', error: null })?.note, TURN_ENDED_EARLY.max_tokens);
  });

  test('the projection writes the mark on the assistant message at done', () => {
    const turn = createDurableTurn({ turnId: 't', assistantId: 'a', nodeId: 'n', workspaceId: 'w', displayUserText: 'hi', startedAt: 1 });
    const done = (stopReason: string) => applyTurnEvent(turn, { event: 'done', data: { stopReason, seq: 1 } } as ChatStreamEvent);
    assert.equal(done('max_turn_requests').assistantMessage.metadata?.turnEnd, 'max_turn_requests');
    assert.equal(done('cancelled').assistantMessage.metadata?.turnEnd, 'stopped');
    assert.equal(done('end_turn').assistantMessage.metadata?.turnEnd, undefined);
  });

  test('an automatic continuation\'s metadata and label', () => {
    const source = { n: 2, of: 3, reason: 'max_tokens' as const, fromTurnId: 't1' };
    assert.deepEqual(parseAutoContinueSource(source), source);
    assert.equal(parseAutoContinueSource({ ...source, n: 4 }), undefined, 'more than the cap it names');
    assert.equal(parseAutoContinueSource({ ...source, reason: 'auth' }), undefined);
    assert.equal(autoContinueLabel(source), '[auto-continue 2/3 · max_tokens]');
  });
});

describe('buildContinuationPrompt', () => {
  const transcript: ContinuationMessage[] = [
    { role: 'user', text: 'An older request' },
    { role: 'assistant', text: 'Done.' },
    { role: 'user', text: 'Refactor the parser' },
    { role: 'assistant', text: 'Reading files.', toolCalls: [{ id: 't1', title: 'Read parser.ts', status: 'completed', inputJson: '{"path":"parser.ts"}' }] },
    { role: 'user', text: 'Keep the API', steered: true },
  ];

  test('a turn the session may be missing restores its request, partial output and tool calls', () => {
    const prompt = buildContinuationPrompt(transcript, 'stopped', 'continue')!;
    assert.match(prompt, /^\[INTERRUPTED TURN — context restore\]\nThe turn below was stopped before it finished/);
    assert.match(prompt, /Interrupted request:\nRefactor the parser/);
    assert.match(prompt, /Partial response before the interruption:\nReading files\.\n\[Steered mid-turn\] Keep the API/);
    assert.match(prompt, /- Read parser\.ts \[completed\]: \{"path":"parser\.ts"\}/);
    assert.match(prompt, /The user pressed Continue\. Look at the conversation above/);
  });

  test('a turn that ended early is whole in the session: it only asks to carry on', () => {
    const prompt = buildContinuationPrompt(transcript, 'max_turn_requests', 'auto')!;
    assert.doesNotMatch(prompt, /context restore/);
    assert.match(prompt, /^Your previous turn stopped before it finished: it reached its step limit\. Michi continued it automatically\./);
  });

  test('Michi\'s own continuations are never the request', () => {
    const chain: ContinuationMessage[] = [
      ...transcript,
      { role: 'assistant', text: 'More work.' },
      { role: 'user', text: '[auto-continue 1/3 · max_tokens] Continue from where you stopped.', autoContinue: true },
      { role: 'assistant', text: 'Still going.' },
    ];
    const prompt = buildContinuationPrompt(chain, 'connection', 'auto')!;
    assert.match(prompt, /Interrupted request:\nRefactor the parser/);
    assert.doesNotMatch(prompt, /\[auto-continue/);
    assert.match(prompt, /Still going\./);
  });

  test('no request, no prompt', () => {
    assert.equal(buildContinuationPrompt([{ role: 'assistant', text: 'Hello' }], 'restart', 'resume'), null);
  });
});
