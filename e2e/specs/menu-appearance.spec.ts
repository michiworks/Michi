import { expect, test, type Locator, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { createPagesMockController, taskDatabaseFixture } from '../fixtures/pagesFixtures';
import { COMPOSER_EDITOR, leaveSettings, openArea, openSettings } from '../fixtures/shell';

async function bootMenus(page: Page, palette: 'bone' | 'monokai', extraPrefs: Record<string, unknown> = {}) {
  await installMockApi(page, { streamEvents: [
    { event: 'chunk', data: { text: 'Menu checks complete.' } },
    { event: 'usage_summary', data: { contextUsagePercentage: 62, totalCredits: 0, turnDurationMs: 20,
      totalTokens: 79500, inputTokens: 60000, outputTokens: 19500, cachedInputTokens: 12000 } },
    { event: 'done', data: { stopReason: 'end_turn' } },
  ], custom: async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api/, '');
    if (path === '/agent/status') {
      await route.fulfill({ json: {
        runtime: 'mock', label: 'Mock Runtime', hasRequiredKey: true, customAgentsEnabled: false,
        capabilities: { modes: true, models: false, reasoning: false, providerModels: false },
        availableRuntimes: [{ id: 'mock', label: 'Mock Runtime', available: true }],
      } });
      return true;
    }
    if (path.endsWith('/modes')) {
      await route.fulfill({ json: { availableModes: [
        { id: 'build', name: 'Build', description: 'Implement and validate changes' },
        { id: 'plan', name: 'Plan', description: 'Explore the next steps' },
      ] } });
      return true;
    }
    if (path === '/prefs' && route.request().method() === 'GET') {
      await route.fulfill({ json: { prefs: { onboardingCompletedAt: 1, terminalPalette: palette } } });
      return true;
    }
    return false;
  } });
  await page.addInitScript(({ terminalPalette, extraPrefs }) => {
    const ids = ['root', 'branch', 'branch2'];
    const extraWorkspaces = Array.from({ length: 9 }, (_, index) => ({
      id: `workspace-${index + 1}`, name: `Workspace ${index + 1}`,
      chatIds: [`workspace-root-${index + 1}`], edges: [], artifacts: [], createdAt: 1,
      trees: [{ id: `workspace-tree-${index + 1}`, rootNodeId: `workspace-root-${index + 1}`, createdAt: 1, lastActiveAt: 1 }],
      activeTreeId: `workspace-tree-${index + 1}`,
    }));
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:state', JSON.stringify({
      version: 6, activeProjectId: 'menu-ws',
      nodes: { ...Object.fromEntries(ids.map((nodeId) => [nodeId, {
        nodeId, kind: 'chat', chatId: null, projectId: 'menu-ws', title: `${nodeId} conversation`,
        status: 'idle', followUps: [], contextUsagePercentage: 62,
        usageSummary: { totalTokens: 79500, inputTokens: 60000, outputTokens: 19500, cachedInputTokens: 12000 },
        messages: [{ id: `${nodeId}-message`, role: 'user', text: 'Review the menu spacing and interactions.', toolCalls: [], createdAt: 1 }],
      }])), ...Object.fromEntries(extraWorkspaces.map((workspace) => [workspace.chatIds[0], {
        nodeId: workspace.chatIds[0], kind: 'chat', chatId: null, projectId: workspace.id,
        title: `${workspace.name} conversation`, status: 'idle', followUps: [], messages: [],
      }])) },
      projects: [{ id: 'menu-ws', name: 'Menu implementation', chatIds: ids,
        edges: ['branch', 'branch2'].map((target) => ({ source: 'root', target, kind: 'branch' })),
        trees: [{ id: 'tree', rootNodeId: 'root', name: 'root conversation', createdAt: 1, lastActiveAt: 1 }],
        activeTreeId: 'tree', createdAt: 1,
        artifacts: Array.from({ length: 10 }, (_, index) => ({
          id: `notes-${index}`, name: index ? `Reference notes ${index}` : 'Design notes',
          filePath: `notes-${index}.md`, type: 'doc', source: 'user', createdAt: 1, updatedAt: 1,
        })),
      }, ...extraWorkspaces],
    }));
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ terminalPalette, sidebarView: 'structure', sidebarCollapsed: false,
      onboardingCompletedAt: 1, sidebarExpanded: { workspaces: { 'menu-ws': true }, threads: { tree: true }, branches: {} },
      ...extraPrefs,
    }));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'menu-ws::tree': ['root'] }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'menu-ws::tree': null }));
  }, { terminalPalette: palette, extraPrefs });
  await page.goto('/');
  await expect(page.locator(COMPOSER_EDITOR).first()).toBeVisible();
}

