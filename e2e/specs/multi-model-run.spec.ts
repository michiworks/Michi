import { test, expect, type Page, type Route } from '@playwright/test';
import type { MultiModelRunView, MultiModelThreadView, WorkflowRunDtoV1 } from '../../shared/src';
import { installMockApi } from '../fixtures/mockApi';
import { openThreadFromSidebar } from '../fixtures/shell';

/**
 * A multi-model plan in the chat that proposed it, browser-side: the agent's
 * propose_multi_model_plan call renders the plan card from its result; Start
 * posts to the run, and the card turns into progress in place. A branch's
 * approval is answered on its row, a row opens the Background work drawer,
 * and Side by side opens the chat and its branches as panes. The backend is
 * mocked: workflow-run frames come from the subscribe stream, which hands
 * out the run's current state on every (re)connect.
 */

const RUN_ID = 'wfr_mm';

const proposal = {
  status: 'proposed', runId: RUN_ID, nativeId: 'mm_e2e',
  threads: [{ key: 't1', label: 'Codex · GPT-6.1 Sol', context: 'fork' }, { key: 't2', label: 'Pi · Gemini 4 Argon', context: 'fresh' }],
  reviewRounds: 1,
  next: 'The plan card is shown to the user. End your turn now with one short sentence; do not repeat the plan.',
};

function thread(key: string, patch: Partial<MultiModelThreadView>): MultiModelThreadView {
  return {
    key, runtimeId: 'codex', providerId: null, modelId: 'sol', reasoning: null, runtimeLabel: 'Codex', modelLabel: 'GPT-6.1 Sol',
    context: 'fork', promptPreview: 'Assess reliability and crash recovery.', childNodeId: null, steps: [], ...patch,
  };
}

const sol = (patch: Partial<MultiModelThreadView> = {}) => thread('t1', patch);
const argon = (patch: Partial<MultiModelThreadView> = {}) => thread('t2', {
  runtimeId: 'pi', providerId: 'google', modelId: 'argon', runtimeLabel: 'Pi', modelLabel: 'Gemini 4 Argon', context: 'fresh',
  promptPreview: 'Per turn or idle batch? List the trade-offs.', ...patch,
});

function view(patch: Partial<MultiModelRunView> = {}): MultiModelRunView {
  return {
    version: 1, phase: 'proposed', title: 'Memory extraction timing', askPreview: 'Per turn or idle batch? Also ask Codex and Gemini.',
    callerNodeId: 'mm-caller', callerMessageId: 'mm-answer', callerRuntimeId: 'claude', callerRuntimeLabel: 'Claude Code',
    callerModelLabel: 'Opus 5.5', permissionMode: 'ask', reviewRounds: 1,
    threads: [sol(), argon()], synthesis: { status: 'pending' }, ...patch,
  };
}

function mmRun(multiModel: MultiModelRunView, revision: number, patch: Partial<WorkflowRunDtoV1> = {}): WorkflowRunDtoV1 {
  return {
    version: 1, id: RUN_ID, runtime: 'michi', nativeId: 'mm_e2e', workspaceId: 'mm-ws', nodeId: 'mm-caller', parentToolCallId: null,
    name: multiModel.title, description: multiModel.askPreview, status: multiModel.phase === 'proposed' ? 'paused' : 'running',
    nodes: [], log: [], actions: multiModel.phase === 'proposed' ? ['resume', 'stop'] : ['stop'],
    startedAt: Date.now() - 60_000, updatedAt: Date.now(), revision, multiModel, ...patch,
  };
}

/** Codex's answer so far, in Markdown, longer than the drawer's excerpt box. */
const LIVE_TAIL = ['#### Where the turns go', '', ...Array.from({ length: 12 }, (_, index) => `- **Step ${index + 1}** writes a \`cursor\` per turn`), '', 'Newest line so far'].join('\n');

