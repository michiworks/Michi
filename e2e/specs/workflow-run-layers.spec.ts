import { test, expect, type Route } from '@playwright/test';
import type { WorkflowRunDtoV1 } from '../../shared/src';
import { installMockApi } from '../fixtures/mockApi';
import { openThreadFromSidebar } from '../fixtures/shell';

/**
 * Finished workflow runs arrive on the stream as summaries (`partial`): the
 * Background work drawer mounts the cards of its first screen, reads a
 * summary card's run whole once the card is on screen, and mounts the cards
 * further down as they scroll into view.
 */

const COUNT = 12;
const calls = Array.from({ length: COUNT }, (_, i) => `toolu_wf${i}`);

function whole(i: number): WorkflowRunDtoV1 {
  return {
    version: 1, id: `wfr_${i}`, runtime: 'claude', nativeId: `wf${i}`, workspaceId: 'layers-ws', nodeId: 'layers-node', parentToolCallId: calls[i],
    name: `audit-${i}`, description: `Audit slice ${i}`, status: 'completed', nodes: [], log: [], actions: [],
    result: JSON.stringify({ findings: [{ id: `F${i}`, title: `WHOLE_${i}`, severity: 'high' }] }),
    startedAt: 1_000 + i, updatedAt: 2_000 + i, endedAt: 2_000 + i, revision: 2,
  };
}
const summary = (i: number): WorkflowRunDtoV1 => ({ ...whole(i), partial: true, result: '{"findings":["… 1 more"]}' });

const workspace = {
  workspace: { id: 'layers-ws', name: 'Layers', active_tree_id: 'layers-tree', created_at: 1 },
  trees: [{ id: 'layers-tree', workspace_id: 'layers-ws', root_node_id: 'layers-node', name: 'Audits', created_at: 1, last_active_at: 1 }],
  nodes: [{ id: 'layers-node', workspace_id: 'layers-ws', tree_id: 'layers-tree', kind: 'chat', title: 'Audits', runtime_id: 'claude', status: 'idle', created_at: 1 }],
  edges: [], contexts: [],
  messages: [
    { id: 'ask', node_id: 'layers-node', role: 'user', seq: 1, content: 'Audit every slice.' },
    {
      id: 'answer', node_id: 'layers-node', role: 'assistant', seq: 2, content: 'Audited.',
      tool_calls: JSON.stringify(calls.map((id) => ({ id, title: 'Workflow', status: 'completed', kind: 'tool' }))),
      blocks: JSON.stringify([
        ...calls.map((id, i) => ({ id: `b${i}`, kind: 'tool', toolCallId: id, section: 'answer', rawOffset: 0 })),
        { id: 'bz', kind: 'answer', rawText: 'Audited.' },
      ]),
    },
  ],
};

test('the drawer mounts its first screen, reads summaries whole on screen and mounts the rest on scroll', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const fetched: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const custom = async (route: Route): Promise<boolean> => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api/, '');
    if (path === '/workflow-runs/subscribe') {
      const body = calls.map((_, i) => `event: workflow_run\ndata: ${JSON.stringify({ version: 1, event: 'workflow_run', run: summary(i), emittedAt: Date.now() })}\n\n`).join('');
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body });
      return true;
    }
    const one = path.match(/^\/workflow-runs\/(wfr_\d+)$/);
    if (one) {
      fetched.push(one[1]);
      await route.fulfill({ json: { run: whole(Number(one[1].slice(4))) } });
      return true;
    }
    if (path === '/workflow-runs') { await route.fulfill({ json: { runs: calls.map((_, i) => summary(i)) } }); return true; }
    if (path === '/agent-runs') { await route.fulfill({ json: { runs: [] } }); return true; }
    if (path === '/agent-runs/subscribe') { await route.fulfill({ contentType: 'text/event-stream', body: ': keepalive\n\n' }); return true; }
    return false;
  };
  await installMockApi(page, { workspaces: [workspace], custom });
  await page.addInitScript(() => localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false })));
  await page.goto('/');
  await openThreadFromSidebar(page, 'Audits');

  // The drawer opened from the oldest run's line: its card is at the top.
  const message = page.locator('[data-msg-id="answer"]');
  await message.getByRole('button', { name: /^Workflows: / }).click();
  await message.getByRole('button', { name: 'Open workflow audit-0, completed' }).click();
  const drawer = page.getByRole('dialog', { name: 'Background work' });
  const cards = drawer.getByTestId('background-workflow-row');
  const placeholders = drawer.getByTestId('background-workflow-placeholder');
  await expect(cards.first()).toHaveAttribute('aria-label', 'Workflow audit-0, done');
  await expect(placeholders).toHaveCount(COUNT - 4);

  // The card on screen reads its run whole: the finding replaces the preview.
  await expect(cards.first().getByTestId('result-value')).toContainText('WHOLE_0');
  expect(fetched).toContain('wfr_0');
  expect(fetched).not.toContain(`wfr_${COUNT - 1}`);

  // Scrolling down mounts the rest, and each reads its run once on screen.
  const list = drawer.getByTestId('background-work-list');
  const atBottom = () => list.evaluate((element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 1);
  for (let step = 0; step < 30 && (await placeholders.count() > 0 || !await atBottom()); step += 1) {
    await list.evaluate((element) => element.scrollBy(0, element.clientHeight * 0.8));
    await page.waitForTimeout(50);
  }
  await expect(placeholders).toHaveCount(0);
  await expect(cards).toHaveCount(COUNT);
  await expect(cards.last().getByTestId('result-value')).toContainText(`WHOLE_${COUNT - 1}`);
  expect(new Set(fetched).size).toBeLessThanOrEqual(COUNT);
  expect(errors).toEqual([]);
});

