import { describe, expect, it } from 'vitest';
import type { AssistantBlock, ToolCallState } from '../../state/chatTypes';
import { splitFinishedTurn } from './workFold';

const bash = (id: string, status: ToolCallState['status'] = 'completed'): ToolCallState => ({
  id, title: 'Bash', kind: 'bash', status, inputJson: JSON.stringify({ command: `echo ${id}`, description: `Run ${id}` }),
});
const answer = (id: string, rawText: string): AssistantBlock => ({ id, kind: 'answer', rawText });
const tool = (id: string, rawOffset: number): AssistantBlock => ({ id: `b-${id}`, kind: 'tool', toolCallId: id, section: 'answer', rawOffset });

const NOTE = 'No overlap. Committing.';
const FINAL = 'Merged into dev.';
// The screenshot turn's shape: one answer run, prose and tools alternating.
const turn: AssistantBlock[] = [
  tool('t1', 0),
  answer('a1', NOTE),
  tool('t2', NOTE.length),
  answer('a2', FINAL),
];

describe('splitFinishedTurn', () => {
  it('folds everything up to the last tool and keeps what follows as the final answer', () => {
    const split = splitFinishedTurn(turn, [bash('t1'), bash('t2')], true);
    expect(split?.work.map((b) => b.id)).toEqual(['b-t1', 'a1', 'b-t2']);
    expect(split?.final.map((b) => b.id)).toEqual(['a2']);
    expect(split?.tools.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(split?.notes).toBe(1);
    expect(split?.lifted).toEqual([]);
  });

  it('leaves a turn without a final answer alone', () => {
    expect(splitFinishedTurn(turn.slice(0, 3), [bash('t1'), bash('t2')], true)).toBeNull();
    // Sentinels alone are not an answer.
    expect(splitFinishedTurn([...turn.slice(0, 3), answer('a2', '\n\n[TITLE: Merge]')], [bash('t1'), bash('t2')], true)).toBeNull();
  });

  it('leaves work that would show as one line alone', () => {
    const blocks = [tool('t1', 0), tool('t2', 0), answer('a1', FINAL)];
    expect(splitFinishedTurn(blocks, [bash('t1'), bash('t2')], true)).toBeNull();
  });

  it('folds a turn whose hidden metadata call came after its answer', () => {
    const overview: ToolCallState = { id: 'h1', title: 'set_branch_overview', status: 'completed' };
    const split = splitFinishedTurn([...turn, tool('h1', NOTE.length + FINAL.length)], [bash('t1'), bash('t2'), overview], true);
    expect(split?.work.map((b) => b.id)).toEqual(['b-t1', 'a1', 'b-t2']);
    expect(split?.final.map((b) => b.id)).toEqual(['a2', 'b-h1']);
    expect(split?.tools.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('leaves a turn alone while one of its tools still runs', () => {
    expect(splitFinishedTurn(turn, [bash('t1', 'running'), bash('t2')], true)).toBeNull();
  });

  it('rebases the final answer’s question onto its own run and lifts images and questions out of the work', () => {
    const image: AssistantBlock = { id: 'img', kind: 'image', workspaceId: 'w', path: 'shot.png', mimeType: 'image/png', size: 1 };
    const early: AssistantBlock = { id: 'q1', kind: 'user-input', requestId: 1, section: 'answer', rawOffset: NOTE.length };
    const late: AssistantBlock = { id: 'q2', kind: 'user-input', requestId: 2, section: 'answer', rawOffset: NOTE.length + 6 };
    const blocks = [tool('t1', 0), answer('a1', NOTE), early, image, tool('t2', NOTE.length), answer('a2', 'Asked:'), late, answer('a3', FINAL)];
    const split = splitFinishedTurn(blocks, [bash('t1'), bash('t2')], true);
    expect(split?.work.map((b) => b.id)).toEqual(['b-t1', 'a1', 'b-t2']);
    expect(split?.lifted).toEqual([{ ...early, rawOffset: 0 }, image]);
    // q2 sat 6 characters into "Asked:" once the note before it is left behind.
    expect(split?.final).toEqual([answer('a2', 'Asked:'), { ...late, rawOffset: 6 }, answer('a3', FINAL)]);
  });

  it('ends the work at the last thought and counts hidden thoughts as nothing', () => {
    const thought: AssistantBlock = { id: 'th', kind: 'thinking', rawText: 'Checking the merge base.' };
    const blocks = [answer('a1', NOTE), tool('t1', NOTE.length), thought, answer('a2', FINAL)];
    expect(splitFinishedTurn(blocks, [bash('t1')], true)?.work.map((b) => b.id)).toEqual(['a1', 'b-t1', 'th']);
    // Hidden, the thought adds no line; the note and the tool still fold.
    expect(splitFinishedTurn(blocks, [bash('t1')], false)?.notes).toBe(1);
    // A lone thought is one line.
    expect(splitFinishedTurn([thought, answer('a2', FINAL)], [], true)).toBeNull();
    expect(splitFinishedTurn([answer('a1', NOTE), thought, answer('a2', FINAL)], [], false)).toBeNull();
  });
});
