import { test, expect, type Page } from '@playwright/test';
import { installMockApi, type MockOverrides } from '../fixtures/mockApi';
import { COMPOSER_EDITOR, openThreadFromSidebar } from '../fixtures/shell';

// Pane scroll restore behavior (TPane mount positioning):
//   1. First open on a device (no saved anchor) → bottom.
//   2. Already-read chat left mid-history → reopens where the reader left it.
//   3. Chat with messages newer than the saved lastSeen horizon → first
//      unseen message parked at ~30% of the viewport height.
//   4. A backend that keeps completion facts decides unread instead: the
//      question of the first unread reply is parked there, saved place or not.
//
// State is seeded through localStorage (michi:v1:state) exactly like the
// pane-performance suite; every /api call is intercepted by mockApi.

const STATE_SCHEMA_VERSION = 5;
const PROJECT_ID = 'scroll-ws';
const TURNS = 10;
const BASE_T = 1_780_000_000_000;

function longAnswer(chat: string, turn: number): string {
  const para = `Chat ${chat} turn ${turn}: this paragraph pads the transcript so the pane must scroll. `;
  return [
    `### Chat ${chat} — turn ${turn}`,
    '',
    para.repeat(12),
    '',
    para.repeat(12),
    '',
    para.repeat(12),
  ].join('\n');
}

function makeChatNode(nodeId: string, chat: string, turns: number) {
  const messages = [] as unknown[];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({
      id: `u-${nodeId}-${turn}`,
      role: 'user',
      text: `Question ${turn} for chat ${chat}, with enough words to wrap onto a couple of lines in the pane.`,
      toolCalls: [],
      createdAt: BASE_T + turn * 1_000,
    });
    messages.push({
      id: `a-${nodeId}-${turn}`,
      role: 'assistant',
      text: '',
      toolCalls: [],
      blocks: [{ id: `b-${nodeId}-${turn}`, kind: 'answer', rawText: longAnswer(chat, turn) }],
      streaming: false,
      createdAt: BASE_T + turn * 1_000 + 500,
    });
  }
  return {
    nodeId,
    kind: 'chat',
    chatId: `mock-chat-${nodeId}`,
    runtimeId: 'mock',
    projectId: PROJECT_ID,
    messages,
    // Follow-ups present on purpose — the historical failure mode pinned
    // every followUps-bearing pane to the bottom on open.
    followUps: [`More about ${chat}?`, `Summarize ${chat}?`, `Branch ${chat}?`],
    followUpsSourceMessageId: `a-${nodeId}-${turns - 1}`,
    title: `Chat ${chat}`,
    status: 'idle',
    viewedAt: BASE_T + turns * 1_000,
    lastAssistantAt: BASE_T + (turns - 1) * 1_000 + 500,
  };
}

function makeSavedState() {
  const nodes = {
    nA: makeChatNode('nA', 'A', TURNS),
    nB: makeChatNode('nB', 'B', 2),
  };
  return {
    version: STATE_SCHEMA_VERSION,
    activeProjectId: PROJECT_ID,
    projects: [{
      id: PROJECT_ID,
      name: 'Scroll Restore WS',
      chatIds: ['nA', 'nB'],
      edges: [],
      trees: [
        { id: 'tree-a', rootNodeId: 'nA', createdAt: BASE_T, lastActiveAt: BASE_T + 100 },
        { id: 'tree-b', rootNodeId: 'nB', createdAt: BASE_T, lastActiveAt: BASE_T + 50 },
      ],
      activeTreeId: 'tree-a',
      contexts: [],
      createdAt: BASE_T,
    }],
    nodes,
  };
}

async function seed(page: Page, scrollAnchors?: unknown) {
  await page.addInitScript(({ state, anchors }) => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem('michi:migrated', '1');
    window.localStorage.setItem('michi:v1:state', JSON.stringify(state));
    if (anchors) {
      window.localStorage.setItem('michi:paneScrollAnchors', JSON.stringify(anchors));
    }
  }, { state: makeSavedState(), anchors: scrollAnchors ?? null });
  await installMockApi(page);
}

const paneScroller = (page: Page, nodeId: string) =>
  page.locator(`[data-node-id="${nodeId}"] .term-scrollbar`).first();

interface ScrollProbe {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distFromBottom: number;
  /** data-msg-id of the topmost (partly) visible message. */
  topMsgId: string | null;
  /** topmost message's top edge relative to the viewport top, px. */
  topMsgOffset: number;
}

