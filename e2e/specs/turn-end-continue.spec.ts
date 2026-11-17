import { test, expect } from '@playwright/test';
import { installMockApi, bootWithWorkspace, sseBody } from '../fixtures/mockApi';
import { COMPOSER_EDITOR } from '../fixtures/shell';

// A turn that ends at a limit leaves a neutral line under its answer, and the
// latest one's Continue sends the continuation prompt through the normal send
// path (POST /chats/:id/message), not the original request again.
test('a turn stopped at its step limit is marked, and Continue carries it on', async ({ page }) => {
  const requests: Array<{ text: string; displayText?: string }> = [];
  await installMockApi(page, { custom: async (route) => {
    const request = route.request();
    if (!/\/chats\/[^/]+\/message$/.test(new URL(request.url()).pathname)) return false;
    const payload = request.postDataJSON() as { text: string; displayText?: string };
    requests.push({ text: payload.text, displayText: payload.displayText });
    const first = requests.length === 1;
    await route.fulfill({ contentType: 'text/event-stream', body: sseBody([
      { event: 'chunk', data: { text: first ? 'Fixed two of the three files.' : 'Fixed the last file.' } },
      { event: 'done', data: { stopReason: first ? 'max_turn_requests' : 'end_turn', persisted: true } },
    ]) });
    return true;
  } });
  await bootWithWorkspace(page);

  const composer = page.locator(COMPOSER_EDITOR).first();
  await composer.fill('Fix the build');
  await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect(page.getByText('Fixed two of the three files.', { exact: true })).toBeVisible();
  const note = page.getByTestId('turn-end-note');
  await expect(note).toContainText('Stopped early: it reached its step limit');

  await note.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Fixed the last file.', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1].displayText).toBe('Continue');
  expect(requests[1].text).toMatch(/^Your previous turn stopped before it finished: it reached its step limit\. The user pressed Continue\./);
  await expect(page.locator('.terminal-message-user').getByText('Continue', { exact: true })).toHaveCount(1);
  // The earlier answer keeps its line; only the latest offered Continue, and that one finished.
  await expect(page.getByTestId('turn-end-note')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0);
});
