import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { openSettings, settingsMain } from '../fixtures/shell';

// Settings › Skills against the mock API: no backend, runtime or skill
// folder. Listings come from the fixture's `skills` override, or from
// skillBackend(), which answers as the backend's routes would from a library
// its writes change (the page reads the listing again after each write), and
// records the writes.

const WORKSPACES = [{ workspace: { id: 'ws-a', name: 'Alpha', cwd: '/repo', created_at: 1 }, trees: [], nodes: [], edges: [], messages: [], contexts: [], artifacts: [] }];

const LIBRARY_ROOT = '/home/me/.michi/skills';
const REVIEW = '---\nname: review-pr\ndescription: Reviews a pull request.\nlicense: MIT\n---\n\n# Review a pull request\n\nRead the diff first.\n';
const base = { userInvocable: true, modelInvocable: true, enabled: true };
const librarySkill = (name: string, content: string, fields: Record<string, unknown> = {}) => ({
  ...base, id: `library:${name}`, name, description: /description: "?([^"\n]*)"?/.exec(content)?.[1] ?? '', origin: 'library',
  path: `${LIBRARY_ROOT}/${name}/SKILL.md`, content, files: [] as string[], ...fields,
});
const SKILLS = [
  librarySkill('review-pr', REVIEW, { files: ['references/checklist.md'] }),
  { ...base, id: 'runtime:claude:user:explain', name: 'explain', description: 'Explains code.', origin: 'runtime', runtimeId: 'claude', scope: 'user', path: '/home/me/.claude/skills/explain/SKILL.md' },
  { ...base, id: 'runtime:codex:repo:review-pr', name: 'review-pr', description: 'The repo’s review checklist.', origin: 'runtime', runtimeId: 'codex', scope: 'repo', path: '/repo/.agents/skills/review-pr/SKILL.md' },
];
const RUNTIMES = [{ id: 'claude', label: 'Claude', available: true }, { id: 'codex', label: 'Codex', available: true }, { id: 'pi', label: 'Pi', available: false }];

/** Answers the skill routes the way backend/src/routes/skills.ts does, from a library its writes change, and keeps what was sent. */
function skillBackend() {
  const writes: Array<{ request: string; body: Record<string, unknown> }> = [];
  const library = new Map<string, Record<string, unknown>>([['review-pr', SKILLS[0]]]);
  const runtime = SKILLS.filter((skill) => skill.origin === 'runtime');
  const summary = ({ content: _content, files: _files, ...skill }: Record<string, unknown>) => skill;
  const handle = async (route: Route): Promise<boolean> => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^.*\/api/, '');
    const method = request.method();
    if (!path.startsWith('/skills') || path === '/skills/catalog') return false;
    const json = async (status: number, data: unknown) => { await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) }); return true; };
    if (method === 'GET' && path === '/skills') {
      return json(200, { skills: [...library.values(), ...runtime].map(summary), errors: [], libraryAvailable: true, runtimes: RUNTIMES });
    }
    if (method === 'GET') {
      // The fixture answers for the runtime skills.
      const entry = library.get((url.searchParams.get('id') ?? '').replace(/^library:/, ''));
      return path === '/skills/detail' && entry ? json(200, { skill: entry }) : false;
    }
    const body = method === 'DELETE' ? {} : request.postDataJSON() as Record<string, unknown>;
    writes.push({ request: `${method} ${path}`, body });
    if (path === '/skills/library' && method === 'POST') {
      const created = librarySkill(String(body.name), String(body.content));
      library.set(created.name, created);
      return json(200, { skill: summary(created) });
    }
    const name = decodeURIComponent(path.slice('/skills/library/'.length));
    if (method === 'DELETE') { library.delete(name); await route.fulfill({ status: 204, body: '' }); return true; }
    const current = library.get(name)!;
    const newName = typeof body.newName === 'string' ? body.newName : name;
    const content = typeof body.content === 'string' ? body.content : String(current.content);
    const saved = { ...librarySkill(newName, content, { files: current.files }), enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled };
    library.delete(name);
    library.set(newName, saved);
    return json(200, { skill: summary(saved) });
  };
  return { handle, writes };
}