const proposed = () => mmRun(view(), 1);
const started = () => mmRun(view({
  phase: 'running', startedAt: Date.now() - 5_000,
  threads: [
    sol({ childNodeId: 'mm-c1', steps: [{ kind: 'answer', round: 0, status: 'running', startedAt: Date.now() - 5_000, now: 'Running rg -n extraction', excerpt: LIVE_TAIL }, { kind: 'review', round: 1, status: 'pending' }] }),
    argon({ childNodeId: 'mm-c2', steps: [{ kind: 'answer', round: 0, status: 'queued' }, { kind: 'review', round: 1, status: 'pending' }] }),
  ],
}), 2);
const awaitingApproval = () => mmRun(view({
  phase: 'running', startedAt: Date.now() - 9_000,
  threads: [
    sol({ childNodeId: 'mm-c1', steps: [{ kind: 'answer', round: 0, status: 'waiting', startedAt: Date.now() - 9_000 }, { kind: 'review', round: 1, status: 'pending' }] }),
    argon({ childNodeId: 'mm-c2', steps: [{ kind: 'answer', round: 0, status: 'completed', startedAt: Date.now() - 9_000, endedAt: Date.now() - 2_000, summary: 'Batch when idle: dedupe across turns.' }, { kind: 'review', round: 1, status: 'pending' }] }),
  ],
}), 3, {
  approvals: [{
    id: 't1:mm-x-t1-g0-s0-a1:7', nodeId: 't1@0', title: 'Approve Bash?', detail: 'rg -n "extraction" backend/src/services',
    options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' }],
    requestedAt: Date.now(),
  }],
});

const node = (id: string, title: string, patch: Record<string, unknown> = {}) => ({
  id, workspace_id: 'mm-ws', tree_id: 'mm-tree', kind: 'chat', title, runtime_id: 'claude', status: 'idle', created_at: 1, ...patch,
});

const workspace = {
  workspace: { id: 'mm-ws', name: 'Multi-model', active_tree_id: 'mm-tree', created_at: 1 },
  trees: [{ id: 'mm-tree', workspace_id: 'mm-ws', root_node_id: 'mm-caller', name: 'Memory extraction timing', created_at: 1, last_active_at: 1 }],
  nodes: [
    node('mm-caller', 'Memory extraction timing'),
    node('mm-c1', 'Codex · GPT-6.1 Sol', { runtime_id: 'codex', parent_node_id: 'mm-caller', spawned_by_agent: 1, multi_model_run_id: RUN_ID, created_at: 2 }),
    node('mm-c2', 'Pi · Gemini 4 Argon', { runtime_id: 'pi', parent_node_id: 'mm-caller', spawned_by_agent: 1, multi_model_run_id: RUN_ID, fresh_context: 1, created_at: 3 }),
  ],
  edges: [
    { id: 'branch-mm-caller-mm-c1', source_node_id: 'mm-caller', target_node_id: 'mm-c1', kind: 'branch', created_at: 2 },
    { id: 'branch-mm-caller-mm-c2', source_node_id: 'mm-caller', target_node_id: 'mm-c2', kind: 'branch', created_at: 3 },
  ],
  contexts: [],
  messages: [
    { id: 'mm-ask', node_id: 'mm-caller', role: 'user', seq: 1, content: 'Per turn or idle batch? Also ask Codex and Gemini.' },
    {
      id: 'mm-answer', node_id: 'mm-caller', role: 'assistant', seq: 2, content: 'Here is a plan: two models answer, review once, then I write the synthesis.',
      tool_calls: JSON.stringify([{
        id: 'toolu_mm', title: 'mcp____michi_internal____propose_multi_model_plan', status: 'completed', kind: 'tool',
        inputJson: JSON.stringify({ title: 'Memory extraction timing' }),
        output: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(proposal) }] }),
      }]),
      blocks: JSON.stringify([
        { id: 'b0', kind: 'tool', toolCallId: 'toolu_mm', section: 'answer', rawOffset: 0 },
        { id: 'b1', kind: 'answer', rawText: 'Here is a plan: two models answer, review once, then I write the synthesis.' },
      ]),
    },
    { id: 'mm-c1-q', node_id: 'mm-c1', role: 'user', seq: 1, content: 'Assess reliability and crash recovery.' },
    { id: 'mm-c2-q', node_id: 'mm-c2', role: 'user', seq: 1, content: 'Per turn or idle batch? List the trade-offs.' },
  ],
};