type Material = Awaited<ReturnType<typeof materialOf>>;

/** Every tuned menu shares the palette's glass except the solid right-click menu. */
async function assertSurface(menu: Locator, width: number, viewportWidth: number, paletteMaterial?: Material) {
  await expect(menu).toBeVisible();
  await expect(menu).toHaveCSS('border-radius', '4px');
  await expect(menu).toHaveCSS('font-size', '13px');
  await expect(menu).toHaveCSS('font-weight', '500');
  const isContext = await menu.getAttribute('data-menu') === 'context';
  if (isContext) {
    await expect(menu).not.toHaveClass(/\bterm-glass\b/);
    await expect(menu).toHaveCSS('backdrop-filter', 'none');
  } else {
    // The palette's overlay frost (blur, highlight, cast shadow).
    await expect(menu).toHaveClass(/\bterm-glass\b/);
    await expect(menu).toHaveCSS('backdrop-filter', 'blur(48px) saturate(1.1)');
    if (paletteMaterial) expect((await materialOf(menu)).boxShadow).toEqual(paletteMaterial.boxShadow);
  }
  await expect(menu).toHaveCSS('padding', '6px');
  await expect.poll(() => menu.evaluate((element) => element.getAnimations().filter((animation) => animation.playState === 'running').length)).toBe(0);
  const bounds = (await menu.boundingBox())!;
  expect(bounds.width).toBeLessThanOrEqual(width);
  expect(bounds.x).toBeGreaterThanOrEqual(8);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewportWidth - 8);
  expect(bounds.y).toBeGreaterThanOrEqual(8);
  await expect(menu.locator('h1, h2, h3')).toHaveCount(0);
}

async function materialOf(surface: Locator) {
  return surface.evaluate((element) => {
    const css = getComputedStyle(element);
    return { background: css.background, backdropFilter: css.backdropFilter, boxShadow: css.boxShadow };
  });
}

test('autocomplete stays within a narrow viewport and reduced motion skips the blink', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await bootMenus(page, 'bone');
  await page.getByTitle('Switch workspace', { exact: true }).click();
  await assertSurface(page.getByRole('menu', { name: 'Workspaces', exact: true }), 252, 1280);
  await page.keyboard.press('Escape');
  // The sidebar is responsive; navigate before collapsing it on small screens.
  await page.locator('.terminal-sidebar').getByText('root conversation', { exact: true }).first().click();
  await page.setViewportSize({ width: 390, height: 844 });
  const editor = page.locator(COMPOSER_EDITOR).first();
  for (const [query, name, width] of [['@', 'Mentions', 420], ['/', 'Slash commands', 480]] as const) {
    await editor.fill(query);
    const menu = page.getByRole('listbox', { name, exact: true });
    await assertSurface(menu, width, 390);
    await expect(menu).toHaveCSS('animation-name', 'none');
    await menu.screenshot({ path: info.outputPath(`${name.replaceAll(' ', '-')}-mobile.png`) });
    await page.screenshot({ path: info.outputPath(`${name.replaceAll(' ', '-')}-mobile-page.png`), fullPage: true });
    if (query === '@') {
      await menu.getByRole('option').first().click();
      await expect(editor.locator('.mention-chip')).toHaveCount(1);
    }
  }
});

