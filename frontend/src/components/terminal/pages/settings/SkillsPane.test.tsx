import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { SkillCatalogError, SkillDetail, SkillRuntimeInfo, SkillSummary } from 'michi-shared';
import { createLibrarySkill, deleteLibrarySkill, listSkills, setBuiltinSkillEnabled, SKILLS_CHANGED_EVENT, updateLibrarySkill } from '../../../../services/api/skills';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import { ModalShell } from '../../../ui/ModalShell';
import { SettingsHeaderActionContext, type SettingsHeaderAction } from './settingsPhone';
import { SkillsPane } from './SkillsPane';

/** The backend's skill routes over an in-memory library and runtime listings. */
const backend = vi.hoisted(() => ({
  library: [] as SkillDetail[],
  builtin: [] as SkillDetail[],
  runtime: [] as SkillDetail[],
  runtimes: [] as SkillRuntimeInfo[],
  errors: [] as SkillCatalogError[],
  /** Runtimes still listing: their skills are left out. */
  pending: [] as string[],
  unavailable: undefined as string | null | undefined,
}));
const workspaces = vi.hoisted(() => ({ projects: [] as Array<Record<string, unknown>> }));
vi.mock('../../../../services/api/skills', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../services/api/skills')>();
  const shared = await vi.importActual<typeof import('michi-shared')>('michi-shared');
  const summary = ({ content: _content, files: _files, ...rest }: SkillDetail): SkillSummary => rest;
  const find = (name: string) => {
    const entry = backend.library.find((item) => item.name === name);
    if (!entry) throw new actual.SkillsApiError(404, 'Skill not found', { code: 'not_found' });
    return entry;
  };
  const withDescription = (entry: SkillDetail) => Object.assign(entry, { description: shared.readSkillFileInfo(entry.content, entry.name).description });
  return {
    ...actual,
    listSkills: vi.fn(async (target: { workspaceId?: string } = {}) => {
      if (backend.unavailable !== undefined) throw new actual.SkillsApiError(404, 'Skills are unavailable', { code: backend.unavailable });
      // Runtimes list a workspace's folder; without one only the library is read.
      const runtime = target.workspaceId ? backend.runtime.filter((skill) => !backend.pending.includes(skill.runtimeId!)) : [];
      return {
        skills: [...backend.library, ...backend.builtin, ...runtime].map(summary), errors: backend.errors, libraryAvailable: true, runtimes: backend.runtimes,
        ...(target.workspaceId && backend.pending.length ? { pending: backend.pending } : {}),
      };
    }),
    fetchSkillDetail: vi.fn(async (id: string) => {
      const entry = [...backend.library, ...backend.builtin, ...backend.runtime].find((item) => item.id === id);
      if (!entry) throw new actual.SkillsApiError(404, 'Skill not found', { code: 'not_found' });
      return entry;
    }),
    createLibrarySkill: vi.fn(async (name: string, input: { content: string }) => {
      const created = withDescription(librarySkill(name, input.content));
      backend.library.push(created);
      return summary(created);
    }),
    updateLibrarySkill: vi.fn(async (name: string, patch: { content?: string; enabled?: boolean; newName?: string }) => {
      const entry = find(name);
      if (patch.newName && backend.library.some((item) => item.name === patch.newName)) throw new actual.SkillsApiError(409, 'Taken', { code: 'name_taken' });
      if (patch.content !== undefined) entry.content = patch.content;
      if (patch.enabled !== undefined) entry.enabled = patch.enabled;
      if (patch.newName) Object.assign(entry, { id: `library:${patch.newName}`, name: patch.newName, path: `/home/me/.michi/skills/${patch.newName}/SKILL.md` });
      return summary(withDescription(entry));
    }),
    setBuiltinSkillEnabled: vi.fn(async (name: string, enabled: boolean) => {
      const entry = backend.builtin.find((item) => item.name === name);
      if (!entry) throw new actual.SkillsApiError(404, 'Skill not found', { code: 'not_found' });
      entry.enabled = enabled;
      return summary(entry);
    }),
    deleteLibrarySkill: vi.fn(async (name: string) => {
      find(name);
      backend.library = backend.library.filter((item) => item.name !== name);
    }),
  };
});