/** The run's endpoints over one mutable run; records what the card posts. */
async function openChat(page: Page) {
  let current = proposed();
  const posts: string[] = [];
  const answers: Array<{ approvalId: string; optionId: string }> = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const custom = async (route: Route): Promise<boolean> => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api/, '');
    const method = route.request().method();
    if (method === 'GET' && path === '/workflow-runs/subscribe') {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: `event: workflow_run\ndata: ${JSON.stringify({ version: 1, event: 'workflow_run', run: current, emittedAt: Date.now() })}\n\n`,
      });
      return true;
    }
    if (method === 'GET' && path === `/workflow-runs/${RUN_ID}`) { await route.fulfill({ json: { run: current } }); return true; }
    if (path === '/workflow-runs') { await route.fulfill({ json: { runs: [current] } }); return true; }
    if (method === 'POST' && path === `/multi-model-runs/${RUN_ID}/start`) {
      posts.push('start');
      current = started();
      await route.fulfill({ json: { run: current } });
      return true;
    }
    const answer = method === 'POST' ? path.match(new RegExp(`^/workflow-runs/${RUN_ID}/approvals/([^/]+)$`)) : null;
    if (answer) {
      const { optionId } = route.request().postDataJSON() as { optionId: string };
      answers.push({ approvalId: decodeURIComponent(answer[1]), optionId });
      current = { ...started(), revision: current.revision + 1 };
      await route.fulfill({ json: { run: current } });
      return true;
    }
    if (path === '/agent-runs') { await route.fulfill({ json: { runs: [] } }); return true; }
    if (path === '/agent-runs/subscribe') { await route.fulfill({ contentType: 'text/event-stream', body: ': keepalive\n\n' }); return true; }
    return false;
  };
  await installMockApi(page, { workspaces: [workspace], custom });
  await page.addInitScript(() => localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false })));
  await page.goto('/');
  await openThreadFromSidebar(page, 'Memory extraction timing');
  const message = page.locator('[data-msg-id="mm-answer"]');
  await expect(message).toBeVisible();
  return { message, posts, answers, errors, push: (run: WorkflowRunDtoV1) => { current = run; } };
}

test('the plan card starts the run and turns into progress; a branch approval is answered on its row', async ({ page }, info) => {
  const { message, posts, answers, errors, push } = await openChat(page);
  const card = message.getByTestId('multi-model-card');
  await expect(card).toHaveAttribute('data-phase', 'proposed');
  await expect(card).toContainText('Needs you');
  await expect(card.getByTestId('mm-plan-row')).toHaveCount(2);
  await expect(card.getByRole('button', { name: 'Fresh' })).toHaveAttribute('title', 'Fresh: only the prompt the agent wrote');
  // A plan waiting for Start is not background work: no badge, no top bar count.
  await expect(page.getByTestId('pane-background-work-badge')).toHaveCount(0);
  await expect(page.getByTestId('topbar-background-work')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('plan-card.png'), animations: 'disabled' });

  await card.getByRole('button', { name: 'Start 2 branches' }).click();
  await expect.poll(() => posts).toEqual(['start']);
  // The answered run morphs the card in place.
  await expect(card).toHaveAttribute('data-phase', 'running');
  await expect(card.getByTestId('mm-chip')).toContainText('Running');
  await expect(message.getByTestId('mm-started')).toContainText('Started the plan · 2 branches');
  await expect(card.getByTestId('mm-row').first()).toContainText('Running rg -n extraction');

  // A pushed frame: Codex waits on an approval; Pi answered.
  push(awaitingApproval());
  const approval = card.getByRole('group', { name: 'Approval needed: Approve Bash?' });
  await expect(approval).toBeVisible({ timeout: 10_000 });
  await expect(approval).toContainText('Run');
  await expect(card.getByTestId('mm-row').nth(1)).toContainText('Batch when idle: dedupe across turns.');
  // The pane's badge turns amber while the approval waits.
  const badge = page.getByTestId('pane-background-work-badge');
  await expect(badge).toHaveAttribute('data-state', 'waiting');
  await expect(badge).toContainText('1 · needs you');
  await page.screenshot({ path: info.outputPath('progress-card.png'), animations: 'disabled' });
  await approval.getByRole('button', { name: 'Allow once' }).click();
  await expect.poll(() => answers).toEqual([{ approvalId: 't1:mm-x-t1-g0-s0-a1:7', optionId: 'allow_once' }]);
  await expect(approval).toHaveCount(0);
  await expect(badge).toHaveAttribute('data-state', 'running');
  expect(errors).toEqual([]);
});

