import { describe, expect, it } from 'vitest';
import type { ToolCallState } from '../chatTypes';
import { companionToolLine, companionWorkLine, type CompanionToolLineNames } from './companionToolLines';

const names: CompanionToolLineNames = {
  workspace: (id) => (id === 'ws-work' ? 'Work' : null),
  page: () => null,
  item: (id) => (id === 'cmi-1' ? 'CR-123456 needs attention' : null),
  goal: (id) => (id === 'cmg-1' ? 'Ship the launch' : null),
};

let calls = 0;
/** A call as the runtimes report it; Claude names Michi's MCP tools `@michi/<tool>`. */
const tool = (title: string, input: unknown = {}, status = 'completed'): ToolCallState => ({
  id: `t-${++calls}`, title, status, inputJson: JSON.stringify(input), startedAt: 1_000, endedAt: 1_027,
});

describe('the Companion’s tool calls in plain words', () => {
  it('words a memory write by what it did: a save that was not made says so, never "Remembered"', () => {
    const answered = (title: string, input: unknown, output: unknown, status = 'completed'): ToolCallState =>
      ({ ...tool(title, input, status), output: JSON.stringify(output) });
    const body = { body: 'Prefers short answers', kind: 'preference', userAsked: true };
    expect([
      companionToolLine(answered('@michi/memory_save', body, { status: 'saved', ref: 'm:1' }), names),
      companionToolLine(answered('@michi/memory_save', body, { status: 'not_saved', reason: 'deleted_before', deletedOn: '2026-11-01' }), names),
      companionToolLine(answered('@michi/memory_save', body, { status: 'not_saved', reason: 'companion_material' }), names),
      companionToolLine(answered('@michi/memory_update', { ref: 'm:1', body: 'x' }, { status: 'not_saved', reason: 'companion_material' }), names),
      companionToolLine(answered('@michi/memory_update', { ref: 'm:1', body: 'x' }, { status: 'updated' }), names),
      companionToolLine(answered('@michi/memory_delete', { ref: 'm:1' }, { status: 'deleted' }), names),
      companionToolLine(answered('@michi/memory_delete', { ref: 'm:1' }, 'Go to Settings → Memory', 'failed'), names),
      companionToolLine(tool('@michi/memory_save', body, 'running'), names),
    ]).toEqual([
      'Remembered “Prefers short answers”',
      'Didn’t save it: you removed it before',
      'Didn’t save it: this turn read check-in material',
      'Didn’t save it: this turn read check-in material',
      'Updated a memory',
      'Forgot a memory',
      'Couldn’t forget a memory',
      'Saving a memory',
    ]);
  });

  it('words each of its own tools, never by its raw name', () => {
    const lines: Array<[ToolCallState, string]> = [
      [tool('@michi/companion_items'), 'Looked at Today’s items'],
      [tool('@michi/companion_items', { source: 'cr', bucket: 'needs_you' }), 'Looked at Today’s items · code reviews · what needs you'],
      [tool('@michi/companion_item', { itemId: 'cmi-1' }), 'Looked at “CR-123456 needs attention”'],
      [tool('@michi/companion_item', { itemId: 'cmi-gone' }), 'Looked at an item'],
      [tool('@michi/companion_check_now'), 'Checked sources'],
      [tool('@michi/companion_check_now', { sources: ['cr', 'pipeline', 'calendar'] }), 'Checked code reviews, pipelines and calendar'],
      [tool('@michi/companion_update_item', { itemId: 'cmi-1', action: 'dismiss' }), 'Marked “CR-123456 needs attention” done'],
      [tool('@michi/companion_update_item', { itemId: 'cmi-1', action: 'snooze', until: 5 }), 'Snoozed “CR-123456 needs attention”'],
      [tool('@michi/companion_save_notes', { notes: 'x', expectedRevision: 2 }), 'Saved its notes'],
      [tool('@michi/companion_goal_progress', { goalId: 'cmg-1', progress: 'Half way' }), 'Noted progress on “Ship the launch”'],
      [tool('@michi/companion_propose', { kind: 'reminder.add', payload: {} }), 'Suggested a reminder'],
      [tool('@michi/companion_propose', { kind: 'something.new', payload: {} }), 'Suggested a change'],
      [tool('@michi/companion_publish_brief', { headline: 'x', cards: [], closing: 'y' }), 'Wrote today’s brief'],
      [tool('@michi/companion_set_name', { name: 'Sidekick' }), 'Changed its name to “Sidekick”'],
      [tool('@michi/companion_set_notifications', { level: 'off' }), 'Turned off notifications'],
      [tool('@michi/companion_set_notifications', { level: 'approval-only' }), 'Set notifications to only what needs you'],
      [tool('@michi/companion_set_notifications', { level: 'all' }), 'Turned on all notifications'],
      [tool('@michi/companion_cr_detail', { cr: 'https://reviews.example.com/reviews/CR-123456/revisions/2' }), 'Read CR-123456'],
      [tool('@michi/companion_cr_detail', { cr: '654321' }), 'Read CR-654321'],
      [tool('@michi/companion_cr_detail', { cr: 'the big one' }), 'Read a CR'],
      [tool('@michi/companion_pipeline_detail', { pipeline: 'MyService' }), 'Read pipeline MyService'],
      [tool('@michi/companion_email_search', { query: 'quarterly planning' }), 'Searched email for “quarterly planning”'],
      [tool('@michi/nothing_to_do', { note: 'nothing new' }), 'Nothing worth a message'],
    ];
    for (const [call, line] of lines) expect(companionToolLine(call, names), call.title).toBe(line);
  });

  it('says what it is doing while a call runs', () => {
    expect(companionToolLine(tool('@michi/companion_check_now', {}, 'in_progress'), names)).toBe('Checking sources');
    expect(companionToolLine(tool('@michi/companion_cr_detail', { cr: 'CR-1' }, 'pending'), names)).toBe('Reading CR-1');
  });

  it('knows its tools by every runtime’s name for them', () => {
    for (const title of ['@michi/companion_items', 'mcp__michi-tools__companion_items', 'companion_items', 'michi_internal____companion_items']) {
      expect(companionToolLine(tool(title), names), title).toBe('Looked at Today’s items');
    }
  });

  it('words its Michi read tools as the Meta agent does, and leaves anything else to the generic row', () => {
    expect(companionToolLine(tool('@michi/list_workspaces'), names)).toBe('List workspaces');
    expect(companionToolLine(tool('@michi/read_node', {}), names)).toBe('Read a conversation');
    expect(companionToolLine(tool('Bash', { command: 'ls' }), names)).toBeNull();
  });
});

