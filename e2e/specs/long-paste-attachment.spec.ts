import { expect, test, type Page } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';
import { COMPOSER_EDITOR } from '../fixtures/shell';

const LONG_TEXT = 'x'.repeat(9_000) + '\n' + 'y'.repeat(3_000);

async function pasteText(page: Page, text: string) {
  await page.locator(COMPOSER_EDITOR).first().evaluate((el, value) => {
    (el as HTMLElement).focus();
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', value);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, text);
}

test('a long paste becomes a text attachment in the Home and pane composers', async ({ page }) => {
  const imported: Array<{ originalName: string; content: string; subdir?: string }> = [];
  await installMockApi(page, {
    custom: async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace(/^.*\/api/, '');
      const json = (data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
      if (path === '/uploads/web-cwd') { await json({ cwd: '/mock' }); return true; }
      if (path === '/workspaces/import-file') {
        const body = request.postDataJSON();
        imported.push(body);
        await json({ name: body.originalName, displayName: body.originalName, filePath: `.attachments/${body.originalName}`, size: body.content.length });
        return true;
      }
      return false;
    },
  });
  await bootWithWorkspace(page, 'Long paste');
  const editor = page.locator(COMPOSER_EDITOR).first();

  await pasteText(page, LONG_TEXT);
  await expect(page.locator('.t-att-pending-file')).toContainText(/pasted-text-.*\.txt/);
  await expect(editor).toHaveText('');
  expect(imported).toEqual([expect.objectContaining({ content: LONG_TEXT, subdir: '.attachments' })]);

  await editor.fill('hello');
  await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect(page.getByText('Hello from mock kiro.').first()).toBeVisible();

  await pasteText(page, LONG_TEXT);
  await expect.poll(() => imported.length).toBe(2);
  await expect(page.locator('.t-att-pending-file')).toContainText(/pasted-text-.*\.txt/);
  await expect(editor).toHaveText('');
});