test("a running run's progress arrives as patches against the run the feed sent, and its card follows", async ({ page }) => {
  const running: WorkflowRunDtoV1 = {
    ...whole(0), status: 'running', actions: ['stop'], endedAt: undefined, result: undefined,
    nodes: [{ id: 'agent:0', kind: 'agent', title: 'scan', status: 'running', currentTool: 'Read a.ts', prompt: 'p'.repeat(3_000) }],
  };
  const patch = { id: 'wfr_0', baseRevision: running.revision, revision: running.revision + 1, set: { updatedAt: 3_000 }, nodes: [{ id: 'agent:0', set: { currentTool: 'Edit b.ts' } }] };
  let subscribeUrl = '';
  const fetched: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const one = {
    ...workspace,
    messages: [workspace.messages[0], {
      ...workspace.messages[1],
      tool_calls: JSON.stringify([{ id: calls[0], title: 'Workflow', status: 'completed', kind: 'tool' }]),
      blocks: JSON.stringify([{ id: 'b0', kind: 'tool', toolCallId: calls[0], section: 'answer', rawOffset: 0 }, { id: 'bz', kind: 'answer', rawText: 'Audited.' }]),
    }],
  };
  await installMockApi(page, { workspaces: [one], custom: async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api/, '');
    if (path === '/workflow-runs/subscribe') {
      subscribeUrl = url.search;
      const frames = [
        { version: 1, event: 'workflow_run', run: running, emittedAt: 1 },
        { version: 1, event: 'workflow_run_patch', run: null, patch, emittedAt: 2 },
      ];
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: frames.map((frame) => `event: ${frame.event}\ndata: ${JSON.stringify(frame)}\n\n`).join('') });
      return true;
    }
    if (/^\/workflow-runs\/wfr_\d+$/.test(path)) { fetched.push(path); await route.fulfill({ json: { run: whole(0) } }); return true; }
    if (path === '/workflow-runs') { await route.fulfill({ json: { runs: [running] } }); return true; }
    if (path === '/agent-runs') { await route.fulfill({ json: { runs: [] } }); return true; }
    if (path === '/agent-runs/subscribe') { await route.fulfill({ contentType: 'text/event-stream', body: ': keepalive\n\n' }); return true; }
    return false;
  } });
  await page.addInitScript(() => localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false })));
  await page.goto('/');
  await openThreadFromSidebar(page, 'Audits');
  const card = page.locator('[data-msg-id="answer"]').getByTestId('workflow-run-card');
  await expect(card.getByTestId('workflow-now')).toContainText('Edit b.ts');
  expect(subscribeUrl).toContain('patches=1');
  // The patch fit the run the feed sent: nothing was read whole.
  expect(fetched).toEqual([]);
  expect(errors).toEqual([]);
});
