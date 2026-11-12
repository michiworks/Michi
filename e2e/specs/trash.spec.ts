import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { openSettings, settingsMain } from '../fixtures/shell';

const day = 86_400_000;
const previewTitle = 'Compare DeepSeek models';

/** Trash and Archived with a few of each kind of item, opened in Settings at `section`. */
async function bootHistory(page: Page, { palette = 'bone', section = 'Trash' as 'Trash' | 'Archived' } = {}) {
  const now = Date.now();
  const node = (id: string, title: string, age?: number, extra: Record<string, unknown> = {}) => ({
    id, title, kind: 'chat', created_at: now - 40 * day, message_count: 4,
    ...(age === undefined ? {} : { deleted_at: now - age * day, deletion_group_id: `del-${id}` }),
    ...extra,
  });
  const workspace = (id: string, name: string, nodes: ReturnType<typeof node>[], age?: number, extraTrees: Record<string, unknown>[] = []) => ({
    workspace: { id, name, cwd: `/mock/${name}`, created_at: now - 40 * day,
      active_tree_id: nodes.length ? `${id}-tree` : null,
      ...(age === undefined ? {} : { deleted_at: now - age * day }),
    },
    // Like the backend's rows, each node names its thread.
    nodes: nodes.map(item => ({ tree_id: extraTrees.find(tree => tree.root_node_id === item.id)?.id ?? `${id}-tree`, ...item })),
    trees: [...(nodes.length ? [{ id: `${id}-tree`, root_node_id: nodes[0].id, created_at: now, last_active_at: now }] : []), ...extraTrees],
    edges: [], contexts: [], messages: [],
  });
  const workspaces = [
    workspace('michi-ws', 'michi', [
      node('live', 'Active conversation'),
      node('models', previewTitle, 0.001, { message_count: 2 }),
      node('child', 'Model benchmarks', 0.001, { parent_node_id: 'models', deletion_group_id: 'del-models', message_count: 6 }),
      node('notes', 'Michi implementation notes', 1),
      node('archive', 'Archived conversation', 3, { parent_node_id: 'live', deletion_group_id: 'arch-hidden', trim_snapshot: { parentId: 'live', childrenIds: [], wasTreeRoot: null } }),
      node('old-plan', 'Old canvas plan'),
    ], undefined, [{ id: 'old-plan-tree', root_node_id: 'old-plan', name: 'Old canvas plan', created_at: now - 30 * day, last_active_at: now - 30 * day, archived_at: now - 20 * day }]),
    workspace('design-ws', 'designlab', [node('design-root', 'Design notes'), node('review', 'Review streaming architecture', 28)]),
    workspace('empty-ws', 'TestCloud2', [], 8),
    workspace('research-ws', 'Research', [node('research-live', 'Research plan'), node('research-trash', 'Research draft', 2)], 3),
  ];
  const calls = { previews: 0, purges: [] as string[][], empties: [] as string[], workspaces: [] as string[], failPurge: false };
  await installMockApi(page, { workspaces, custom: async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === '/api/prefs' && method === 'GET') {
      await route.fulfill({ json: { prefs: { onboardingCompletedAt: 1, terminalPalette: palette, uiFont: 'Geist', trashTTLDays: 30 } } });
      return true;
    }
    if (path === '/api/agent-runs') {
      await route.fulfill({ json: { runs: [] } });
      return true;
    }
    if (path === '/api/agent-runs/subscribe') {
      await route.fulfill({ contentType: 'text/event-stream', body: ': keepalive\n\n' });
      return true;
    }
    if (path.endsWith('/messages') && method === 'GET') {
      // The preview reads one page of the trashed node, not the workspace's bodies.
      if (new URL(route.request().url()).searchParams.get('nodeId') === 'models') {
        calls.previews++;
        await route.fulfill({ json: {
          messages: [{ id: 'question', node_id: 'models', seq: 0, role: 'user', content: 'Compare the models for coding and reasoning.' },
            { id: 'answer', node_id: 'models', seq: 1, role: 'assistant', content: 'Start with a reproducible evaluation of tool use, latency, and code quality.' }],
          pages: [{ nodeId: 'models', total: 2, before: null }],
          turns: [],
        } });
        return true;
      }
      await route.fulfill({ json: { messages: [] } });
      return true;
    }
    const match = path.match(/^\/api\/workspaces\/([^/]+)$/);
    if (match && match[1] !== 'all' && method === 'GET') {
      // Structure only (?meta=1): message counts, no bodies.
      await route.fulfill({ json: workspaces.find(item => item.workspace.id === match[1])! });
      return true;
    }
    if (path.endsWith('/nodes') && method === 'DELETE') {
      calls.purges.push(route.request().postDataJSON().nodeIds);
      await route.fulfill({ status: calls.failPurge ? 503 : 200, json: calls.failPurge ? { error: 'Unavailable' } : { ok: true, purged: 1 } });
      return true;
    }
    if (path.endsWith('/trash/empty')) {
      calls.empties.push(path);
      await route.fulfill({ json: { ok: true, purged: 1 } });
      return true;
    }
    if (match && method === 'DELETE') calls.workspaces.push(match[1]);
    return false;
  } });
  await page.addInitScript(() => localStorage.setItem('michi:migrated', '1'));
  await page.goto('/');
  await expect(page.locator('.t-sidebar-toggle').or(page.getByRole('button', { name: 'Open sidebar', exact: true })).first()).toBeVisible();
  const settings = await openSettings(page, section);
  await expect(settings.locator('.settings-history__row').first()).toBeVisible();
  await page.mouse.move(0, 0);
  return { calls, settings };
}

