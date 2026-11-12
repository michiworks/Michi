import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { openArea } from '../fixtures/shell';

/**
 * A Scheduled-only job's run: its thread is not among the workspace's
 * conversations, and opens read-only on the Scheduled page.
 */
const now = Date.now();
const run = {
  id: 'run-1', jobId: 'job-1', workspaceId: 'ws-1', nodeId: 'n-run', treeId: 't-run', trigger: 'scheduled',
  status: 'succeeded', scheduledFor: now - 60_000, startedAt: now - 60_000, finishedAt: now - 30_000,
  summary: 'The build is green.', error: null, scheduledOnly: true,
};

async function boot(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false, reduceMotion: true }));
    localStorage.setItem('michi:migrated', '1');
  });
  await installMockApi(page, {
    workspaces: [{
      workspace: { id: 'ws-1', name: 'Builds', active_tree_id: 't-user', created_at: 1 },
      trees: [
        { id: 't-user', workspace_id: 'ws-1', root_node_id: 'n-user', created_at: 1, last_active_at: 1 },
        { id: 't-run', workspace_id: 'ws-1', root_node_id: 'n-run', created_at: 2, last_active_at: 5 },
      ],
      nodes: [
        { id: 'n-user', kind: 'chat', workspace_id: 'ws-1', tree_id: 't-user', title: 'Release notes', status: 'idle', created_at: 1 },
        { id: 'n-run', kind: 'chat', workspace_id: 'ws-1', tree_id: 't-run', title: 'Nightly check', status: 'idle', created_at: 2,
          scheduled_only_job_id: 'job-1' },
      ],
      edges: [],
      messages: [
        { id: 'u0', node_id: 'n-user', role: 'user', content: 'Draft the release notes', seq: 0, created_at: 1 },
        { id: 'u1', node_id: 'n-run', role: 'user', content: 'Check the nightly build.', seq: 0, created_at: 2,
          metadata: JSON.stringify({ scheduledJobId: 'job-1' }) },
        { id: 'a1', node_id: 'n-run', role: 'assistant', content: 'The build is green. No new test failures since yesterday.', seq: 1, created_at: 3 },
      ],
      artifacts: [],
    }],
    custom: async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/meta-agent/overview') {
        await route.fulfill({ status: 404, json: { error: 'unavailable' } });
        return true;
      }
      if (path === '/api/scheduled-jobs') {
        await route.fulfill({ json: {
          jobs: [{
            id: 'job-1', workspaceId: 'ws-1', name: 'Nightly check', prompt: 'Check the nightly build.',
            schedule: { kind: 'every', everySeconds: 86_400 }, enabled: true, autoPaused: false,
            runtimeId: null, providerId: null, modelId: null, reasoning: null, permissionMode: 'trust',
            sessionMode: 'fresh', visibility: 'scheduled', notify: true, timeoutSeconds: 1800, consecutiveFailures: 0,
            activeRunId: null, lastRunAt: run.startedAt, nextRunAt: now + 86_400_000, lastStatus: 'succeeded', lastError: null,
            persistentNodeId: null, createdAt: 1, updatedAt: 1,
          }],
          scheduler: { active: true, serviceMode: false, timezone: 'UTC' },
        } });
        return true;
      }
      if (path === '/api/scheduled-jobs/job-1/runs') {
        await route.fulfill({ json: { runs: [run] } });
        return true;
      }
      if (path === '/api/scheduled-jobs/runs/run-1') {
        await route.fulfill({ json: run });
        return true;
      }
      return false;
    },
  });
  await page.goto('/');
  await expect(page.locator('.home-page')).toBeVisible();
}

test('a Scheduled-only run stays out of the conversations and opens read-only in Scheduled', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await boot(page);
  await openArea(page, 'conversations');
  await expect(page.getByText('Release notes').first()).toBeVisible();
  await expect(page.getByText('Nightly check')).toHaveCount(0);

  await openArea(page, 'scheduled');
  await page.getByRole('button', { name: 'Open Nightly check', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'Scheduled job', exact: true });
  await expect(detail.getByText('Only in Scheduled')).toBeVisible();
  await detail.getByRole('button', { name: /Succeeded run from .*open run/ }).click();

  // The run opens as its conversation, in place of the list.
  const viewer = page.getByRole('region', { name: 'Nightly check run', exact: true });
  await expect(viewer.getByText('No new test failures since yesterday.')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(viewer.getByRole('button', { name: /Move to workspace/ })).toBeVisible();
  await expect(viewer.locator('.terminal-composer')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('run-viewer.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(viewer.getByText('No new test failures since yesterday.')).toBeVisible();
  await page.screenshot({ path: info.outputPath('run-viewer-phone.png') });

  await viewer.getByRole('button', { name: 'Nightly check details and runs' }).click();
  await expect(page.getByRole('dialog', { name: 'Scheduled job', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
