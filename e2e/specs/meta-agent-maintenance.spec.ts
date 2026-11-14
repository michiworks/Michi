import { expect, test } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { openArea } from '../fixtures/shell';

test('Scheduled lists only the user’s jobs: Pages upkeep and its managed jobs have no row there (Q8)', async ({ page }) => {
  const overview = {
    state: 'running',
    runtime: { runtimeId: 'claude', providerId: null, modelId: null, reasoning: null, followsGlobal: true },
    today: { checks: 12, checksTruncated: false, modelCalls: 0, writes: 0, pendingProposals: 0 },
    lastCheckedAt: Date.now() - 60_000, recentRuns: [], managedJobIds: ['legacy-a'],
    cursors: [{ workspaceId: 'a', workspaceName: 'Alpha', cursor: 4, unread: 0, lastRunAt: null, state: 'synced' }],
  };
  const job = (id: string, name: string) => ({
    id, workspaceId: 'a', name, prompt: 'Summarize', schedule: { kind: 'every', everySeconds: 3600 }, enabled: true, autoPaused: false,
    runtimeId: null, providerId: null, modelId: null, reasoning: null, permissionMode: 'trust', sessionMode: 'fresh', notify: true,
    timeoutSeconds: 1800, consecutiveFailures: 0, activeRunId: null, lastRunAt: null, nextRunAt: null, lastStatus: null, lastError: null,
    persistentNodeId: null, createdAt: 1, updatedAt: 1,
  });
  await page.addInitScript(() => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false, reduceMotion: true }));
    localStorage.setItem('michi:migrated', '1');
  });
  await installMockApi(page, {
    workspaces: [{ workspace: { id: 'a', name: 'Alpha', created_at: 1 }, trees: [], nodes: [], edges: [], messages: [], contexts: [], artifacts: [] }],
    custom: async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/meta-agent/overview') { await route.fulfill({ json: overview }); return true; }
      // An older backend still lists a managed maintenance job among the jobs.
      if (path === '/api/scheduled-jobs') {
        await route.fulfill({ json: { jobs: [job('job-1', 'Morning digest'), job('legacy-a', 'Maintain Pages · Alpha')],
          scheduler: { active: true, serviceMode: false, timezone: 'UTC' } } });
        return true;
      }
      return false;
    },
  });
  await page.goto('/');
  await expect(page.locator('.home-page')).toBeVisible();
  await openArea(page, 'scheduled');
  await expect(page.locator('.sched-row')).toHaveCount(1);
  await expect(page.locator('.sched-row')).toContainText('Morning digest');
  await expect(page.locator('.sched-row[data-system]')).toHaveCount(0);
  await expect(page.getByText(/Pages upkeep|Maintain Pages/)).toHaveCount(0);
});
