import { test, expect, type Browser, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

/**
 * The line chrome's rhythm in a real layout (jsdom has none): a run is set a
 * size below the prose and sits 16px from it on either side, its rows are
 * 28px (36px, 32px for a step, on touch), and an opened run shows twelve step
 * rows under its words (six on a phone), scrolling the rest, with the hidden
 * edge faded. The
 * turn is finished, so its work sits in a Work fold above the final answer:
 * one such row, opening to the same rhythm in the fold's quieter colour.
 */

const NODE = 'rhythm-node';
const A1 = 'Reading the drawer first.';
const A2 = ' Now the edit.';
const A3 = ' The drawer lists every conversation now.';

const reads = Array.from({ length: 20 }, (_, i) => ({
  id: `r${i}`, title: 'Read', kind: 'read', status: 'completed',
  inputJson: JSON.stringify({ file_path: `frontend/src/f${i}.ts` }), startedAt: 1_000 + i * 100, endedAt: 1_050 + i * 100,
}));
const edit = {
  id: 'e1', title: 'Edit', kind: 'edit', status: 'completed',
  inputJson: JSON.stringify({ file_path: 'frontend/src/drawer.tsx', old_string: 'a', new_string: 'b' }), startedAt: 3_000, endedAt: 3_400,
};

const workspace = {
  workspace: { id: 'rhythm-ws', name: 'Rhythm', active_tree_id: 'rhythm-tree', created_at: 1 },
  trees: [{ id: 'rhythm-tree', workspace_id: 'rhythm-ws', root_node_id: NODE, name: 'Drawer', created_at: 1, last_active_at: 1 }],
  nodes: [{ id: NODE, workspace_id: 'rhythm-ws', tree_id: 'rhythm-tree', kind: 'chat', title: 'Drawer', runtime_id: 'claude', status: 'idle', created_at: 1 }],
  edges: [], contexts: [],
  messages: [
    { id: 'ask', node_id: NODE, role: 'user', seq: 1, content: 'Show every conversation in the drawer.' },
    {
      id: 'answer', node_id: NODE, role: 'assistant', seq: 2, content: A1 + A2 + A3,
      tool_calls: JSON.stringify([...reads, edit]),
      blocks: JSON.stringify([
        { id: 'a1', kind: 'answer', rawText: A1 },
        ...reads.map((t) => ({ id: `b-${t.id}`, kind: 'tool', toolCallId: t.id, section: 'answer', rawOffset: A1.length })),
        { id: 'a2', kind: 'answer', rawText: A2 },
        { id: 'b-e1', kind: 'tool', toolCallId: 'e1', section: 'answer', rawOffset: A1.length + A2.length },
        { id: 'a3', kind: 'answer', rawText: A3 },
      ]),
    },
  ],
};

async function openChat(page: Page, { phone = false } = {}) {
  await installMockApi(page, { workspaces: [workspace] });
  await page.addInitScript((phone) => localStorage.setItem('michi:v1:prefs', JSON.stringify({
    onboardingCompletedAt: 1, sidebarCollapsed: phone, reduceMotion: true, agentBlockStyle: 'line',
  })), phone);
  await page.goto('/');
  if (phone) await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
  await page.locator(`.terminal-sidebar [data-sidebar-row="${NODE}"]`).click();
  const message = page.locator('[data-msg-id="answer"]');
  await expect(message.getByRole('button', { name: /Worked for/ })).toHaveAttribute('aria-expanded', 'false');
  await expect(message.getByText(A1.trim())).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  return message;
}

/** The folded row: its height and its gap to the final answer under it. */
function measureFold(page: Page) {
  return page.locator('[data-msg-id="answer"]').evaluate((message) => {
    const fold = message.querySelector('.agent-line-workfold')!;
    const final = [...message.querySelectorAll('.prose p')].pop()!;
    const row = fold.querySelector('button.agent-line')!.getBoundingClientRect();
    return { rowHeight: Math.round(row.height), below: Math.round(final.getBoundingClientRect().top - fold.getBoundingClientRect().bottom) };
  });
}

async function openWork(page: Page) {
  const message = page.locator('[data-msg-id="answer"]');
  await message.getByRole('button', { name: /Worked for/ }).click();
  await expect(message.locator('.agent-line-workfold__work .agent-line-group')).toHaveCount(2);
}

/** Inside the opened fold: gaps from each run to the prose around it, row metrics and colours. */
function measure(page: Page) {
  return page.locator('[data-msg-id="answer"]').evaluate((message) => {
    const work = message.querySelector('.agent-line-workfold__work')!;
    const paragraphs = [...work.querySelectorAll('.prose p')];
    const box = (el: Element) => el.getBoundingClientRect();
    const runs = [...work.querySelectorAll('.agent-line-group')].map((group) => {
      const before = paragraphs.filter((p) => p.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).pop()!;
      const after = paragraphs.find((p) => p.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_PRECEDING);
      return { above: Math.round(box(group).top - box(before).bottom), below: after ? Math.round(box(after).top - box(group).bottom) : null };
    });
    const header = work.querySelector('.agent-line-group button.agent-line')!;
    const probe = document.createElement('span');
    probe.style.color = 'var(--term-mid)';
    message.appendChild(probe);
    const colors = { mid: getComputedStyle(probe).color };
    probe.remove();
    const final = [...message.querySelectorAll('.prose p')].pop()!;
    return {
      runs,
      rowHeight: Math.round(box(header).height),
      rowFont: getComputedStyle(header).fontSize,
      proseFont: getComputedStyle(paragraphs[0]).fontSize,
      noteColor: getComputedStyle(paragraphs[0]).color,
      finalColor: getComputedStyle(final).color,
      colors,
      coarse: matchMedia('(pointer: coarse)').matches,
    };
  });
}

async function openSteps(page: Page) {
  const message = page.locator('[data-msg-id="answer"]');
  await message.locator('.agent-line-group button[data-toolgroup-header]').first().click();
  const area = message.locator('.agent-line-stepbox > .agent-line-steps-scroll');
  await expect(area).toHaveAttribute('data-more', 'down');
  return area.evaluate((el) => {
    const rows = [...el.querySelectorAll('button.agent-line--step')];
    const header = el.closest('.agent-line-run')!.querySelector(':scope > button.agent-line')!.getBoundingClientRect();
    return {
      height: Math.round(el.clientHeight),
      overflows: el.scrollHeight > el.clientHeight,
      steps: rows.length,
      stepHeight: Math.round(rows[0].getBoundingClientRect().height),
      // Steps start under the header's words, not under its icon.
      indent: Math.round(rows[0].querySelector('.agent-line__txt')!.getBoundingClientRect().left - header.left),
      headerText: Math.round(el.closest('.agent-line-run')!.querySelector(':scope > button.agent-line .agent-line__txt')!.getBoundingClientRect().left - header.left),
      role: el.getAttribute('role'),
    };
  });
}

test('a run sits 16px from the prose, a size below it, and opens to twelve step rows that scroll', async ({ page }) => {
  await openChat(page);
  expect(await measureFold(page)).toEqual({ rowHeight: 28, below: 16 });
  await openWork(page);
  const m = await measure(page);
  expect(m.runs).toEqual([{ above: 16, below: 16 }, { above: 16, below: null }]);
  // The folded prose is a step quieter than the final answer below it.
  expect(m.noteColor).toBe(m.colors.mid);
  expect(m.noteColor).not.toBe(m.finalColor);
  expect(m.rowHeight).toBe(28);
  expect(m.rowFont).toBe('13px');
  expect(parseFloat(m.proseFont)).toBeGreaterThan(13);

  const area = await openSteps(page);
  expect(area).toMatchObject({ steps: 20, stepHeight: 28, height: 12 * 28 + 4, overflows: true, role: 'region' });
  expect(area.indent).toBe(area.headerText + 24);

  // Opening the last visible step's payload keeps the run's height; the list
  // scrolls until the payload shows.
  const steps = page.locator('[data-msg-id="answer"] .agent-line-stepbox > .agent-line-steps-scroll');
  await steps.locator('button.agent-line--step').nth(11).click();
  await expect(steps.locator('.agent-line-body:not([hidden])')).toHaveCount(1);
  await expect.poll(() => steps.evaluate((el) => {
    const view = el.getBoundingClientRect();
    const body = el.querySelector('.agent-line-body:not([hidden])')!.getBoundingClientRect();
    return { height: Math.round(el.clientHeight), shown: body.bottom <= view.bottom + 1 };
  })).toEqual({ height: 12 * 28 + 4, shown: true });
});

async function phone(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  return { context, page: await context.newPage() };
}

test('on a phone, rows are 36px and steps 32px, and the step area shows six', async ({ browser, baseURL }) => {
  const { context, page } = await phone(browser, baseURL);
  try {
    await openChat(page, { phone: true });
    await openWork(page);
    const m = await measure(page);
    test.skip(!m.coarse, 'this browser does not report a coarse pointer under touch emulation');
    expect(m.rowHeight).toBe(36);
    expect(m.runs).toEqual([{ above: 16, below: 16 }, { above: 16, below: null }]);
    const area = await openSteps(page);
    expect(area).toMatchObject({ stepHeight: 32, height: 6 * 32 + 4, overflows: true });
  } finally {
    await context.close();
  }
});
