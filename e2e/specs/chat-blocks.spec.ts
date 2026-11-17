import fs from 'node:fs';
import { test, expect, type Page, type Route } from '@playwright/test';
import { installMockApi, bootWithWorkspace, sseBody } from '../fixtures/mockApi';
import { COMPOSER_EDITOR } from '../fixtures/shell';

/**
 * A reply that shows rich blocks (show_blocks): the backend's `blocks` frame
 * draws a form, a poll and a stat inside the reply; answering one sends a
 * single message in the same thread, and the block stays locked, after a
 * reload too. The mock API stands in for the backend, block submissions
 * (routes/blockSubmissions.ts: first write wins, 409 after) included.
 */

const SHOTS = process.env.MICHI_CHAT_BLOCKS_SHOTS ?? '/tmp/iblocks-c';

const BLOCKS = [
  { type: 'form', id: 'cb-form', title: 'Trip details', prompt: 'Plan the trip with these details', fields: [
    { key: 'city', label: 'City', type: 'text', required: true },
    { key: 'nights', label: 'Nights', type: 'number' },
  ] },
  { type: 'poll', id: 'cb-poll', question: 'Which day should we leave?', options: ['Friday', 'Saturday'] },
  { type: 'stat', id: 'cb-stat', label: 'Budget left', value: '$420', delta: '-$80', deltaTone: 'down' },
];
const FALLBACK = 'Trip\n\nTrip details\n- City (required)\n- Nights\n\nWhich day should we leave?\n- Friday\n- Saturday\n\nBudget left: $420 (-$80)';

interface Sent { path: string; displayText: string; blockAnswer?: unknown }
interface Mock { sent: Sent[]; submissions: Array<{ host: string; blockId: string; signature: string }> }

/** The thread's turns (the first shows the blocks, the rest answer) and an in-memory block_submissions table. */
async function installBlocksBackend(page: Page, workspaces?: unknown[]): Promise<Mock> {
  const mock: Mock = { sent: [], submissions: [] };
  const stored = new Map<string, { host: string; submission: Record<string, unknown> }>();
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await installMockApi(page, { ...(workspaces ? { workspaces } : {}), custom: async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (/\/workspaces\/[^/]+\/block-submissions$/.test(path)) {
      if (request.method() === 'GET') {
        const host = url.searchParams.get('host');
        return json(route, 200, { submissions: [...stored.values()].filter((row) => row.host === host).map((row) => row.submission) }).then(() => true);
      }
      const body = request.postDataJSON() as { host: { kind: string; nodeId: string; messageId: string }; blockId: string; signature: string; value: unknown; text: string };
      const host = `chat:${body.host.nodeId}:${body.host.messageId}`;
      const key = `${host}\0${body.blockId}\0${body.signature}`;
      const existing = stored.get(key);
      if (existing) return json(route, 409, { code: 'already_submitted', submission: existing.submission }).then(() => true);
      const submission = { blockId: body.blockId, signature: body.signature, value: body.value, text: body.text, submittedAt: Date.now() };
      stored.set(key, { host, submission });
      mock.submissions.push({ host, blockId: body.blockId, signature: body.signature });
      return json(route, 201, { submission }).then(() => true);
    }
    if (request.method() !== 'POST' || !/\/chats\/[^/]+\/message$/.test(path)) return false;
    const payload = request.postDataJSON() as { displayText?: string; text?: string; userMetadata?: { blockAnswer?: unknown } };
    mock.sent.push({ path, displayText: payload.displayText ?? payload.text ?? '', ...(payload.userMetadata?.blockAnswer ? { blockAnswer: payload.userMetadata.blockAnswer } : {}) });
    const first = !workspaces && mock.sent.length === 1;
    await route.fulfill({ contentType: 'text/event-stream', body: sseBody(first ? [
      { event: 'turn_start', data: { turnId: 'turn-1', assistantId: 'a-blocks-1', nodeId: '', userText: payload.displayText ?? '' } },
      { event: 'chunk', data: { text: 'A few details first.' } },
      { event: 'tool_call', data: { toolCallId: 'tc-blocks', title: 'show_blocks', status: 'completed', kind: 'other', inputJson: JSON.stringify({ title: 'Trip', blocks: BLOCKS.map(({ id: _id, ...block }) => block) }) } },
      { event: 'blocks', data: { blocks: BLOCKS, title: 'Trip', fallbackText: FALLBACK } },
      { event: 'done', data: { stopReason: 'end_turn', persisted: true } },
    ] : [
      { event: 'chunk', data: { text: 'Noted, thanks.' } },
      { event: 'done', data: { stopReason: 'end_turn', persisted: true } },
    ]) });
    return true;
  } });
  return mock;
}

