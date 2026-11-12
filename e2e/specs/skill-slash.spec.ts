import { expect, test } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

const kiroStatus = {
  runtime: 'kiro', label: 'Kiro', hasRequiredKey: true,
  capabilities: { modes: false, permissions: true, providerModels: false, reasoning: false,
    apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: false },
  availableRuntimes: [{ id: 'kiro', label: 'Kiro', available: true }],
};

const skill = (fields: Record<string, unknown>) => ({ userInvocable: true, modelInvocable: true, enabled: true, ...fields });

function kiroWorkspace() {
  return {
    workspace: { id: 'skills-ws', name: 'Skills', active_tree_id: 'skills-tree', created_at: 1 },
    trees: [{ id: 'skills-tree', workspace_id: 'skills-ws', root_node_id: 'kiro-chat', name: 'Kiro chat', created_at: 1, last_active_at: 1 }],
    nodes: [{ id: 'kiro-chat', kind: 'chat', workspace_id: 'skills-ws', tree_id: 'skills-tree',
      title: 'Kiro chat', status: 'idle', runtime_id: 'kiro', created_at: 1 }],
    edges: [], contexts: [],
    messages: [
      { id: 'u1', node_id: 'kiro-chat', role: 'user', seq: 0, content: 'Earlier question', created_at: 1 },
      { id: 'a1', node_id: 'kiro-chat', role: 'assistant', seq: 1, content: 'Earlier answer.', created_at: 2 },
    ],
  };
}

test('the / menu lists names, describes the highlighted one, and runs the row picked', async ({ page }) => {
  const messages: Array<Record<string, unknown>> = [], commands: string[] = [];
  await installMockApi(page, {
    workspaces: [kiroWorkspace()],
    skills: [
      skill({ id: 'library:review', name: 'review', description: 'Review a pull request', origin: 'library', argumentHint: '<pr>' }),
      skill({ id: 'library:context', name: 'context', description: 'Gather what a task needs', origin: 'library' }),
      skill({ id: 'runtime:claude:user:deploy', name: 'deploy', description: 'Claude only', origin: 'runtime', runtimeId: 'claude', scope: 'user' }),
    ],
    custom: async (route) => {
      const req = route.request(), path = new URL(req.url()).pathname;
      if (path.endsWith('/agent/status')) { await route.fulfill({ json: kiroStatus }); return true; }
      if (req.method() !== 'POST') return false;
      if (path.endsWith('/ensure-session')) {
        await route.fulfill({ json: { chatId: 'kiro-chat', runtimeId: 'kiro', currentModeId: null, resumeStrategy: 'exact',
          sessionState: { runtimeId: 'kiro', nativeEngine: 'v3', commands: [{ name: 'context' }] } } });
        return true;
      }
      if (path.endsWith('/execute-command')) {
        commands.push(req.postDataJSON().command);
        await route.fulfill({ json: { success: true, data: 'Context contains 123 tokens.' } });
        return true;
      }
      if (path.endsWith('/message')) messages.push(req.postDataJSON());
      return false;
    },
  });
  await page.goto('/');
  await page.locator('[data-sidebar-row="kiro-chat"]').click();
  const pane = page.locator('.terminal-pane[data-node-id="kiro-chat"]');
  const editor = pane.locator('[contenteditable="true"]');
  const menu = page.getByRole('listbox', { name: 'Slash commands', exact: true });
  const detail = page.locator('.michi-slash-detail');

  // A cold chat: no Kiro session yet, the catalog asked for when the pane got focus.
  await editor.fill('/rev');
  await expect(menu.getByRole('option')).toHaveText(['/review']);
  await expect(detail).toContainText('Skill · Michi');
  await expect(detail).toContainText('Review a pull request');
  await expect(detail).toContainText('/review <pr>');
  await editor.press('Enter');
  await expect(editor).toHaveText('/review');
  await editor.pressSequentially('123');
  await pane.getByRole('button', { name: /Send \(Enter\)/ }).click();

  await expect.poll(() => messages.length).toBe(1);
  expect(messages[0]).toMatchObject({ text: '123', displayText: '/review 123', skill: { id: 'library:review', name: 'review', args: '123' } });
  const sent = pane.locator('.terminal-message-user').last();
  await expect(sent).toContainText('/review 123');
  await expect(sent.locator('.terminal-message-skill')).toHaveText('Skill · Michi');
  await expect(pane.getByText('Hello from mock kiro.').first()).toBeVisible();
  expect(commands).toEqual([]);

  // Kiro's command and the library skill share the name: both are listed, the skill tagged.
  await editor.fill('/con');
  await expect(menu.getByRole('option')).toHaveText(['/context', '/contextSkill']);
  await expect(detail).toContainText('Command');
  await editor.press('ArrowDown');
  await expect(detail).toContainText('Skill · Michi');
  // Typed by hand, the command runs.
  await editor.fill('/context');
  await pane.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await expect(pane.getByText('Context contains 123 tokens.', { exact: true })).toBeVisible();
  expect(commands).toEqual(['context']);
  expect(messages).toHaveLength(1);

  // Picked, the skill runs.
  await editor.fill('/con');
  await editor.press('ArrowDown');
  await editor.press('Enter');
  await expect(editor).toHaveText('/context');
  await editor.pressSequentially('the plan');
  await pane.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await expect.poll(() => messages.length).toBe(2);
  expect(messages[1]).toMatchObject({ text: 'the plan', skill: { id: 'library:context', name: 'context', args: 'the plan' } });
  expect(commands).toEqual(['context']);
});
