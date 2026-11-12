import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpaceActivityDetail, SpaceActivityItem } from 'michi-shared';
import { resetCompanionStoreForTests } from '../../../../state/companion/companionStore';
import { companionSnapshot } from '../../../../test/companionFixtures';
import { SpaceActivityList } from './HomeActivity';

afterEach(() => resetCompanionStoreForTests());
function nameAgent(displayName: string) {
  const snapshot = companionSnapshot();
  resetCompanionStoreForTests({ snapshot: { ...snapshot, settings: { ...snapshot.settings, displayName } } });
}

const NOW = Date.UTC(2026, 9, 23, 12);

function change(pageTitle: string, detail: SpaceActivityDetail, extra: Partial<Extract<SpaceActivityItem, { kind: 'page-change' }>> = {}): SpaceActivityItem {
  return {
    kind: 'page-change', batchId: `b-${pageTitle}-${detail.action}-${extra.pending ?? 0}`, pageId: `pg-${pageTitle}`, pageTitle, workspaceId: 'ws', workspaceName: 'rabbitholes',
    at: NOW - 60_000, count: detail.targets, pending: 0, ops: ['update'], summary: 'ignored when a detail is there', actor: detail.by.kind === 'user' ? 'user' : 'agent',
    sourceKind: detail.by.kind === 'user' ? 'user' : 'chat', sourceNodeId: null, detail, ...extra,
  };
}
const base = { names: [], targets: 1, undone: false };

const texts = () => screen.getAllByRole('button').map((row) => row.querySelector('.spaces-home-feed__text')!.textContent);
function rows(items: SpaceActivityItem[]) {
  render(<SpaceActivityList items={items} clock={NOW} onOpen={vi.fn()} />);
  return texts();
}

describe('Space activity rows', () => {
  it('say which page, who and what, in a few words', () => {
    expect(rows([
      change('Home', { ...base, by: { kind: 'companion', via: 'conversation' }, action: 'rewrote', names: ['本周重点'] }),
      change('京都 5 日', { ...base, by: { kind: 'conversation', title: '京都住宿对比' }, action: 'rewrote', names: ['预算'], value: { name: '预算', from: '¥9,800', to: '¥11,600' } }),
      change('Michi 0.9 发布', { ...base, by: { kind: 'conversation', title: '排查公证失败' }, action: 'updated', names: ['进展', '风险'], targets: 2 }, { pending: 1 }),
      change('rabbitholes', { ...base, by: { kind: 'conversation', title: '排查公证失败' }, action: 'updated', names: ['进展'], entries: { added: 2, removed: 0 } }),
      change('Home', { ...base, by: { kind: 'companion', via: 'conversation' }, action: 'suggested', names: ['我写的'] }, { pending: 1 }),
      change('Home', { ...base, by: { kind: 'companion', via: 'conversation' }, action: 'accepted', names: ['我写的'] }),
      change('性能', { ...base, by: { kind: 'companion', via: 'conversation' }, action: 'added', names: ['还没修的', '下一步'], targets: 2 }, { ops: ['insert'] }),
    ])).toEqual([
      'Home · Michi rewrote “本周重点”',
      '京都 5 日 · 预算 ¥9,800 → ¥11,600',
      'Michi 0.9 发布 · “排查公证失败” updated “进展” and “风险”, 1 waiting for you',
      'rabbitholes · “排查公证失败” added 2 entries to “进展”',
      'Home · Michi suggested a rewrite of “我写的”',
      'Home · You accepted the rewrite of “我写的”',
      '性能 · Michi added “还没修的” and “下一步”',
    ]);
  });

  it('name the agent as the user calls it: its conversations and check-ins as <name>, its upkeep as <name> · Pages upkeep', () => {
    nameAgent('Robin');
    expect(rows([
      change('Tasks', { ...base, by: { kind: 'companion', via: 'conversation' }, action: 'added', names: ['Ship it'] }),
      change('Tasks', { ...base, by: { kind: 'companion', via: 'checkin' }, action: 'suggested', names: ['Risks'] }, { pending: 1 }),
      change('Home', { ...base, by: { kind: 'companion', via: 'upkeep' }, action: 'rewrote', names: ['本周重点'] }),
    ])).toEqual([
      'Tasks · Robin added “Ship it”',
      'Tasks · Robin suggested a rewrite of “Risks”',
      'Home · Robin · Pages upkeep rewrote “本周重点”',
    ]);
    act(() => nameAgent('Kit'));
    expect(texts()[0]).toBe('Tasks · Kit added “Ship it”');
    expect(texts().join(' ')).not.toMatch(/meta agent/i);
  });

  it('count places that have no name, and say when a change was undone or a removal is suggested', () => {
    expect(rows([
      change('Home', { ...base, by: { kind: 'user' }, action: 'updated', names: ['我写的'], targets: 3 }),
      change('Release', { ...base, by: { kind: 'agent' }, action: 'rewrote', names: ['Risks'], undone: true }),
      change('Release', { ...base, by: { kind: 'companion', via: 'conversation' }, action: 'suggested', names: ['Risks'] }, { ops: ['delete'], pending: 1 }),
    ])).toEqual([
      'Home · You updated 3 places',
      'Release · Agent rewrote “Risks” · undone',
      'Release · Michi suggested removing “Risks”',
    ]);
  });

  it('tint rows newer than the last look at the Home and keep the older wording for older backends', () => {
    const fresh = change('Home', { ...base, by: { kind: 'companion', via: 'conversation' }, action: 'rewrote', names: ['本周重点'] }, { fresh: true });
    const old = { ...change('Release', { ...base, by: { kind: 'agent' }, action: 'rewrote' }), detail: undefined, count: 2, pending: 1, summary: '**Risk** rewritten' };
    const texts = rows([fresh, old]);
    const [first, second] = screen.getAllByRole('button');
    expect(first!.hasAttribute('data-fresh')).toBe(true);
    expect(second!.hasAttribute('data-fresh')).toBe(false);
    expect(texts).toEqual(['Home · Michi rewrote “本周重点” (new)', 'Release · Agent changed 2 places, 1 waiting for you: Risk rewritten']);
  });
});