test('Trash in Settings groups by time, searches, previews lazy messages in the page, and restores', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 960 });
  const { calls, settings } = await bootHistory(page);
  const rows = settings.locator('.settings-history__row');
  await expect(rows).toHaveCount(5);
  await expect(settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Trash', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(settings.locator('[data-history-key="thread:del-models"] .settings-history__meta')).toContainText('8 messages');
  await expect(settings.getByText('Archived conversation')).toHaveCount(0);
  await expect(settings.locator('[data-history-key="thread:del-review"] .settings-history__when')).toHaveText('2 days left');
  await expect(settings.getByText('1 thread will be deleted automatically within 3 days.')).toBeVisible();
  await page.screenshot({ path: info.outputPath('trash-desktop.png') });

  const search = settings.getByRole('searchbox', { name: 'Search Trash' });
  await search.fill('DeepSeek');
  await expect(settings.locator('.settings-history__row mark')).toHaveText('DeepSeek');
  await expect(rows).toHaveCount(1);
  await search.fill('no matching title');
  await expect(settings.getByRole('heading', { name: 'No matching items' })).toBeVisible();
  await search.fill('');
  await settings.getByRole('combobox', { name: 'Sort deleted items' }).selectOption('oldest');
  await expect(rows.first()).toHaveAttribute('data-history-key', 'thread:del-review');
  await settings.getByRole('combobox', { name: 'Sort deleted items' }).selectOption('newest');

  const trigger = settings.getByRole('button', { name: previewTitle, exact: true });
  await trigger.click();
  await expect(settings.getByRole('heading', { level: 2, name: previewTitle })).toBeFocused();
  await expect(settings.getByText('Start with a reproducible evaluation of tool use, latency, and code quality.')).toBeVisible();
  expect(calls.previews).toBe(1);
  await expect(settings.getByText('Read only', { exact: true })).toBeVisible();
  await expect(settings.locator('[contenteditable]')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect.poll(() => settings.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length)).toBe(0);
  const content = (await settings.locator('.terminal-settings-content').boundingBox())!;
  const actions = (await settings.locator('.settings-history__detail-actions').boundingBox())!;
  expect(actions.y + actions.height).toBeLessThanOrEqual(content.y + content.height + 1);
  await page.screenshot({ path: info.outputPath('trash-preview.png') });
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await settings.getByRole('button', { name: `Restore ${previewTitle}`, exact: true }).click();
  await expect(rows).toHaveCount(4);
  await expect(page.getByText('Thread restored', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Trash confirms destructive actions, preserves failed rows, and empties all workspaces', async ({ page }, info) => {
  const { calls, settings } = await bootHistory(page);
  const rows = settings.locator('.settings-history__row');
  const row = settings.locator('[data-history-key="thread:del-notes"]');
  const menuTrigger = settings.getByRole('button', { name: 'More actions for Michi implementation notes' });
  await row.hover();
  await menuTrigger.click();
  await expect(page.getByRole('menuitem', { name: 'Preview', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: 'Delete permanently?' }).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(menuTrigger).toBeFocused();
  expect(calls.purges).toHaveLength(0);

  calls.failPurge = true;
  await menuTrigger.click();
  await page.getByRole('menuitem', { name: 'Delete permanently...' }).click();
  await page.getByRole('dialog', { name: 'Delete permanently?' }).getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(settings.getByRole('alert')).toContainText('Could not delete this item');
  await expect(settings.getByRole('button', { name: 'Michi implementation notes', exact: true })).toBeVisible();
  await expect(menuTrigger).toBeFocused();
  expect(calls.purges).toEqual([['notes']]);

  calls.failPurge = false;
  await menuTrigger.click();
  await page.getByRole('menuitem', { name: 'Delete permanently...' }).click();
  await page.getByRole('dialog', { name: 'Delete permanently?' }).getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(rows).toHaveCount(4);

  // Two at once: one confirmation, then both go.
  await settings.getByRole('checkbox', { name: `Select ${previewTitle}` }).check();
  await settings.getByRole('checkbox', { name: 'Select Review streaming architecture' }).check();
  await expect(settings.getByText('2 selected')).toBeVisible();
  await page.screenshot({ path: info.outputPath('trash-selection.png') });
  await settings.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await expect(page.getByText('2 items restored', { exact: true })).toBeVisible();

  await settings.getByRole('button', { name: 'Empty Trash…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Empty Trash?' }).getByRole('button', { name: 'Empty Trash', exact: true }).click();
  await expect(settings.getByRole('heading', { name: 'Trash is empty' })).toBeVisible();
  // The empty state renders from local state; the workspace DELETEs may still be in flight.
  await expect.poll(() => calls.workspaces).toEqual(['empty-ws', 'research-ws']);
  await page.screenshot({ path: info.outputPath('trash-empty.png') });
});

test('Archived in Settings unarchives, and Move to Trash hands a thread to Trash with Undo', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const { settings } = await bootHistory(page, { section: 'Archived' });
  const nav = settings.getByRole('navigation', { name: 'Settings sections' });
  const rows = settings.locator('.settings-history__row');
  await expect(rows).toHaveCount(2);
  await expect(settings.getByRole('heading', { level: 3 })).toHaveText(['Mmichi 2']);
  await expect(settings.getByText('Node from “Active conversation”')).toBeVisible();
  await page.screenshot({ path: info.outputPath('archived-desktop.png') });

  await settings.locator('[data-history-key="tree:old-plan-tree"]').hover();
  await settings.getByRole('button', { name: 'More actions for Old canvas plan' }).click();
  await page.getByRole('menuitem', { name: 'Move to Trash' }).click();
  await expect(rows).toHaveCount(1);
  await expect(nav.getByRole('button', { name: 'Trash', exact: true })).toContainText('6');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await expect(nav.getByRole('button', { name: 'Trash', exact: true })).toContainText('5');

  await settings.locator('[data-history-key="node:arch-hidden"]').hover();
  await settings.getByRole('button', { name: 'Unarchive Archived conversation', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(page.getByText('Node unarchived', { exact: true })).toBeVisible();
});

test('Trash respects dark theme and keeps a narrow window free of sideways scrolling', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const { settings } = await bootHistory(page, { palette: 'monokai' });
  await expect(page.locator('html')).toHaveAttribute('data-terminal-palette', 'monokai');
  await page.screenshot({ path: info.outputPath('trash-dark.png') });
  await page.setViewportSize({ width: 940, height: 820 });
  const content = settings.locator('.terminal-settings-content');
  expect(await content.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('trash-narrow.png') });
});

test.describe('Touch Trash', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('opens items as a level of the drawer, selects with Select, and keeps targets finger-sized', async ({ page }, info) => {
    const { settings } = await bootHistory(page);
    const drawer = page.getByRole('dialog', { name: 'Settings', exact: true });
    const rows = settings.locator('.settings-history__row');
    const content = settings.locator('.terminal-settings-content');
    expect(await content.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    // The whole row is the item's tap target.
    const row = settings.locator('[data-history-key="thread:del-models"]');
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await row.evaluate(element => {
      const box = element.getBoundingClientRect();
      return document.elementFromPoint(box.right - 30, box.top + box.height / 2)?.closest('[data-history-open]') !== null;
    })).toBe(true);
    await expect(settings.getByRole('button', { name: `Restore ${previewTitle}` })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('trash-mobile.png') });

    await settings.getByRole('button', { name: 'Research', exact: true }).tap();
    await expect(settings.getByRole('heading', { level: 2, name: 'Research' })).toBeVisible();
    await settings.getByRole('button', { name: 'Research draft', exact: true }).tap();
    await expect(settings.getByRole('heading', { level: 2, name: 'Research draft' })).toBeVisible();
    const restore = settings.getByRole('button', { name: 'Restore thread', exact: true });
    expect((await restore.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(restore).toBeInViewport();
    await page.screenshot({ path: info.outputPath('trash-mobile-preview.png') });
    // The header Back closes the item before it leaves Trash.
    await drawer.locator('.ui-overlay-header').getByRole('button', { name: 'Back', exact: true }).tap();
    await expect(settings.getByRole('searchbox', { name: 'Search Trash' })).toBeVisible();
    await expect(settings.getByRole('heading', { level: 1, name: 'Trash' })).toBeVisible();

    await settings.getByRole('button', { name: 'Select', exact: true }).tap();
    await settings.getByRole('button', { name: previewTitle, exact: true }).tap();
    await settings.getByRole('button', { name: 'Michi implementation notes', exact: true }).tap();
    await expect(settings.getByText('2 selected')).toBeVisible();
    await page.screenshot({ path: info.outputPath('trash-mobile-select.png') });
    await settings.getByRole('button', { name: 'Restore', exact: true }).tap();
    await expect(rows).toHaveCount(3);
    await expect(page.getByText('2 items restored', { exact: true })).toBeVisible();
  });
});
