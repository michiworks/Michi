import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { openArea } from '../fixtures/shell';

async function boot(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false, reduceMotion: true }));
    localStorage.setItem('michi:migrated', '1');
  });
  await installMockApi(page, {
    workspaces: [{ workspace: { id: 'ws-1', name: 'Scheduled workspace', created_at: 1 }, trees: [], nodes: [], edges: [], messages: [], contexts: [], artifacts: [] }],
    custom: async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/meta-agent/overview') {
        await route.fulfill({ json: {
          state: 'running', runtime: { runtimeId: 'claude', providerId: null, modelId: null, reasoning: null, followsGlobal: true },
          today: { checks: 0, checksTruncated: false, modelCalls: 0, writes: 0, pendingProposals: 0 },
          cursors: [], recentRuns: [], managedJobIds: [],
        } });
        return true;
      }
      if (path === '/api/scheduled-jobs') {
        await route.fulfill({ json: {
          jobs: [{
            id: 'job-1', workspaceId: 'ws-1', name: 'Morning digest', prompt: 'Summarize overnight changes',
            schedule: { kind: 'every', everySeconds: 3600 }, enabled: true, autoPaused: false,
            runtimeId: null, providerId: null, modelId: null, reasoning: null, permissionMode: 'trust',
            sessionMode: 'fresh', notify: true, timeoutSeconds: 1800, consecutiveFailures: 0,
            activeRunId: null, lastRunAt: null, nextRunAt: null, lastStatus: null, lastError: null,
            persistentNodeId: null, createdAt: 1, updatedAt: 1,
          }],
          scheduler: { active: true, serviceMode: false, timezone: 'UTC' },
        } });
        return true;
      }
      if (path === '/api/scheduled-jobs/job-1/runs') {
        await route.fulfill({ json: { runs: [] } });
        return true;
      }
      return false;
    },
  });
  await page.goto('/');
  await expect(page.locator('.home-page')).toBeVisible();
}

test('ordinary job details and sidebar selection restore together after closing', async ({ page }) => {
  await boot(page);
  await openArea(page, 'scheduled');
  // Pages upkeep runs when conversations go quiet, not on a schedule: no row for it here (Q8).
  await expect(page.getByText('Michi · Pages upkeep')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open Morning digest', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Scheduled job', exact: true });
  await expect(dialog.getByRole('heading', { name: 'Morning digest', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  const row = page.locator('.scheduled-side').getByRole('button', { name: 'Morning digest', exact: true });
  await expect(row).not.toHaveAttribute('aria-current');
  await page.getByRole('button', { name: 'Navigate back', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(page.locator('.scheduled-side [aria-label="Morning digest"]')).toHaveAttribute('aria-current', 'true');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
  await row.click();
  await expect(dialog).toBeVisible();
});