test('glass menus keep the overlay frost whatever the sidebar glass, honour reduced transparency; right-click stays solid', async ({ page }, info) => {
  await bootMenus(page, 'monokai');
  await page.evaluate(() => {
    // The sidebar's glass knob. Overlays must not follow it.
    const style = document.documentElement.style;
    style.setProperty('--term-sidebar-solid-alpha', '.2');
  });
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const paletteMaterial = await materialOf(page.getByRole('dialog', { name: /Command palette/i }));
  await page.keyboard.press('Escape');
  await page.getByTitle('Switch workspace', { exact: true }).click();
  const workspace = page.getByRole('menu', { name: 'Workspaces', exact: true });
  await expect(workspace).toHaveCSS('backdrop-filter', 'blur(48px) saturate(1.1)');
  await expect.poll(() => workspace.evaluate((element) => element.getAnimations().filter((animation) => animation.playState === 'running').length)).toBe(0);
  // One overlay material: same surface, blur and edge cues as the palette.
  expect(await materialOf(workspace)).toEqual(paletteMaterial);
  await workspace.screenshot({ path: info.outputPath('custom-glass.png') });
  await page.keyboard.press('Escape');

  await page.locator('.terminal-sidebar').getByText('Menu implementation', { exact: true }).first().click({ button: 'right' });
  const context = page.getByRole('menu', { name: 'Actions', exact: true });
  await expect(context).toHaveCSS('backdrop-filter', 'none');
  const surface = await context.evaluate((element) => getComputedStyle(element).getPropertyValue('--term-surface').trim());
  // Resolve the theme token through a CSS property, independent of color notation.
  await context.evaluate((element, color) => { element.style.color = color; }, surface);
  const solidColor = await context.evaluate((element) => getComputedStyle(element).color);
  await context.evaluate((element) => { element.style.removeProperty('color'); });
  await expect(context).toHaveCSS('background-color', solidColor);
  await page.keyboard.press('Escape');

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-reduced-transparency', value: 'reduce' },
  ] });
  await page.getByTitle('Switch workspace', { exact: true }).click();
  await expect(workspace).toHaveCSS('backdrop-filter', 'none');
  await expect(workspace).toHaveCSS('background-image', 'none');
  await expect(workspace).toHaveCSS('background-color', solidColor);
  await workspace.screenshot({ path: info.outputPath('reduced-transparency.png') });
});

test('the corner radius preference reshapes menus, modals, rows and controls together', async ({ page }, info) => {
  await bootMenus(page, 'bone', { cornerRadius: 10 });
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const paletteDialog = page.getByRole('dialog', { name: /Command palette/i });
  await expect(paletteDialog).toHaveCSS('border-radius', '10px');
  await expect(paletteDialog.locator('.michi-menu-scope .ui-menu-item').first()).toHaveCSS('border-radius', '5px');
  await paletteDialog.screenshot({ path: info.outputPath('palette-radius-10.png') });
  await page.keyboard.press('Escape');

  await page.getByTitle('Switch workspace', { exact: true }).click();
  const workspace = page.getByRole('menu', { name: 'Workspaces', exact: true });
  await expect(workspace).toHaveCSS('border-radius', '10px');
  await expect(workspace.locator('.ui-menu-item').first()).toHaveCSS('border-radius', '5px');
  await workspace.screenshot({ path: info.outputPath('workspace-radius-10.png') });
  await page.keyboard.press('Escape');

  await page.locator('.terminal-sidebar').getByText('root conversation', { exact: true }).first().click({ button: 'right' });
  const context = page.getByRole('menu', { name: 'Actions', exact: true });
  await expect(context).toHaveCSS('border-radius', '10px');
  await page.keyboard.press('Escape');

  // Square is a valid choice too: 0 flattens every surface and row.
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--ui-radius', '0px');
    document.documentElement.style.setProperty('--ui-radius-sm', '0px');
  });
  await page.getByTitle('Switch workspace', { exact: true }).click();
  await expect(workspace).toHaveCSS('border-radius', '0px');
  await expect(workspace.locator('.ui-menu-item').first()).toHaveCSS('border-radius', '0px');
});

