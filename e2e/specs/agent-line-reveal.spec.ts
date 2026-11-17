import { test, expect, type Browser, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

/**
 * Opening a line block whose body lands under the floating composer scrolls
 * the transcript until the body shows, resting where the tail rests (28px
 * above the card). A body taller than the view stops with its row under the
 * top fade instead of scrolling past it. The card chrome's height reveals
 * scroll the same way once their body has grown.
 */

const NODE = 'reveal-node';
const FILLER = Array(6).fill('Each earlier answer runs long enough that the conversation is scrolled to its end.').join(' ');
const NOTE = Array(4).fill('A note between the reads, long enough to wrap over several lines on a phone.').join(' ');

const read = (id: string, at: number) => ({
  id, title: 'Read', kind: 'read', status: 'completed',
  inputJson: JSON.stringify({ file_path: `frontend/src/${id}.ts` }), startedAt: at, endedAt: at + 50,
});

/** A finished turn: its notes and reads fold into one "Worked for" row above `final`. */
function turn(id: string, seq: number, notes: string[], final: string) {
  const tools = notes.map((_, i) => read(`${id}-r${i}`, 1_000 + i * 100));
  let offset = 0;
  const blocks = notes.flatMap((note, i) => {
    offset += note.length;
    return [
      { id: `${id}-n${i}`, kind: 'answer', rawText: note },
      { id: `${id}-b${i}`, kind: 'tool', toolCallId: tools[i].id, section: 'answer', rawOffset: offset },
    ];
  });
  blocks.push({ id: `${id}-final`, kind: 'answer', rawText: final });
  return {
    id, node_id: NODE, role: 'assistant', seq, content: notes.join('') + final,
    tool_calls: JSON.stringify(tools), blocks: JSON.stringify(blocks),
  };
}

const workspace = {
  workspace: { id: 'reveal-ws', name: 'Reveal', active_tree_id: 'reveal-tree', created_at: 1 },
  trees: [{ id: 'reveal-tree', workspace_id: 'reveal-ws', root_node_id: NODE, name: 'Reveal', created_at: 1, last_active_at: 1 }],
  nodes: [{ id: NODE, workspace_id: 'reveal-ws', tree_id: 'reveal-tree', kind: 'chat', title: 'Reveal', runtime_id: 'claude', status: 'idle', created_at: 1 }],
  edges: [], contexts: [],
  messages: [
    ...[1, 2, 3].flatMap((i) => [
      { id: `q${i}`, node_id: NODE, role: 'user', seq: i * 2 - 1, content: `Question ${i}` },
      { id: `a${i}`, node_id: NODE, role: 'assistant', seq: i * 2, content: FILLER },
    ]),
    { id: 'q-tall', node_id: NODE, role: 'user', seq: 7, content: 'Read everything.' },
    turn('tall', 8, Array(6).fill(NOTE), 'All read.'),
    { id: 'q-last', node_id: NODE, role: 'user', seq: 9, content: 'Read two files.' },
    turn('last', 10, ['Reading the first.', ' Then the second.'], ' Both read.'),
  ],
};

async function openPhoneChat(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await installMockApi(page, { workspaces: [workspace] });
  await page.addInitScript(() => localStorage.setItem('michi:v1:prefs', JSON.stringify({
    onboardingCompletedAt: 1, sidebarCollapsed: true,
  })));
  await page.goto('/');
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
  await page.locator(`.terminal-sidebar [data-sidebar-row="${NODE}"]`).click();
  const transcript = page.locator(`.terminal-pane[data-node-id="${NODE}"] .terminal-pane__transcript`);
  await expect(page.locator('[data-msg-id="last"]').getByRole('button', { name: /Worked for/ })).toBeVisible();
  await expect.poll(() => transcript.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2);
  return { context, page, transcript };
}

/** Where an opened fold sits once the transcript stops moving. */
function settled(page: Page, msgId: string) {
  return page.evaluate(async (id) => {
    const transcript = document.querySelector<HTMLElement>('.terminal-pane__transcript')!;
    let last = -1;
    while (transcript.scrollTop !== last) {
      last = transcript.scrollTop;
      await new Promise((r) => setTimeout(r, 120));
    }
    const fold = document.querySelector(`[data-msg-id="${id}"] .agent-line-run--workfold`)!;
    const body = fold.querySelector(':scope > .agent-line-body:not([hidden])')!.getBoundingClientRect();
    return {
      rowTop: Math.round(fold.getBoundingClientRect().top - transcript.getBoundingClientRect().top),
      aboveComposer: Math.round(document.querySelector('.terminal-composer')!.getBoundingClientRect().top - body.bottom),
    };
  }, msgId);
}

test('a block opened under the composer scrolls until its body rests above it', async ({ browser, baseURL }) => {
  const { context, page, transcript } = await openPhoneChat(browser, baseURL);
  try {
    const before = await transcript.evaluate((el) => el.scrollTop);
    await page.locator('[data-msg-id="last"]').getByRole('button', { name: /Worked for/ }).click();
    const { aboveComposer } = await settled(page, 'last');
    // The tail gap; the composer's measured height rounds up, a pixel at most.
    expect(aboveComposer).toBeGreaterThanOrEqual(28);
    expect(aboveComposer).toBeLessThanOrEqual(29);
    expect(await transcript.evaluate((el) => el.scrollTop)).toBeGreaterThan(before);
  } finally {
    await context.close();
  }
});

test('a body taller than the view stops with its row under the top fade', async ({ browser, baseURL }) => {
  const { context, page } = await openPhoneChat(browser, baseURL);
  try {
    await page.locator('[data-msg-id="tall"]').getByRole('button', { name: /Worked for/ }).click();
    const { rowTop, aboveComposer } = await settled(page, 'tall');
    // The default pane-top fade is 30px.
    expect(rowTop).toBe(30);
    expect(aboveComposer).toBeLessThan(0);
  } finally {
    await context.close();
  }
});
