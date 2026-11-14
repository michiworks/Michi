import { expect, test } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { openArea } from '../fixtures/shell';
import { createSpacesHomeMock } from '../fixtures/spacesHomeFixtures';
import { companionItem, createCompanionMock } from '../fixtures/companionFixtures';

// What needs you is listed in one place, Today (unification design D13, Q12):
// the Pages Home keeps one line where Waiting on you stood, and no Stalled or
// Just done of its own.

const WS = 'ws-sample';
const runs = { runtimeId: 'mock', providerId: null, modelId: null, reasoning: null };
const assistant = { nodeId: 'companion-node', treeId: 'tree-companion', workspaceId: 'ws-assistant', settings: runs, conversation: runs,
  conversationFollowsGlobal: true, supportedRuntimes: ['mock'] };

test('the Pages Home says how many things need you and opens Today; it lists no Waiting, Stalled or Just done', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const workspace = {
    workspace: { id: WS, name: 'sample-project', created_at: 1 },
    trees: [], nodes: [], edges: [], contexts: [], artifacts: [], messages: [],
  };
  const spaces = createSpacesHomeMock({
    homeBlocks: [{ id: 'lead', rev: 1, type: 'markdown', text: 'Today across your workspaces.' }, { id: 'waiting', rev: 1, type: 'home-section', section: 'waiting' }],
    workspaceHomes: { [WS]: { name: 'sample-project', blocks: [{ id: 'summary', rev: 1, type: 'markdown', text: 'Release work is in progress.' }] } },
  });
  const companion = createCompanionMock({
    conversation: { workspaceId: 'ws-assistant', nodeId: 'companion-node', assistant },
    items: [
      companionItem('cmi-cr', 'CR-123456 needs attention'),
      companionItem('cmi-pipe', 'MyService pipeline is blocked', { source: 'pipeline', subtype: 'pipeline_blocked', itemKey: 'pipeline:MyService' }),
    ],
  });
  await page.addInitScript(() => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1 }));
    localStorage.setItem('michi:migrated', '1');
  });
  await installMockApi(page, { workspaces: [workspace], custom: async (route) => {
    // The panel stands on the agent's conversation (`/assistant`), as in companion-panel.spec.ts.
    if (new URL(route.request().url()).pathname === '/api/assistant') { await route.fulfill({ json: assistant }); return true; }
    return (await spaces.handle(route)) || companion.handle(route);
  } });
  await page.goto('/');
  await expect(page.locator('.home-page')).toBeVisible();
  await openArea(page, 'spaces');
  const home = page.locator('main.spaces-home');
  await expect(home.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();

  const line = home.locator('.spaces-home-needs-you');
  await expect(line).toHaveText('2 things need you · Open Today');
  for (const name of ['Waiting on you', 'Stalled', 'Just done']) await expect(home.getByRole('region', { name })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('spaces-home-needs-you.png') });

  await line.getByRole('button', { name: 'Open Today' }).click();
  const panel = page.getByRole('complementary', { name: 'Michi', exact: true });
  await expect(panel.getByRole('tab', { name: /Today/ })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText('CR-123456 needs attention')).toBeVisible();
  expect(errors).toEqual([]);
});