async function boot(page: Page, custom: (route: Route) => Promise<boolean>, skills: Array<Record<string, unknown>> = SKILLS) {
  await page.addInitScript(() => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false, reduceMotion: true }));
    localStorage.setItem('michi:migrated', '1');
  });
  await installMockApi(page, { workspaces: WORKSPACES, skills, custom });
  await page.goto('/');
  await expect(page.locator('.home-page')).toBeVisible();
}

/** Settings › Agent › Skills in the window. */
async function openSkills(page: Page): Promise<Locator> {
  const settings = await openSettings(page);
  await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('group', { name: 'Agent' })
    .getByRole('button', { name: 'Skills', exact: true }).click();
  await expect(settings.getByRole('heading', { level: 1, name: 'Skills' })).toBeVisible();
  return settings;
}

const region = (scope: Locator, name: RegExp) => scope.getByRole('region', { name });
const row = (scope: Locator, section: RegExp, name: string) => region(scope, section).getByRole('button', { name, exact: true });

test('browses each source, opens a library skill, edits it and turns it off', async ({ page }) => {
  const backend = skillBackend();
  await boot(page, backend.handle);
  await expect(page.locator('.terminal-sidebar').getByRole('button', { name: 'Skills', exact: true })).toHaveCount(0);
  const settings = await openSkills(page);
  for (const name of [/^Library/, /^Claude/, /^Codex/]) await expect(region(settings, name)).toBeVisible();
  await expect(region(settings, /^Library/)).toContainText(LIBRARY_ROOT);
  await expect(settings.getByText('Pi isn’t set up on this machine.')).toBeVisible();
  // Styled without Trash.css, which only Scheduled loads: the size of the toolbar's controls.
  await expect(settings.getByRole('button', { name: 'Check the runtimes for new skills' })).toHaveCSS('height', '30px');

  const source = settings.getByRole('combobox', { name: 'Source' });
  await source.selectOption('codex');
  await expect(region(settings, /^Library/)).toHaveCount(0);
  await expect(row(settings, /^Codex/, 'review-pr')).toContainText('Repo');
  await source.selectOption('all');
  await settings.getByRole('searchbox', { name: 'Search skills' }).fill('explain');
  await expect(region(settings, /^Library/)).toHaveCount(0);
  await expect(row(settings, /^Claude/, 'explain')).toBeVisible();
  await settings.getByRole('searchbox', { name: 'Search skills' }).fill('');

  await row(settings, /^Library/, 'review-pr').click();
  await expect(settings.getByRole('heading', { level: 1, name: 'review-pr' })).toBeFocused();
  await expect(settings.getByRole('heading', { name: 'Review a pull request' })).toBeVisible();
  await expect(settings.getByRole('region', { name: 'Details' })).toContainText('references/checklist.md');
  await page.screenshot({ path: test.info().outputPath('skills-library-detail.png') });

  await settings.getByRole('button', { name: 'Edit', exact: true }).click();
  const form = settings.getByRole('form', { name: 'Edit review-pr' });
  await form.getByRole('textbox', { name: 'Description' }).fill('Reviews a PR for correctness.');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(settings.getByRole('heading', { level: 1, name: 'review-pr' })).toBeVisible();
  await settings.getByRole('switch', { name: 'Enabled' }).click();
  await expect(settings.getByText('Library skill · Off')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(row(settings, /^Library/, 'review-pr')).toBeFocused();
  await expect(region(settings, /^Library/).locator('[data-history-key="library:review-pr"]')).toContainText('Off');

  expect(backend.writes.map((write) => write.request)).toEqual(['PUT /skills/library/review-pr', 'PUT /skills/library/review-pr']);
  expect(String(backend.writes[0].body.content)).toContain('description: "Reviews a PR for correctness."');
  expect(String(backend.writes[0].body.content)).toContain('license: MIT');
  expect(backend.writes[1].body).toEqual({ enabled: false });
});

test('opens from the palette, creates a skill, renames it and deletes it after confirming', async ({ page }) => {
  const backend = skillBackend();
  await boot(page, backend.handle);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByText('Open Skills', { exact: true }).click();
  const settings = settingsMain(page);
  await settings.getByRole('button', { name: 'New skill', exact: true }).click();
  const form = settings.getByRole('form', { name: 'New skill' });
  await form.getByRole('textbox', { name: 'Name' }).fill('summarize-diff');
  await form.getByRole('textbox', { name: 'Description' }).fill('Summarizes a diff.');
  await form.getByRole('textbox', { name: 'Instructions' }).fill('# Summarize a diff\n\nList what changed.');
  await form.getByRole('button', { name: 'Create skill' }).click();
  await expect(settings.getByRole('heading', { level: 1, name: 'summarize-diff' })).toBeVisible();
  await expect(settings.getByRole('heading', { name: 'Summarize a diff' })).toBeVisible();

  await settings.getByRole('button', { name: 'Rename…' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename skill' });
  await rename.getByRole('textbox', { name: 'New name' }).fill('diff-summary');
  await rename.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(settings.getByRole('heading', { level: 1, name: 'diff-summary' })).toBeVisible();

  await settings.getByRole('button', { name: 'Delete…' }).click();
  await page.getByRole('dialog', { name: 'Delete skill?' }).getByRole('button', { name: 'Delete skill' }).click();
  await expect(row(settings, /^Library/, 'review-pr')).toBeVisible();
  await expect(row(settings, /^Library/, 'diff-summary')).toHaveCount(0);
  expect(backend.writes.map((write) => write.request)).toEqual(['POST /skills/library', 'PUT /skills/library/summarize-diff', 'DELETE /skills/library/diff-summary']);
  expect(backend.writes[0].body).toEqual({
    name: 'summarize-diff',
    content: '---\nname: summarize-diff\ndescription: "Summarizes a diff."\n---\n\n# Summarize a diff\n\nList what changed.\n',
  });
  expect(backend.writes[1].body).toEqual({
    newName: 'diff-summary',
    content: '---\nname: diff-summary\ndescription: "Summarizes a diff."\n---\n\n# Summarize a diff\n\nList what changed.\n',
  });
});

test('says so when the backend keeps no skills', async ({ page }) => {
  await boot(page, async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/api/skills')) {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Skills are unavailable', code: 'skills_unavailable' }) });
      return true;
    }
    return false;
  });
  const settings = await openSkills(page);
  await expect(settings.getByText('This Michi server keeps no skill library.')).toBeVisible();
  await expect(settings.getByRole('button', { name: 'New skill', exact: true })).toHaveCount(0);
});

test('a phone opens Skills from the Settings list, with New in the header and a read-only runtime skill', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await boot(page, async () => false);
    const settings = await openSettings(page);
    const skillsRow = settings.getByRole('button', { name: 'Skills', exact: true });
    await expect(skillsRow).toContainText('1');
    await skillsRow.click();
    const header = page.getByRole('dialog', { name: 'Settings' }).locator('.ui-overlay-header');
    await expect(header.getByRole('button', { name: 'New skill', exact: true })).toHaveText('New');
    await row(settings, /^Claude/, 'explain').click();
    await expect(settings.getByRole('heading', { level: 1, name: 'explain' })).toBeFocused();
    await expect(settings.getByText('Read only')).toBeVisible();
    // Finger-sized: small buttons are at least 36px tall here.
    const viewSource = settings.getByRole('button', { name: 'View source' });
    await expect(viewSource).toBeVisible();
    expect((await viewSource.boundingBox())!.height).toBeGreaterThanOrEqual(36);
    await expect(header.getByRole('button', { name: 'New skill', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: test.info().outputPath('skills-phone-detail.png') });
    await header.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(row(settings, /^Claude/, 'explain')).toBeFocused();
  } finally {
    await context.close();
  }
});