describe('what a finished activity block of the Companion did', () => {
  it('is a lone call’s own line', () => {
    expect(companionWorkLine([tool('@michi/companion_items')], names)).toBe('Looked at Today’s items');
    expect(companionWorkLine([tool('@michi/companion_cr_detail', { cr: 'CR-42' }, 'failed')], names)).toBe('Read CR-42');
  });

  it('lists the kinds of work in order, counted', () => {
    // The user turn of the smoke run: five item reads, a check, four CR reads, saved notes.
    const turn = [
      ...Array.from({ length: 5 }, () => tool('@michi/companion_items', { source: 'cr' })),
      tool('@michi/companion_check_now', { sources: ['cr', 'pipeline', 'calendar'] }),
      ...['CR-1', 'CR-2', 'CR-3', 'CR-4'].map((cr) => tool('@michi/companion_cr_detail', { cr })),
      tool('@michi/companion_save_notes', { notes: 'x', expectedRevision: 1 }),
    ];
    expect(companionWorkLine(turn, names)).toBe('Looked at Today’s items, checked sources, read 4 CRs and saved its notes');
    expect(companionWorkLine([tool('@michi/companion_cr_detail', { cr: 'CR-7' }), tool('@michi/companion_cr_detail', { cr: 'CR-7' })], names)).toBe('Read CR-7');
  });

  it('keeps at most four kinds of work, and counts calls it cannot word', () => {
    const many = ['companion_items', 'companion_check_now', 'companion_cr_detail', 'companion_email_search', 'companion_publish_brief']
      .map((name) => tool(`@michi/${name}`, name === 'companion_cr_detail' ? { cr: 'CR-1' } : {}));
    expect(companionWorkLine(many, names)).toBe('Looked at Today’s items, checked sources, read CR-1 and more');
    expect(companionWorkLine([tool('@michi/companion_items'), tool('Bash')], names)).toBe('Looked at Today’s items and used 1 more tool');
  });

  it('leaves a block none of whose calls is the Companion’s to the generic header', () => {
    expect(companionWorkLine([tool('Bash'), tool('Read a.ts')], names)).toBeNull();
    expect(companionWorkLine([], names)).toBeNull();
  });
});