test('a row opens the Background work drawer, and Side by side opens the branches next to the chat', async ({ page }) => {
  const { message, errors, push } = await openChat(page);
  push(started());
  const card = message.getByTestId('multi-model-card');
  await expect(card).toHaveAttribute('data-phase', 'running', { timeout: 10_000 });

  await card.getByTestId('mm-row').first().click();
  const drawer = page.getByRole('dialog', { name: 'Background work' });
  await expect(drawer).toBeVisible();
  // The drawer opens on the run's card, with the clicked row expanded.
  const drawerCard = drawer.locator(`[data-background-work-key][data-run-key*="${RUN_ID}"]`);
  await expect(drawerCard).toHaveCount(1);
  await expect(drawerCard.locator('[data-testid="multi-model-row"][data-thread-key="t1"][data-step="0"] > button')).toHaveAttribute('aria-expanded', 'true');
  await expect(drawerCard.locator('[data-testid="multi-model-row"][data-thread-key="t2"][data-step="0"] > button')).toHaveAttribute('aria-expanded', 'false');
  // The live tail renders its Markdown in a short box that keeps the newest lines, fading out at the top.
  const excerpt = drawerCard.getByTestId('multi-model-excerpt');
  await expect(excerpt.getByRole('heading', { name: 'Where the turns go' })).toHaveCount(1);
  await expect(excerpt).not.toContainText('####');
  await expect(excerpt.locator('strong').first()).toHaveText('Step 1');
  const body = excerpt.getByTestId('multi-model-excerpt-body');
  await expect(body).toHaveAttribute('data-clipped', 'true');
  const [box, newest] = await Promise.all([body.boundingBox(), excerpt.getByText('Newest line so far').boundingBox()]);
  expect(box!.height).toBeLessThanOrEqual(168);
  expect(newest!.y + newest!.height).toBeLessThanOrEqual(box!.y + box!.height + 1);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  await card.getByRole('button', { name: 'Side by side' }).click();
  const panes = page.locator('.terminal-pane[data-node-id]');
  await expect(panes).toHaveCount(3);
  expect(await panes.evaluateAll((els) => els.map((el) => el.getAttribute('data-node-id')))).toEqual(['mm-caller', 'mm-c1', 'mm-c2']);
  const c2Banner = page.locator('.terminal-pane[data-node-id="mm-c2"]').getByTestId('pane-spawn-banner');
  await expect(c2Banner).toHaveText('⎇multi-model branch · fresh context, prompt onlyOpen plan');
  await expect(page.locator('.terminal-pane[data-node-id="mm-c1"]').getByTestId('pane-spawn-banner')).toHaveText('⎇multi-model branch · inherits Memory extraction timingOpen plan');

  // A branch leads back to its plan: the caller's drawer opens on that branch's row.
  await c2Banner.getByRole('button', { name: 'Open plan' }).click();
  await expect(drawer).toBeVisible();
  await expect(drawerCard.locator('[data-testid="multi-model-row"][data-thread-key="t2"][data-step="0"] > button')).toHaveAttribute('aria-expanded', 'true');
  expect(errors).toEqual([]);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 400, height: 800 }, hasTouch: true, isMobile: true });

  test('the Fork/Fresh underline stays on the word, and Side by side shows the first branch', async ({ page }, info) => {
    const { message, errors, push } = await openChat(page);
    const card = message.getByTestId('multi-model-card');
    // The tag's 40px touch hit area must not carry its dotted underline away from the word.
    const tag = card.getByRole('button', { name: 'Fresh' });
    expect(await tag.evaluate((el) => {
      const style = getComputedStyle(el);
      return [style.borderBottomStyle, style.textDecorationLine, style.textDecorationStyle, style.minHeight];
    })).toEqual(['none', 'underline', 'dotted', '40px']);
    push(started());
    await expect(card).toHaveAttribute('data-phase', 'running', { timeout: 10_000 });
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('phone-progress-card.png'), animations: 'disabled' });
    await card.getByRole('button', { name: 'Side by side' }).click();
    await expect(page.locator('.mobile-pane-title')).toHaveText('Codex · GPT-6.1 Sol');
    expect(errors).toEqual([]);
  });

  test('the drawer fills the screen, and its Side by side closes it on the first branch', async ({ page }) => {
    const { message, errors, push } = await openChat(page);
    const card = message.getByTestId('multi-model-card');
    push(started());
    await expect(card).toHaveAttribute('data-phase', 'running', { timeout: 10_000 });
    await card.getByTestId('mm-row').first().click();
    const drawer = page.getByRole('dialog', { name: 'Background work' });
    await expect(drawer).toBeVisible();
    const box = await drawer.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(398);
    expect(box?.height).toBeGreaterThanOrEqual(790);
    await drawer.getByRole('button', { name: 'Side by side' }).click();
    await expect(drawer).toBeHidden();
    await expect(page.locator('.mobile-pane-title')).toHaveText('Codex · GPT-6.1 Sol');
    await expect(page.locator('.terminal-pane[data-node-id="mm-c1"]')).toBeVisible();
    expect(errors).toEqual([]);
  });
});