async function probe(page: Page, nodeId: string): Promise<ScrollProbe> {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-node-id="${id}"] .term-scrollbar`) as HTMLElement;
    const viewTop = el.getBoundingClientRect().top;
    let topMsgId: string | null = null;
    let topMsgOffset = 0;
    for (const f of Array.from(el.querySelectorAll<HTMLElement>('[data-msg-id]'))) {
      const r = f.getBoundingClientRect();
      if (r.bottom > viewTop + 1) {
        topMsgId = f.getAttribute('data-msg-id');
        topMsgOffset = r.top - viewTop;
        break;
      }
    }
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      distFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
      topMsgId,
      topMsgOffset,
    };
  }, nodeId);
}

async function openChat(page: Page, title: string, nodeId: string) {
  await page.getByText(title, { exact: true }).first().click();
  await page.locator(`[data-node-id="${nodeId}"] [data-msg-id]`).first().waitFor({ timeout: 10_000 });
  // Let the mount settle loop and content-visibility inflation finish.
  await page.waitForTimeout(900);
}

test.describe('pane scroll restore', () => {
  test('first open lands at the bottom; reopening returns to where the reader left', async ({ page }) => {
    await seed(page);
    await page.goto('/');

    // ── First open: no saved anchor → bottom ────────────────────────────
    await openChat(page, 'Chat A', 'nA');
    const first = await probe(page, 'nA');
    expect(first.scrollHeight).toBeGreaterThan(first.clientHeight * 3); // long enough to be meaningful
    expect(first.distFromBottom).toBeLessThan(200);

    // ── Scroll up into the middle of the history ────────────────────────
    await page.evaluate(() => {
      const el = document.querySelector('[data-node-id="nA"] .term-scrollbar') as HTMLElement;
      const msg = el.querySelector('[data-msg-id="u-nA-5"]') as HTMLElement;
      el.scrollTop += msg.getBoundingClientRect().top - el.getBoundingClientRect().top - 40;
    });
    await page.waitForTimeout(600); // debounced save (250ms) + slack
    const before = await probe(page, 'nA');
    expect(before.topMsgId).not.toBeNull();
    expect(before.distFromBottom).toBeGreaterThan(400);

    // ── Switch to another chat (pane A unmounts and saves) ──────────────
    await openChat(page, 'Chat B', 'nB');
    await expect(page.locator('[data-node-id="nA"]')).toHaveCount(0);

    // ── Reopen: no newer messages → back at the saved anchor ────────────
    await openChat(page, 'Chat A', 'nA');
    const after = await probe(page, 'nA');
    expect(after.topMsgId).toBe(before.topMsgId);
    expect(Math.abs(after.topMsgOffset - before.topMsgOffset)).toBeLessThan(24);
  });

  test('unread chat opens with the first unseen message at ~30% viewport height', async ({ page }) => {
    // Saved horizon: everything up to turn 6 has been seen. Turns 7..9
    // (user msg u-nA-7 first) landed "while the pane was closed".
    const lastSeen = BASE_T + 6 * 1_000 + 500;
    await seed(page, [[
      'nA',
      { anchorId: 'u-nA-3', offset: -20, atBottom: false, lastSeen },
    ]]);
    await page.goto('/');

    await openChat(page, 'Chat A', 'nA');
    const p = await probe(page, 'nA');

    // The first unseen message sits at upper-middle: ~30% of the viewport
    // height from the top (generous tolerance for content-visibility drift).
    const unseenTop = await page.evaluate(() => {
      const el = document.querySelector('[data-node-id="nA"] .term-scrollbar') as HTMLElement;
      const msg = el.querySelector('[data-msg-id="u-nA-7"]') as HTMLElement;
      return msg.getBoundingClientRect().top - el.getBoundingClientRect().top;
    });
    expect(Math.abs(unseenTop - p.clientHeight * 0.3)).toBeLessThan(64);
    // And we are neither at the bottom nor at the saved anchor.
    expect(p.distFromBottom).toBeGreaterThan(200);
  });

  test('read chat with a saved mid-history anchor opens at that anchor', async ({ page }) => {
    // lastSeen equals the newest message → nothing unseen → the anchor.
    const lastSeen = BASE_T + (TURNS - 1) * 1_000 + 500;
    await seed(page, [[
      'nA',
      { anchorId: 'u-nA-4', offset: -20, atBottom: false, lastSeen },
    ]]);
    await page.goto('/');

    await openChat(page, 'Chat A', 'nA');
    const p = await probe(page, 'nA');
    expect(p.topMsgId).toBe('u-nA-4');
    expect(Math.abs(p.topMsgOffset - -20)).toBeLessThan(24);
    expect(p.distFromBottom).toBeGreaterThan(200);
  });
});

// ── Server unread (completion facts) ─────────────────────────────────────
// These chats come from the backend's rows, which carry completion_seq and
// seen_completion_seq: how many replies were answered, and how many of them
// the reader has seen.

const UNREAD_WS = 'unread-ws';

interface Facts { completionSeq: number; seenCompletionSeq: number }

function messageRows(nodeId: string, chat: string, turns: number) {
  return Array.from({ length: turns }, (_, turn) => [
    { id: `u-${nodeId}-${turn}`, node_id: nodeId, role: 'user', seq: turn * 2 + 1, created_at: BASE_T + turn * 1_000,
      content: `Question ${turn} for chat ${chat}, with enough words to wrap onto a couple of lines in the pane.` },
    { id: `a-${nodeId}-${turn}`, node_id: nodeId, role: 'assistant', seq: turn * 2 + 2, created_at: BASE_T + turn * 1_000 + 500,
      content: longAnswer(chat, turn), blocks: JSON.stringify([{ id: `b-${nodeId}-${turn}`, kind: 'answer', rawText: longAnswer(chat, turn) }]) },
  ]).flat();
}

/** Chat A with `facts`, read Chat B, and with `branch` a Chat C branched from A's last reply. */
function unreadWorkspace(facts: Facts, { branch = false } = {}) {
  const node = (id: string, title: string, f: Facts, treeId = `tree-${id}`, parentId: string | null = null) => ({
    id, workspace_id: UNREAD_WS, tree_id: treeId, parent_node_id: parentId, kind: 'chat', title, runtime_id: 'mock',
    status: 'idle', created_at: BASE_T, completion_seq: f.completionSeq, seen_completion_seq: f.seenCompletionSeq });
  return {
    // B is open, so opening A is what marks its replies seen.
    workspace: { id: UNREAD_WS, name: 'Unread WS', active_tree_id: 'tree-nB', created_at: BASE_T },
    trees: [
      { id: 'tree-nA', workspace_id: UNREAD_WS, root_node_id: 'nA', name: 'Chat A', created_at: BASE_T, last_active_at: BASE_T + 100 },
      { id: 'tree-nB', workspace_id: UNREAD_WS, root_node_id: 'nB', name: 'Chat B', created_at: BASE_T, last_active_at: BASE_T + 50 },
    ],
    nodes: [
      node('nA', 'Chat A', facts),
      node('nB', 'Chat B', { completionSeq: 2, seenCompletionSeq: 2 }),
      ...(branch ? [node('nC', 'Chat C', facts, 'tree-nA', 'nA')] : []),
    ],
    edges: branch
      ? [{ id: 'nA-nC', source_node_id: 'nA', target_node_id: 'nC', kind: 'branch', anchor_message_id: `a-nA-${TURNS - 1}`, created_at: BASE_T }]
      : [],
    contexts: [],
    messages: [...messageRows('nA', 'A', TURNS), ...messageRows('nB', 'B', 2), ...(branch ? messageRows('nC', 'C', TURNS) : [])],
  };
}

/** A long reply that arrives `delayMs` after the send. */
function slowReply(delayMs: number): MockOverrides {
  const chunks = Array.from({ length: 30 }, (_, i) => ({ event: 'chunk' as const,
    data: { text: `Reply paragraph ${i}. ${'Padding words for the long reply. '.repeat(8)}\n\n` } }));
  return { streamDelayMs: delayMs, streamEvents: [...chunks, { event: 'done', data: { stopReason: 'end_turn' } }] };
}

async function seedUnread(page: Page, facts: Facts, scrollAnchors?: unknown, mock: MockOverrides = {}) {
  await page.addInitScript(({ anchors }) => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false }));
    if (anchors) window.localStorage.setItem('michi:paneScrollAnchors', JSON.stringify(anchors));
  }, { anchors: scrollAnchors ?? null });
  await installMockApi(page, { ...mock, workspaces: [unreadWorkspace(facts)] });
}

async function openRow(page: Page, nodeId: string) {
  await page.locator(`.terminal-sidebar [data-sidebar-row="${nodeId}"]`).click();
  await page.locator(`[data-node-id="${nodeId}"] [data-msg-id]`).first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(900);
}

/** Where a message's top sits below the pane's viewport top, px. */
function topOf(page: Page, nodeId: string, messageId: string) {
  return page.evaluate(({ nodeId, messageId }) => {
    const el = document.querySelector(`[data-node-id="${nodeId}"] .term-scrollbar`) as HTMLElement;
    const msg = el.querySelector(`[data-msg-id="${messageId}"]`) as HTMLElement;
    return msg.getBoundingClientRect().top - el.getBoundingClientRect().top;
  }, { nodeId, messageId });
}

test.describe('pane scroll restore with server unread', () => {
  test('with no saved place on this device, an unread chat opens on its first unread reply', async ({ page }) => {
    // Turns 8 and 9 were answered after the reader last saw the chat.
    await seedUnread(page, { completionSeq: TURNS, seenCompletionSeq: TURNS - 2 });
    await page.goto('/');
    await openRow(page, 'nA');
    const p = await probe(page, 'nA');
    expect(Math.abs((await topOf(page, 'nA', 'u-nA-8')) - p.clientHeight * 0.3)).toBeLessThan(64);
    expect(p.distFromBottom).toBeGreaterThan(200);
  });

  test('an unread reply wins over the saved place', async ({ page }) => {
    const lastSeen = BASE_T + (TURNS - 1) * 1_000 + 500;
    await seedUnread(page, { completionSeq: TURNS, seenCompletionSeq: TURNS - 1 },
      [['nA', { anchorId: 'u-nA-3', offset: -20, atBottom: false, lastSeen }]]);
    await page.goto('/');
    await openRow(page, 'nA');
    const p = await probe(page, 'nA');
    expect(Math.abs((await topOf(page, 'nA', 'u-nA-9')) - p.clientHeight * 0.3)).toBeLessThan(64);
  });

  test('with nothing unread a chat opens where the reader left it', async ({ page }) => {
    // The saved horizon is older than turn 9, but the server says it was seen (elsewhere).
    const lastSeen = BASE_T + 6 * 1_000 + 500;
    await seedUnread(page, { completionSeq: TURNS, seenCompletionSeq: TURNS },
      [['nA', { anchorId: 'u-nA-4', offset: -20, atBottom: false, lastSeen }]]);
    await page.goto('/');
    await openRow(page, 'nA');
    const p = await probe(page, 'nA');
    expect(p.topMsgId).toBe('u-nA-4');
    expect(Math.abs(p.topMsgOffset - -20)).toBeLessThan(24);
  });

  test('a reply that finished after the reader left opens on its question', async ({ page }) => {
    await seedUnread(page, { completionSeq: TURNS, seenCompletionSeq: TURNS }, undefined, slowReply(1500));
    await page.goto('/');
    await openRow(page, 'nA');
    await page.locator(COMPOSER_EDITOR).first().fill('A question asked before leaving');
    await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
    const question = page.locator('[data-node-id="nA"] [data-msg-id]', { hasText: 'A question asked before leaving' });
    await expect(question).toHaveCount(1);
    // Leave while the reply is still coming; it finishes while A is closed.
    await openRow(page, 'nB');
    await expect(page.locator('[data-node-id="nA"]')).toHaveCount(0);
    await page.waitForTimeout(2_500);
    await openRow(page, 'nA');
    const p = await probe(page, 'nA');
    const questionId = (await question.getAttribute('data-msg-id'))!;
    expect(Math.abs((await topOf(page, 'nA', questionId)) - p.clientHeight * 0.3)).toBeLessThan(64);
    expect(p.distFromBottom).toBeGreaterThan(200);
  });

  test('on a phone, switching back to a pane whose reply finished out of sight opens on its question', async ({ page }) => {
    // A and its branch C are both open; a phone shows one, the other stays mounted out of sight.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
      window.localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, reduceMotion: true }));
    });
    await installMockApi(page, { ...slowReply(1500),
      workspaces: [unreadWorkspace({ completionSeq: TURNS, seenCompletionSeq: TURNS }, { branch: true })] });
    await page.goto('/');
    await openThreadFromSidebar(page, 'Chat A');
    // Opening the branch from A's transcript keeps A's pane mounted behind it.
    await page.locator('.terminal-dashboard > [data-node-id="nA"]').getByText('Chat C', { exact: true }).click();
    const paneC = page.locator('.terminal-dashboard > [data-node-id="nC"]');
    await expect(paneC).toBeVisible();
    await expect(page.locator('.terminal-dashboard > [data-node-id="nA"]')).toBeAttached();
    await paneC.getByRole('textbox', { name: 'Message' }).fill('A question asked before switching');
    await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
    const question = paneC.locator('[data-msg-id]', { hasText: 'A question asked before switching' });
    await expect(question).toHaveCount(1);
    const switcher = page.getByRole('button', { name: 'Switch pane' });
    const list = page.getByRole('navigation', { name: 'Branches and panes' });
    await switcher.click();
    await list.getByRole('button', { name: 'Chat A', exact: true }).click();
    await expect(page.locator('.terminal-dashboard > [data-node-id="nA"]')).toBeVisible();
    await page.waitForTimeout(2_500);
    await switcher.click();
    await list.getByRole('button', { name: 'Chat C', exact: true }).click();
    await expect(paneC).toBeVisible();
    await page.waitForTimeout(900);
    const p = await probe(page, 'nC');
    const questionId = (await question.getAttribute('data-msg-id'))!;
    expect(Math.abs((await topOf(page, 'nC', questionId)) - p.clientHeight * 0.3)).toBeLessThan(64);
    expect(p.distFromBottom).toBeGreaterThan(200);
  });
});