test('workspace list scrolls without losing search or New on small viewports', async ({ page }, info) => {
  await bootMenus(page, 'monokai');
  // Open it at phone width: narrowing Home moves the chip into the tray
  // under the composer, which closes a menu already open.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTitle('Switch workspace', { exact: true }).click();
  const workspace = page.getByRole('menu', { name: 'Workspaces', exact: true });
  for (const height of [844, 240]) {
    await page.setViewportSize({ width: 390, height });
    await assertSurface(workspace, 252, 390);
    const box = (await workspace.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(height - 8);
    await expect(workspace.getByRole('textbox')).toBeInViewport({ ratio: 1 });
    await expect(workspace.getByRole('menuitem', { name: /new workspace/ })).toBeInViewport({ ratio: 1 });
    await workspace.screenshot({ path: info.outputPath(`workspace-${height}px.png`) });
  }
  const lastWorkspace = workspace.getByRole('menuitem', { name: 'Workspace 9', exact: true });
  await lastWorkspace.scrollIntoViewIfNeeded();
  await expect(lastWorkspace).toBeInViewport({ ratio: 1 });
  await lastWorkspace.click();
  await expect(workspace).toHaveCount(0);
  await expect(page.getByTitle('Switch workspace', { exact: true })).toContainText('Workspace 9');
});

test('workspace, agent and model pickers share selection mark, pressed trigger, toggle and entrance', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await bootMenus(page, 'bone');
  const hover = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.background = 'var(--term-hover-bg, var(--term-alt))';
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
  const selectedMark = async (row: Locator) => row.evaluate((element) => {
    const glyph = element.querySelector('.michi-menu-glyph');
    // The check is CheckIcon from icons.tsx, in the row's trailing glyph slot.
    return !!glyph?.querySelector('svg') && element.lastElementChild === glyph;
  });

  const pickers = [
    { name: 'workspace', trigger: page.getByTitle('Switch workspace', { exact: true }), surface: page.getByRole('menu', { name: 'Workspaces', exact: true }) },
    { name: 'agent', trigger: page.locator('[title^="Switch agent"]').first(), surface: page.getByRole('menu', { name: 'Agents', exact: true }) },
    { name: 'model', trigger: page.getByRole('button', { name: /^Model settings:/ }), surface: page.getByRole('dialog', { name: 'Model settings' }) },
  ];
  for (const { name, trigger, surface } of pickers) {
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await expect(surface).toBeVisible();
    await expect(surface).toHaveAttribute('data-menu-animate', 'true');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await page.mouse.move(2, 890);
    await expect(trigger).toHaveCSS('background-color', hover);
    if (name === 'model') await surface.getByRole('button', { name: /Select runtime:/ }).click();
    await page.mouse.move(2, 890);
    const selected = name === 'workspace'
      ? surface.getByRole('menuitem', { name: /Menu implementation/ })
      : name === 'agent'
        ? surface.getByRole('menuitem', { name: /Default Agent/ })
        : surface.getByRole('menuitemradio', { checked: true });
    expect(await selectedMark(selected), `${name} marks the selection with a trailing check`).toBe(true);
    await expect(selected).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await surface.screenshot({ path: info.outputPath(`${name}-picker.png`) });
    await trigger.click();
    await expect(surface).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  }
});

/**
 * Records what each growing menu surface animates: its duration and the
 * properties it moves. An animation cancelled at once (the development
 * build's StrictMode remounts the surface) did not play.
 */
async function recordMenuMotion(page: Page) {
  await page.evaluate(() => {
    const played: Animation[] = [];
    (window as unknown as { menuMotion: Animation[] }).menuMotion = played;
    const original = Element.prototype.animate;
    Element.prototype.animate = function (...args: Parameters<typeof original>) {
      const animation = original.apply(this, args);
      if (this instanceof HTMLElement && this.dataset.menuMotion === 'grow') played.push(animation);
      return animation;
    };
  });
}
const menuMotion = (page: Page) => page.evaluate(() => (window as unknown as { menuMotion: Animation[] }).menuMotion
  .filter((animation) => animation.playState !== 'idle')
  .map((animation) => ({
    duration: Number(animation.effect?.getTiming().duration),
    properties: [...new Set((animation.effect as KeyframeEffect).getKeyframes().flatMap((frame) => Object.keys(frame)))]
      .filter((key) => !['offset', 'computedOffset', 'easing', 'composite'].includes(key)).sort(),
  })));

const GROW = { duration: 154, properties: ['opacity', 'transform'] };
const FADE_IN = { duration: 120, properties: ['opacity'] };
const FADE_OUT = { duration: 80, properties: ['opacity'] };