function librarySkill(name: string, content: string, extra: Partial<SkillDetail> = {}): SkillDetail {
  return {
    id: `library:${name}`, name, description: '', origin: 'library', userInvocable: true, modelInvocable: true, enabled: true,
    path: `/home/me/.michi/skills/${name}/SKILL.md`, content, files: [], ...extra,
  };
}
function runtimeSkill(runtimeId: string, name: string, extra: Partial<SkillDetail> = {}): SkillDetail {
  return {
    id: `runtime:${runtimeId}:user:${name}`, name, description: `${name} description`, origin: 'runtime', runtimeId, scope: 'user',
    userInvocable: true, modelInvocable: true, enabled: true, path: `/home/me/.${runtimeId}/skills/${name}/SKILL.md`,
    content: `---\nname: ${name}\ndescription: ${name} description\n---\n\n# ${name}\n`, files: [], ...extra,
  };
}

const REVIEW = '---\nname: review-pr\ndescription: Reviews a pull request.\nargument-hint: "[pr-number]"\nlicense: MIT\n---\n\n# Review a pull request\n\nRead the diff first.\n';

vi.mock('../../../../state/chatStore', () => ({ useChatProjects: () => ({ projects: workspaces.projects, activeProject: null }) }));
const workspace = (id: string, name: string, cwd: string) => ({ id, name, cwd, chatIds: [], edges: [], trees: [], activeTreeId: null, createdAt: 1 });
vi.mock('../../../ui/ConfirmDialog', () => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

/** The pane with its Settings header action, as SettingsMain shows it in the window. */
function Host() {
  const [action, setAction] = React.useState<SettingsHeaderAction | null>(null);
  return <SettingsHeaderActionContext.Provider value={setAction}>
    {action && <button type="button" onClick={action.onClick}>{action.label}</button>}
    <SkillsPane />
  </SettingsHeaderActionContext.Provider>;
}

const group = (name: RegExp | string) => screen.getByRole('region', { name });
/** What a screen reader reads after the element's name. */
const description = (element: Element) => (element.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
const rowNames = (region: HTMLElement) => within(region).queryAllByRole('button').filter((button) => button.hasAttribute('data-history-open')).map((button) => button.getAttribute('aria-label'));

async function openSkill(name: string, region = /^Library/) {
  fireEvent.click(within(await screen.findByRole('region', { name: region })).getByRole('button', { name }));
  await screen.findByRole('heading', { level: 1, name });
  // Its file has loaded.
  await screen.findByRole('button', { name: 'View source' });
}

beforeEach(() => {
  vi.clearAllMocks();
  backend.library = [librarySkill('review-pr', REVIEW, { description: 'Reviews a pull request.', argumentHint: '[pr-number]', files: ['references/checklist.md'] })];
  backend.builtin = [];
  backend.runtime = [
    ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((letter) => runtimeSkill('claude', `skill-${letter}`)),
    runtimeSkill('claude', 'agent-sop-author', { scope: 'plugin', pluginId: 'ExampleTools@example', managedBy: 'Plugin manager', nativeName: 'ExampleTools:agent-sop-author' }),
    runtimeSkill('codex', 'explain', { scope: 'repo', description: 'Explains code.' }),
  ];
  backend.runtimes = [
    { id: 'claude', label: 'Claude', available: true },
    { id: 'codex', label: 'Codex', available: true },
    { id: 'pi', label: 'Pi', available: false },
  ];
  backend.errors = [];
  backend.pending = [];
  backend.unavailable = undefined;
  workspaces.projects = [workspace('ws-a', 'Alpha', '/repo')];
});
afterEach(() => { vi.useRealTimers(); });

describe('Settings › Skills', () => {
  it('lists the library and each runtime’s skills, by source, a few at a time', async () => {
    render(<Host />);
    const library = await screen.findByRole('region', { name: /^Library/ });
    expect(rowNames(library)).toEqual(['review-pr']);
    expect(within(library).getByText('/home/me/.michi/skills')).toBeTruthy();
    const claude = group(/^Claude/);
    // Five of Claude's eight under All sources; its plugin skill names the plugin.
    expect(rowNames(claude)).toEqual(['agent-sop-author', 'skill-a', 'skill-b', 'skill-c', 'skill-d']);
    expect(within(claude).getByText('Plugin · ExampleTools')).toBeTruthy();
    fireEvent.click(within(claude).getByRole('button', { name: 'Show 3 more' }));
    expect(rowNames(group(/^Claude/))).toHaveLength(8);
    // Focus moves to the first row it showed.
    await waitFor(() => expect(document.activeElement).toBe(within(group(/^Claude/)).getByRole('button', { name: 'skill-e' })));
    expect(within(group(/^Codex/)).getByText('Repo')).toBeTruthy();
    expect(screen.getByText('Pi isn’t set up on this machine.')).toBeTruthy();

    const sourceSelect = screen.getByRole('combobox', { name: 'Source' });
    expect(within(sourceSelect).getAllByRole('option').map((option) => option.textContent))
      .toEqual(['All sources · 10', 'Library · 1', 'Claude · 8', 'Codex · 1']);
    fireEvent.change(sourceSelect, { target: { value: 'codex' } });
    expect(screen.queryByRole('region', { name: /^Library/ })).toBeNull();
    expect(screen.queryByRole('region', { name: /^Claude/ })).toBeNull();
    expect(rowNames(group(/^Codex/))).toEqual(['explain']);

    fireEvent.change(sourceSelect, { target: { value: 'all' } });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search skills' }), { target: { value: 'pull request' } });
    expect(rowNames(group(/^Library/))).toEqual(['review-pr']);
    expect(rowNames(group(/^Runtime skills/))).toEqual([]);
    expect(within(group(/^Library/)).getByText(/pull request/i, { selector: 'mark' }).className).toBe('search-mark');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search skills' }), { target: { value: 'zebra' } });
    expect(screen.getByRole('heading', { name: 'No matching skills' })).toBeTruthy();
  });

  it('tells a runtime that couldn’t list from one with a few unreadable skills', async () => {
    backend.runtime = backend.runtime.filter((skill) => skill.runtimeId !== 'codex');
    backend.errors = [
      { runtimeId: 'codex', message: 'its app-server is restarting', failed: true },
      { runtimeId: 'claude', message: 'Claude plugin broken: manifest is invalid.' },
    ];
    render(<Host />);
    // No count for a runtime that couldn't say.
    const codex = await screen.findByRole('region', { name: 'Codex' });
    expect(within(codex).getByRole('alert').textContent).toBe('Couldn’t list Codex skills: its app-server is restarting.');
    expect(within(screen.getByRole('combobox', { name: 'Source' })).getByRole('option', { name: 'Codex · —' })).toBeTruthy();
    const claude = group(/^Claude/);
    expect(within(claude).getByText('Claude plugin broken: manifest is invalid.')).toBeTruthy();
    expect(within(claude).queryByRole('alert')).toBeNull();
    expect(within(claude).queryByRole('button', { name: 'Try again' })).toBeNull();
    fireEvent.click(within(codex).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listSkills).toHaveBeenCalledTimes(2));
    // ↻ says all is up to date only when every runtime listed; a few unreadable skills don't stop it.
    const refresh = screen.getByRole('button', { name: 'Check the runtimes for new skills' });
    fireEvent.click(refresh);
    expect(listSkills).toHaveBeenLastCalledWith(expect.objectContaining({ refresh: true }));
    await waitFor(() => expect(refresh.hasAttribute('aria-busy')).toBe(false));
    expect(toast.success).not.toHaveBeenCalled();
    backend.errors = backend.errors.filter((entry) => !entry.failed);
    fireEvent.click(refresh);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Runtime skills are up to date'));
  });

  it('shows the library at once while a runtime is still listing, and asks again until it answers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    backend.pending = ['claude'];
    render(<Host />);
    expect(rowNames(await screen.findByRole('region', { name: /^Library/ }))).toEqual(['review-pr']);
    const claude = group('Claude');
    expect(within(claude).getByRole('status').textContent).toBe('Listing Claude skills…');
    expect(rowNames(group(/^Codex/))).toEqual(['explain']);
    expect(within(screen.getByRole('combobox', { name: 'Source' })).getByRole('option', { name: 'Claude · …' })).toBeTruthy();
    // ↻ waits for the runtime still listing before it says all is up to date; the retry doesn't replace it.
    const listed = vi.mocked(listSkills).getMockImplementation()!;
    let land!: () => void;
    vi.mocked(listSkills).mockImplementationOnce((target) => new Promise((resolve) => { land = () => resolve(listed(target)); }));
    fireEvent.click(screen.getByRole('button', { name: 'Check the runtimes for new skills' }));
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(listSkills).toHaveBeenCalledTimes(2);
    expect(vi.mocked(listSkills).mock.calls[1][0]).toMatchObject({ refresh: true });
    expect(vi.mocked(listSkills).mock.calls[1][0]?.signal?.aborted).toBe(false);
    await act(async () => { land(); });
    expect(toast.success).not.toHaveBeenCalled();
    backend.pending = [];
    await act(async () => { vi.advanceTimersByTime(2_000); });
    await waitFor(() => expect(rowNames(group(/^Claude/))).toHaveLength(5));
    expect(listSkills).toHaveBeenCalledTimes(3);
    expect(toast.success).toHaveBeenCalledWith('Runtime skills are up to date');
  });

  it('keeps the toolbar, the library and focus on the Workspace select while another workspace loads or fails', async () => {
    workspaces.projects = [workspace('ws-a', 'Alpha', '/repo'), workspace('ws-b', 'Beta', '/beta')];
    render(<Host />);
    await screen.findByRole('region', { name: /^Claude/ });
    const select = within(group(/^Runtime skills/)).getByRole('combobox');
    select.focus();
    let fail!: (error: Error) => void;
    vi.mocked(listSkills).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    fireEvent.change(select, { target: { value: 'ws-b' } });
    const runtimes = group(/^Runtime skills/);
    expect(within(runtimes).getByRole('status', { name: 'Loading runtime skills…' })).toBeTruthy();
    expect(rowNames(group(/^Library/))).toEqual(['review-pr']);
    expect(screen.getByRole('searchbox', { name: 'Search skills' })).toBeTruthy();
    expect(document.activeElement).toBe(select);
    await act(async () => { fail(new Error('Backend unreachable')); });
    expect(within(runtimes).getByRole('alert').textContent).toContain('Couldn’t load skills: Backend unreachable.');
    expect(document.activeElement).toBe(select);
    fireEvent.click(within(runtimes).getByRole('button', { name: 'Try again' }));
    expect(rowNames(await screen.findByRole('region', { name: /^Codex/ }))).toEqual(['explain']);
    expect(listSkills).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: 'ws-b' }));
    // A search the next workspace doesn't match leaves the select where it was.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search skills' }), { target: { value: 'explain' } });
    backend.runtime = backend.runtime.filter((skill) => skill.runtimeId !== 'codex');
    fireEvent.change(select, { target: { value: 'ws-a' } });
    expect(await within(group(/^Runtime skills/)).findByRole('heading', { name: 'No matching skills' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: /^Library/ })).toBeNull();
    expect(document.activeElement).toBe(select);
  });

  it('says runtime skills are a workspace folder’s when there is no workspace', async () => {
    workspaces.projects = [];
    render(<Host />);
    expect(rowNames(await screen.findByRole('region', { name: /^Library/ }))).toEqual(['review-pr']);
    expect(within(group(/^Runtime skills/)).getByText('Runtime skills are listed for a workspace’s folder. Create a workspace to see them.')).toBeTruthy();
    expect(within(screen.getByRole('combobox', { name: 'Source' })).getAllByRole('option').map((option) => option.textContent))
      .toEqual(['All sources · 1', 'Library · 1']);
    expect(screen.queryByText(/set up on this machine/)).toBeNull();
  });

  it('opens a library skill, turns it off, and returns to its row', async () => {
    render(<Host />);
    await openSkill('review-pr');
    expect(screen.getByText('Library skill')).toBeTruthy();
    const details = screen.getByRole('region', { name: 'Details' });
    expect(within(details).getByText('/review-pr')).toBeTruthy();
    expect(within(details).getByText('[pr-number]')).toBeTruthy();
    expect(await within(details).findByText('references/checklist.md')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Review a pull request' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'View source' }));
    expect(screen.getByText(/license: MIT/)).toBeTruthy();
    // A page in a detail has no New skill.
    expect(screen.queryByRole('button', { name: 'New skill' })).toBeNull();

    fireEvent.click(screen.getByRole('switch', { name: 'Enabled' }));
    await waitFor(() => expect(updateLibrarySkill).toHaveBeenCalledWith('review-pr', { enabled: false }, { backendConnectionId: 'local' }));
    expect(await screen.findByText('Library skill · Off')).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith('review-pr is off · it’s out of the / menu');

    fireEvent.keyDown(screen.getByRole('heading', { level: 1, name: 'review-pr' }), { key: 'Escape' });
    const row = within(await screen.findByRole('region', { name: /^Library/ })).getByRole('button', { name: 'review-pr' });
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(row.closest('li')?.textContent).toContain('Off');
    expect(description(row)).toContain('Off');
  });

  it('lists Michi’s built-in skills on their own, read only, and only turns one off', async () => {
    backend.builtin = [{
      id: 'builtin:compare', name: 'compare', description: 'Ask several models.', origin: 'builtin', argumentHint: '<question>',
      userInvocable: true, modelInvocable: false, managedBy: 'Michi', enabled: true, files: [],
      content: '---\nname: compare\ndescription: Ask several models.\n---\n\n# Compare\n',
    }];
    render(<Host />);
    expect(rowNames(await screen.findByRole('region', { name: /^Built-in/ }))).toEqual(['compare']);
    expect(rowNames(group(/^Library/))).toEqual(['review-pr']);
    const sourceSelect = screen.getByRole('combobox', { name: 'Source' });
    expect(within(sourceSelect).getByRole('option', { name: 'Built-in · 1' })).toBeTruthy();
    fireEvent.change(sourceSelect, { target: { value: 'builtin' } });
    expect(screen.queryByRole('region', { name: /^Library/ })).toBeNull();
    expect(screen.queryByRole('region', { name: /^Runtime skills/ })).toBeNull();

    await openSkill('compare', /^Built-in/);
    expect(screen.getByText('Built-in skill')).toBeTruthy();
    expect(screen.getByText('Read only')).toBeTruthy();
    const details = screen.getByRole('region', { name: 'Details' });
    expect(within(details).getByText('/compare')).toBeTruthy();
    expect(within(details).getByText('Ships with Michi')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Edit|Rename|Delete/ })).toBeNull();
    expect(screen.getByText('It’s in the / menu. Agents don’t load it on their own.')).toBeTruthy();

    fireEvent.click(screen.getByRole('switch', { name: 'Enabled' }));
    await waitFor(() => expect(setBuiltinSkillEnabled).toHaveBeenCalledWith('compare', false, { backendConnectionId: 'local' }));
    expect(await screen.findByText('Built-in skill · Off')).toBeTruthy();
    expect(updateLibrarySkill).not.toHaveBeenCalled();
  });

  it('shows a runtime’s skill read only, by the command that runs it', async () => {
    render(<Host />);
    fireEvent.click(within(await screen.findByRole('region', { name: /^Claude/ })).getByRole('button', { name: 'agent-sop-author' }));
    await screen.findByRole('heading', { level: 1, name: 'agent-sop-author' });
    expect(screen.getByText('Claude · Plugin · ExampleTools')).toBeTruthy();
    expect(screen.getByText('Read only')).toBeTruthy();
    expect(screen.getByText('/ExampleTools:agent-sop-author')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Edit|Rename|Delete/ })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('doesn’t say agents load a skill that neither agents nor the / menu use', async () => {
    backend.library.push(librarySkill('kept-aside', '---\nname: kept-aside\ndescription: Kept.\nuser-invocable: false\ndisable-model-invocation: true\n---\n\nLater.\n',
      { description: 'Kept.', userInvocable: false, modelInvocable: false }));
    render(<Host />);
    await openSkill('kept-aside');
    expect(screen.getByText('Agents don’t load it on their own, and it isn’t in the / menu.')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Details' })).getByText('None.')).toBeTruthy();
  });

  it('creates a skill once each field is right', async () => {
    render(<Host />);
    fireEvent.click(await screen.findByRole('button', { name: 'New skill' }));
    const form = screen.getByRole('form', { name: 'New skill' });
    const name = within(form).getByRole('textbox', { name: 'Name' });
    fireEvent.click(within(form).getByRole('button', { name: 'Create skill' }));
    expect(within(form).getByText('Give the skill a name.')).toBeTruthy();
    expect(within(form).getByText('Add a description: agents use it to decide when this skill fits.')).toBeTruthy();
    expect(within(form).getByText('Write the instructions the agent should follow.')).toBeTruthy();
    expect(document.activeElement).toBe(name);
    fireEvent.change(name, { target: { value: 'Release Notes' } });
    expect(within(form).getByText('Use lowercase letters, digits and single hyphens, up to 64 characters.')).toBeTruthy();
    fireEvent.change(name, { target: { value: 'review-pr' } });
    expect(within(form).getByText('A skill named review-pr is already in your library.')).toBeTruthy();
    fireEvent.change(name, { target: { value: 'release-notes' } });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Description' }), { target: { value: 'Writes release notes.' } });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Argument hint' }), { target: { value: '[since-tag]' } });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Instructions' }), { target: { value: '# Release notes\n\nGroup the commits.' } });
    fireEvent.keyDown(name, { key: 'Enter', ctrlKey: true });
    await screen.findByRole('heading', { level: 1, name: 'release-notes' });
    expect(createLibrarySkill).toHaveBeenCalledWith('release-notes', {
      content: '---\nname: release-notes\ndescription: "Writes release notes."\nargument-hint: "[since-tag]"\n---\n\n# Release notes\n\nGroup the commits.\n',
    }, { backendConnectionId: 'local' });
    expect(toast.success).toHaveBeenCalledWith('release-notes created · /release-notes is in the / menu');
  });

  it('leaves Escape and ⌘/Ctrl+Enter to an input method while it composes, and keeps Settings open', async () => {
    const closeSettings = vi.fn();
    render(<ModalShell open onClose={closeSettings} title="Settings" width={1080} layer="window"><Host /></ModalShell>);
    fireEvent.click(await screen.findByRole('button', { name: 'New skill' }));
    const instructions = within(screen.getByRole('form', { name: 'New skill' })).getByRole('textbox', { name: 'Instructions' });
    fireEvent.change(instructions, { target: { value: '写发布说明' } });
    fireEvent.keyDown(instructions, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(instructions, { key: 'Escape', keyCode: 229 });
    fireEvent.keyDown(instructions, { key: 'Enter', ctrlKey: true, isComposing: true });
    expect(screen.getByRole('form', { name: 'New skill' })).toBeTruthy();
    expect(within(screen.getByRole('form', { name: 'New skill' })).queryByText('Give the skill a name.')).toBeNull();
    expect(closeSettings).not.toHaveBeenCalled();
    fireEvent.keyDown(instructions, { key: 'Escape' });
    expect(screen.queryByRole('form', { name: 'New skill' })).toBeNull();
    expect(closeSettings).not.toHaveBeenCalled();
  });

  it('edits a skill’s fields and keeps its other frontmatter', async () => {
    render(<Host />);
    await openSkill('review-pr');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit review-pr' });
    expect(within(form).queryByRole('textbox', { name: 'Name' })).toBeNull();
    expect((within(form).getByRole('textbox', { name: 'Argument hint' }) as HTMLInputElement).value).toBe('[pr-number]');
    fireEvent.change(within(form).getByRole('textbox', { name: 'Description' }), { target: { value: 'Reviews a PR for correctness.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await screen.findByRole('heading', { level: 1, name: 'review-pr' });
    const content = vi.mocked(updateLibrarySkill).mock.calls[0][1].content!;
    expect(content).toContain('description: "Reviews a PR for correctness."');
    expect(content).toContain('license: MIT');
    expect(content).toContain('# Review a pull request');
  });

  it('renames a skill, refusing a name the library has', async () => {
    backend.library.push(librarySkill('weekly-report', '---\nname: weekly-report\ndescription: Drafts my report.\n---\n\nWrite it.\n'));
    render(<Host />);
    await openSkill('review-pr');
    fireEvent.click(screen.getByRole('button', { name: 'Rename…' }));
    const dialog = await screen.findByRole('dialog', { name: /Rename skill/i });
    const input = within(dialog).getByRole('textbox', { name: 'New name' });
    fireEvent.change(input, { target: { value: 'weekly-report' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('A skill named weekly-report is already in your library.');
    fireEvent.change(input, { target: { value: 'pr-review' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await screen.findByRole('heading', { level: 1, name: 'pr-review' });
    expect(updateLibrarySkill).toHaveBeenCalledWith('review-pr', { newName: 'pr-review', content: REVIEW.replace('name: review-pr', 'name: pr-review') }, { backendConnectionId: 'local' });
  });

  it('deletes a skill after asking', async () => {
    render(<Host />);
    await openSkill('review-pr');
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    await waitFor(() => expect(deleteLibrarySkill).toHaveBeenCalledWith('review-pr', { backendConnectionId: 'local' }));
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Delete skill?', message: '“review-pr” and its folder will be deleted from /home/me/.michi/skills. This can’t be undone.',
    }));
    expect(await screen.findByRole('heading', { name: 'No skills in your library' })).toBeTruthy();
  });

  it('reads the listing again when the window returns or the library changes, keeping the open skill', async () => {
    render(<Host />);
    await openSkill('review-pr');
    // Coming back to the window fires both; one read answers them.
    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(listSkills).toHaveBeenCalledTimes(2));
    act(() => { window.dispatchEvent(new CustomEvent(SKILLS_CHANGED_EVENT)); });
    await waitFor(() => expect(listSkills).toHaveBeenCalledTimes(3));
    expect(screen.getByRole('heading', { level: 1, name: 'review-pr' })).toBeTruthy();
  });

  it('says when this backend has no Skills, and offers no New skill', async () => {
    backend.unavailable = null;
    const view = render(<Host />);
    expect(await screen.findByText('This Michi backend doesn’t support Skills yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New skill' })).toBeNull();
    // Another workspace may live on a backend that has them.
    expect(screen.getByRole('searchbox', { name: 'Search skills' })).toBeTruthy();
    expect(within(group(/^Runtime skills/)).getByRole('combobox')).toBeTruthy();
    view.unmount();
    backend.unavailable = 'skills_unavailable';
    render(<Host />);
    expect(await screen.findByText('This Michi server keeps no skill library.')).toBeTruthy();
  });
});
