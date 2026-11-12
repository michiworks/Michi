import { test, expect } from '@playwright/test';
import { installMockApi, bootWithWorkspace } from '../fixtures/mockApi';
import { COMPOSER_EDITOR } from '../fixtures/shell';

// The page an agent saved: its script reports what the sandbox let it do.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Bubble &amp; bar mock</title></head>
<body><p id="out">waiting</p><script>
  const body = document.body.dataset;
  document.getElementById('out').textContent = 'script ran';
  try { void parent.document.title; body.parent = 'reachable'; } catch { body.parent = 'blocked'; }
  try { localStorage.setItem('k', 'v'); body.storage = localStorage.getItem('k'); } catch { body.storage = 'threw'; }
  try { history.replaceState({}, '', ''); body.history = 'ok'; } catch { body.history = 'threw'; }
  fetch('/api/health').then(() => { body.net = 'open'; }, () => { body.net = 'blocked'; });
</script></body></html>`;

test('an HTML artifact opens in a sandboxed preview that can run but cannot reach Michi or the network', async ({ page }) => {
  const healthFromFrame: string[] = [];
  const headRanges: Array<string | undefined> = [];
  await installMockApi(page, {
    streamEvents: [
      { event: 'artifact_saved', data: { name: 'bubble-mock', filePath: 'mocks/bubble/index.html', size: PAGE.length, contextId: 'ctx-mock' } },
      { event: 'chunk', data: { text: 'Saved the mock.' } },
      { event: 'done', data: { stopReason: 'end_turn' } },
    ],
    custom: async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.endsWith('/health') && request.frame() !== page.mainFrame()) healthFromFrame.push(url.pathname);
      if (url.pathname.endsWith('/download')) {
        // The drawer reads only the head for the title, with a Range request.
        headRanges.push(request.headers().range);
        await route.fulfill({ status: 206, contentType: 'application/octet-stream', body: PAGE.slice(0, 120) });
        return true;
      }
      if (/\/artifacts\/[^/]+\/read$/.test(url.pathname)) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: PAGE, path: 'mocks/bubble/index.html', basename: 'index.html', extension: 'html', size: PAGE.length, modifiedAt: 1 }) });
        return true;
      }
      return false;
    },
  });
  await bootWithWorkspace(page);
  await page.locator(COMPOSER_EDITOR).first().fill('Make a mock');
  await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await expect(page.getByText('Saved the mock.')).toBeVisible();

  await page.keyboard.press('ControlOrMeta+Shift+A');
  const drawer = page.getByRole('dialog', { name: 'Artifacts', exact: true });
  // Named by its page title, grouped under Today, typed on the second line.
  await expect(drawer.getByRole('region', { name: 'Today' }).getByText('Bubble & bar mock', { exact: true })).toBeVisible();
  await expect(drawer.getByText(/^HTML( · from .+)?$/)).toBeVisible();
  // Dev StrictMode runs the read effect twice (the first read is aborted).
  expect(headRanges.length).toBeGreaterThan(0);
  expect(new Set(headRanges)).toEqual(new Set(['bytes=0-4095']));

  await drawer.getByText('Bubble & bar mock', { exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Artifact: Bubble & bar mock' });
  await expect(preview).toBeVisible();
  const iframe = preview.locator('iframe');
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
  const frame = page.frameLocator('[data-testid="artifact-preview"] iframe');
  await expect(frame.locator('#out')).toHaveText('script ran');
  const body = frame.locator('body');
  await expect(body).toHaveAttribute('data-parent', 'blocked');
  await expect(body).toHaveAttribute('data-storage', 'v');
  await expect(body).toHaveAttribute('data-history', 'ok');
  await expect(body).toHaveAttribute('data-net', 'blocked');
  expect(healthFromFrame).toEqual([]);

  // Back goes to the list, not out of the drawer.
  await page.keyboard.press('Escape');
  await expect(drawer.getByText('Bubble & bar mock', { exact: true })).toBeVisible();
  await expect(page.locator('[data-testid="artifact-preview"]')).toHaveCount(0);
});