/** Opens a surface and closes it with Esc: it grows in (or only fades under reduced motion), then fades out as an inert ghost. */
async function expectGrowAndFade(page: Page, trigger: Locator, surface: Locator, entrance: typeof GROW) {
  await page.evaluate(() => { (window as unknown as { menuMotion: unknown[] }).menuMotion.length = 0; });
  await trigger.click();
  await expect(surface).toHaveAttribute('data-menu-motion', 'grow');
  await expect.poll(() => menuMotion(page)).toEqual([entrance]);
  await expect.poll(() => surface.evaluate((element) => element.getAnimations().length)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(surface).toHaveCount(0);
  await expect.poll(() => menuMotion(page)).toEqual([entrance, FADE_OUT]);
  await expect(page.locator('[data-menu-motion="grow"]')).toHaveCount(0);
}

test('the Trash ⋯ menu (ActionMenu) and a database Filter panel (DbPopover) grow in and fade out like the right-click menu', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const now = Date.now();
  const workspace = {
    workspace: { id: 'menu-ws', name: 'Menus', cwd: '/mock/menus', created_at: now - 86_400_000, active_tree_id: 'menu-tree' },
    nodes: [
      { id: 'live', tree_id: 'menu-tree', title: 'Live conversation', kind: 'chat', created_at: now - 86_400_000, message_count: 1 },
      { id: 'gone', tree_id: 'menu-tree', title: 'Deleted notes', kind: 'chat', created_at: now - 86_400_000, message_count: 1,
        deleted_at: now - 60_000, deletion_group_id: 'del-gone' },
    ],
    trees: [{ id: 'menu-tree', root_node_id: 'live', created_at: now, last_active_at: now }],
    edges: [], contexts: [], messages: [],
  };
  const pages = createPagesMockController();
  pages.pages.set('menu-page', { id: 'menu-page', workspaceId: 'menu-ws', parentId: null, position: 0, title: 'Menu page', color: null,
    updatedAt: 1, updatedBy: 'user', pendingProposals: 0, helperNodeId: null, revision: 1, viewVersion: 1,
    blocks: [{ id: 'board', rev: 1, type: 'task-view' }] });
  pages.databases.set('menu-tasks', taskDatabaseFixture({ id: 'menu-tasks', workspaceId: 'menu-ws', title: 'Tasks', revision: 1, updatedAt: now,
    rows: [{ id: 't1', values: { task: 'Write the migration', status: 'todo' }, position: 0, updatedAt: now, rev: 1, edited: {}, bodyEditedAt: null }] }));
  pages.taskDatabases.set('menu-ws', 'menu-tasks');
  await installMockApi(page, { workspaces: [workspace], custom: async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === '/api/prefs' && method === 'GET') {
      await route.fulfill({ json: { prefs: { onboardingCompletedAt: 1, terminalPalette: 'bone' } } });
      return true;
    }
    if (path === '/api/workspaces/menu-ws' && method === 'GET') {
      await route.fulfill({ json: workspace });
      return true;
    }
    return pages.handle(route);
  } });
  await page.addInitScript(() => localStorage.setItem('michi:migrated', '1'));
  await page.goto('/');
  await recordMenuMotion(page);

  const settings = await openSettings(page, 'Trash');
  const row = settings.locator('[data-history-key="thread:del-gone"]');
  const more = settings.getByRole('button', { name: 'More actions for Deleted notes' });
  const actions = page.getByRole('menu', { name: 'Trash actions' });
  await row.hover();
  await expectGrowAndFade(page, more, actions, GROW);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expectGrowAndFade(page, more, actions, FADE_IN);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await leaveSettings(page);

  await openArea(page, 'spaces');
  const sidebar = page.locator('.spaces-side');
  const pageRow = sidebar.getByRole('button', { name: 'Menu page', exact: true });
  if (!(await pageRow.isVisible())) await sidebar.getByRole('button', { name: 'Expand Menus', exact: true }).click();
  await pageRow.click();
  await page.locator('[data-tasks]').hover();
  await expectGrowAndFade(page, page.getByRole('button', { name: 'Filter', exact: true }), page.getByRole('dialog', { name: 'Filter' }), GROW);
});
