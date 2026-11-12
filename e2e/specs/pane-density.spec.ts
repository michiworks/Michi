import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { openThreadFromSidebar } from '../fixtures/shell';

// One density scale (index.css .terminal-pane[data-density]) drives the
// transcript, its messages and the floating composer; these are its values.
const SCALE = {
  dense: { top: 8, gutter: 22, font: '11px', leading: '15.95px', label: '9px', labelGap: '2px', pad: '4px', gap: '6px', inset: 18 },
  compact: { top: 12, gutter: 24, font: '12px', leading: '19.2px', label: '10px', labelGap: '3px', pad: '5px', gap: '10px', inset: 20 },
  comfortable: { top: 16, gutter: 32, font: '13px', leading: '22.75px', label: '10.5px', labelGap: '4px', pad: '6px', gap: '16px', inset: 26 },
} as const;

async function boot(page: Page, density: keyof typeof SCALE) {
  await installMockApi(page);
  await page.addInitScript((density) => {
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:state', JSON.stringify({
      version: 6, activeProjectId: 'ws',
      nodes: { root: { nodeId: 'root', kind: 'chat', chatId: null, projectId: 'ws', title: 'Density check', status: 'idle', followUps: [], messages: [
        { id: 'u1', role: 'user', text: 'A question', toolCalls: [], createdAt: 1 },
        { id: 'a1', role: 'assistant', text: 'An answer.', toolCalls: [], createdAt: 2 },
      ] } },
      projects: [{ id: 'ws', name: 'Scale', chatIds: ['root'], edges: [], trees: [{ id: 'tree', rootNodeId: 'root', createdAt: 1, lastActiveAt: 1 }], activeTreeId: 'tree', artifacts: [], createdAt: 1 }],
    }));
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: true, reduceMotion: true, paneTopFadeHeight: 20, terminalDensity: density }));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'ws::tree': ['root'] }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'ws::tree': null }));
  }, density);
  await page.goto('/');
  await openThreadFromSidebar(page, 'Density check');
  await expect(page.locator('.terminal-message-assistant')).toBeVisible();
}

for (const density of Object.keys(SCALE) as Array<keyof typeof SCALE>) {
  test(`a ${density} pane spaces its transcript, messages and composer from one scale`, async ({ page }) => {
    // Narrow enough that the composer's inset, not its centred max width, sets its edges.
    await page.setViewportSize({ width: 760, height: 860 });
    await boot(page, density);
    const measured = await page.evaluate(() => {
      const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
      const transcript = style('.terminal-pane__transcript');
      // A pane's answers carry no speaker line; the scale still sizes the
      // label the Meta agent window draws, so read the variables it sets.
      const scale = getComputedStyle(document.querySelector('.terminal-pane')!);
      const assistant = document.querySelector('.terminal-message-assistant')!;
      const root = assistant.closest('.terminal-message-frame')!.firstElementChild!;
      const pane = document.querySelector('.terminal-pane__transcript')!.parentElement!.getBoundingClientRect();
      const composer = document.querySelector('.terminal-composer')!.getBoundingClientRect();
      return {
        top: parseFloat(transcript.paddingTop), gutter: [transcript.paddingLeft, transcript.paddingRight],
        font: transcript.fontSize, leading: transcript.lineHeight,
        label: scale.getPropertyValue('--msg-label-size').trim(), labelGap: scale.getPropertyValue('--msg-label-gap').trim(),
        pad: [getComputedStyle(assistant).paddingTop, getComputedStyle(assistant).paddingBottom],
        gap: getComputedStyle(root).marginBottom,
        inset: [composer.left - pane.left, pane.right - composer.right],
      };
    });
    const scale = SCALE[density];
    expect(measured).toEqual({
      top: 20 + scale.top, gutter: [`${scale.gutter}px`, `${scale.gutter}px`], font: scale.font, leading: scale.leading,
      label: scale.label, labelGap: scale.labelGap, pad: [scale.pad, scale.pad], gap: scale.gap, inset: [scale.inset, scale.inset],
    });
  });
}