async function expectFits(page: Page, width: number) {
  const card = page.locator('.t-chat-blocks').first();
  await expect(card).toBeVisible();
  await expect.poll(async () => {
    const box = await card.boundingBox();
    return box ? box.x + box.width : Infinity;
  }).toBeLessThanOrEqual(width + 1);
  expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
}

const pollCard = (page: Page) => page.locator('.t-chat-blocks [data-block-id="cb-poll"]');
const formCard = (page: Page) => page.locator('.t-chat-blocks [data-block-id="cb-form"]');

test.describe('chat blocks', () => {
  test.beforeAll(() => fs.mkdirSync(SHOTS, { recursive: true }));

  test('a reply draws a form, a poll and a stat; a vote sends one message in the same thread and locks', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const mock = await installBlocksBackend(page);
    await bootWithWorkspace(page, 'Chat blocks');
    await page.locator(COMPOSER_EDITOR).first().fill('Help me plan a trip');
    await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();

    const card = page.locator('.t-chat-blocks');
    await expect(card).toHaveCount(1);
    await expect(card.getByRole('heading', { name: 'Trip', exact: true })).toBeVisible();
    await expect(card.getByRole('heading', { name: 'Trip details' })).toBeVisible();
    await expect(card.getByRole('heading', { name: 'Which day should we leave?' })).toBeVisible();
    await expect(card.getByText('$420')).toBeVisible();
    // Nothing in the blocks took focus from where the user was.
    expect(await page.evaluate(() => !!document.activeElement?.closest('.t-chat-blocks'))).toBe(false);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expectFits(page, 1280);
    await page.screenshot({ path: `${SHOTS}/chat-blocks-desktop.png`, animations: 'disabled' });

    await pollCard(page).getByRole('radio', { name: 'Saturday' }).check();
    await pollCard(page).getByRole('button', { name: 'Vote' }).click();
    await expect.poll(() => mock.sent.length).toBe(2);
    expect(mock.sent[1]).toEqual({ path: mock.sent[0].path, displayText: 'For “Which day should we leave?” I pick: Saturday',
      blockAnswer: { messageId: 'a-blocks-1', blockId: 'cb-poll', title: 'Which day should we leave?' } });
    // Stored under this reply (its assistant message id from turn_start) before it was sent.
    expect(mock.submissions.map((row) => row.blockId)).toEqual(['cb-poll']);
    expect(mock.submissions[0].host).toMatch(/^chat:[^:]+:a-blocks-1$/);
    // The answer is one line under the reply, not a bubble; its sent text opens on demand.
    const answerLine = page.locator('.t-block-answer');
    await expect(answerLine.getByText('Answered “Which day should we leave?”', { exact: true })).toBeVisible();
    await expect(page.locator('.terminal-message-user').getByText('For “Which day should we leave?” I pick: Saturday', { exact: true })).toHaveCount(0);
    await answerLine.getByRole('button', { name: 'Show' }).click();
    await expect(answerLine.locator('.terminal-message-user').getByText('For “Which day should we leave?” I pick: Saturday', { exact: true })).toBeVisible();
    await answerLine.getByRole('button', { name: 'Hide' }).click();
    await expect(page.getByText('Noted, thanks.', { exact: true })).toBeVisible();
    // Answered: read-only with the pick, and no way to send it again.
    await expect(pollCard(page).getByText(/^Submitted ·/)).toBeVisible();
    await expect(pollCard(page).getByRole('button', { name: 'Vote' })).toHaveCount(0);
    await expect(pollCard(page).getByRole('radio', { name: 'Saturday' })).toBeChecked();
    await expect(pollCard(page).getByRole('radio', { name: 'Friday' })).toBeDisabled();
    expect(mock.sent).toHaveLength(2);

    await page.setViewportSize({ width: 390, height: 844 });
    await expectFits(page, 390);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/chat-blocks-phone.png`, animations: 'disabled' });
    expect(errors).toEqual([]);
  });

  test('a stored reply draws its blocks; answers send once and stay locked after a reload', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const workspace = {
      workspace: { id: 'blocks-ws', name: 'Blocks history', active_tree_id: 'blocks-tree', created_at: 1 },
      trees: [{ id: 'blocks-tree', workspace_id: 'blocks-ws', root_node_id: 'blocks-node', name: 'Trip', created_at: 1, last_active_at: 1 }],
      nodes: [{ id: 'blocks-node', workspace_id: 'blocks-ws', tree_id: 'blocks-tree', kind: 'chat', title: 'Trip', runtime_id: 'kiro', status: 'idle', created_at: 1 }],
      edges: [], contexts: [], messages: [
        { id: 'u-answer', node_id: 'blocks-node', role: 'user', seq: 0, content: 'Help me plan a trip' },
        { id: 'answer', node_id: 'blocks-node', role: 'assistant', seq: 1,
          // What the backend stores: the answer, then the blocks' plain text for windows that do not draw them.
          content: `A few details first.\n\n${FALLBACK}`,
          blocks: JSON.stringify([
            { id: 'answer-b-0', kind: 'answer', rawText: 'A few details first.' },
            { id: 'answer-b-1', kind: 'blocks', blocks: BLOCKS, title: 'Trip', fallbackText: FALLBACK },
          ]),
        },
      ],
    };
    const mock = await installBlocksBackend(page, [workspace]);
    await page.addInitScript(() => localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false })));
    await page.goto('/');
    await page.locator('.terminal-sidebar [data-sidebar-row="blocks-node"]').click();
    const card = page.locator('.t-chat-blocks');
    await expect(card).toHaveCount(1);
    expect(await card.locator('[data-block-id]').evaluateAll((els) => els.map((el) => el.getAttribute('data-block-id')))).toEqual(['cb-form', 'cb-poll', 'cb-stat']);
    await expect(page.getByText('A few details first.', { exact: true })).toBeVisible();
    // The fallback text is for windows that do not draw blocks; this one draws them.
    await expect(page.locator('.terminal-message-assistant')).not.toContainText('- City (required)');

    // A required field left empty sends nothing.
    await formCard(page).getByRole('button', { name: 'Submit' }).click();
    await expect(formCard(page).getByText('Fill this in')).toBeVisible();
    expect(mock.sent).toHaveLength(0);
    await formCard(page).getByRole('textbox', { name: 'City' }).fill('Lisbon');
    await formCard(page).getByRole('textbox', { name: 'Nights' }).fill('3');
    await formCard(page).getByRole('button', { name: 'Submit' }).click();
    await expect.poll(() => mock.sent.length).toBe(1);
    expect(mock.sent[0].displayText).toBe('Plan the trip with these details\n\n{"city":"Lisbon","nights":3}');
    await expect(page.getByText('Noted, thanks.', { exact: true })).toBeVisible();
    await pollCard(page).getByRole('radio', { name: 'Friday' }).check();
    await pollCard(page).getByRole('button', { name: 'Vote' }).click();
    await expect.poll(() => mock.sent.length).toBe(2);
    expect(mock.sent[1]).toEqual({ path: mock.sent[0].path, displayText: 'For “Which day should we leave?” I pick: Friday',
      blockAnswer: { messageId: 'answer', blockId: 'cb-poll', title: 'Which day should we leave?' } });
    expect(mock.sent[0].blockAnswer).toEqual({ messageId: 'answer', blockId: 'cb-form', title: 'Trip details' });
    expect(mock.submissions.map((row) => [row.host, row.blockId])).toEqual([
      ['chat:blocks-node:answer', 'cb-form'], ['chat:blocks-node:answer', 'cb-poll'],
    ]);

    await page.reload();
    await page.locator('.terminal-sidebar [data-sidebar-row="blocks-node"]').click();
    await expect(card).toHaveCount(1);
    await expect(formCard(page).getByText(/^Submitted ·/)).toBeVisible();
    // A submitted form is a record: its answers as text, no controls.
    await expect(formCard(page).locator('.desk-form-answers dd').first()).toHaveText('Lisbon');
    await expect(formCard(page).getByRole('textbox')).toHaveCount(0);
    await expect(formCard(page).getByRole('button', { name: 'Submit' })).toHaveCount(0);
    await expect(pollCard(page).getByText(/^Submitted ·/)).toBeVisible();
    await expect(pollCard(page).getByRole('radio', { name: 'Friday' })).toBeChecked();
    await expect(pollCard(page).getByRole('button', { name: 'Vote' })).toHaveCount(0);
    expect(mock.sent).toHaveLength(2);
    await page.screenshot({ path: `${SHOTS}/chat-blocks-reloaded.png`, animations: 'disabled' });
    expect(errors).toEqual([]);
  });
});
