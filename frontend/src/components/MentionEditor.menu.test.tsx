import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MentionEditor, { type MentionEditorHandle } from './MentionEditor';
import { buildSlashEntries, type SlashEntry } from '../state/slashEntries';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const detailTitle = () => document.querySelector('.michi-slash-detail-title')?.textContent;

async function openEditor(text: string, slash: { slashEntries?: readonly SlashEntry[]; onSlashOpen?: () => void; onSlashPick?: (entry: SlashEntry | null) => void;
  availableModes?: { id: string; name: string }[] } = {}) {
  const ref = createRef<MentionEditorHandle>();
  const onSubmit = vi.fn();
  const onChange = vi.fn();
  const view = render(<MentionEditor ref={ref} value="" mentions={[]} onChange={onChange} currentNodeId="current"
    sameTreeNodes={[]} onSubmit={onSubmit} {...slash}
    artifacts={[{ id: 'notes', name: 'Design notes', filePath: 'notes.md', source: 'user', createdAt: 1, updatedAt: 1 }]} />);
  await waitFor(() => expect(ref.current?.editor).toBeTruthy());
  await act(async () => { ref.current!.editor!.commands.insertContent(text); });
  await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
  return { ...view, editor: ref.current!.editor!, onSubmit, onChange };
}

describe('Composer autocomplete menus', () => {
  it.each(['@', '/br'])('filters %s implicitly and preserves confirmation feedback', async (text) => {
    const { editor, onSubmit } = await openEditor(text);
    expect(within(screen.getByRole('listbox')).queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
    const option = screen.getAllByRole('option')[0];
    if (text === '/br') expect(screen.getByText('Open this message as a new child thread.')).toBeTruthy();
    vi.useFakeTimers();
    fireEvent.mouseDown(option);
    expect(option.classList.contains('ui-menu-blink')).toBe(true);
    expect(editor.getText()).toBe(text);
    act(() => { vi.advanceTimersByTime(160); });
    expect(editor.getText()).toBe(text === '@' ? '@Design notes ' : '/branch ');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each(['@', '/br'])('cancels a pending %s selection when typing continues', async (text) => {
    const { editor } = await openEditor(text);
    vi.useFakeTimers();
    fireEvent.mouseDown(screen.getAllByRole('option')[0]);
    await act(async () => { editor.commands.insertContent('z'); });
    act(() => { vi.advanceTimersByTime(200); });
    expect(editor.getText()).toBe(`${text}z`);
  });

  it('lists /names only, describes the highlighted row beside them, tags a skill sharing a command\'s name, and records the pick', async () => {
    const onSlashOpen = vi.fn();
    const onSlashPick = vi.fn();
    const slashEntries = buildSlashEntries({
      runtimeId: 'claude',
      runtimeLabel: 'Claude Code',
      catalog: { commands: [{ name: 'review', description: 'Review the session' }, { name: 'status' }], skills: [
        { id: 'library:review', name: 'review', origin: 'library', description: 'Review a change', argumentHint: '<pr>',
          userInvocable: true, modelInvocable: true, enabled: true },
        { id: 'runtime:claude:plugin:core:packagebuild', name: 'packagebuild', nativeName: 'core:packagebuild', origin: 'runtime', runtimeId: 'claude',
          description: 'Build with PackageBuild', userInvocable: true, modelInvocable: true, enabled: true },
      ] },
    });
    const { editor, onSubmit } = await openEditor('/core:', { slashEntries, onSlashOpen, onSlashPick });
    expect(onSlashOpen).toHaveBeenCalledTimes(1);
    const [packagebuild] = screen.getAllByRole('option');
    expect(packagebuild.textContent).toBe('/core:packagebuild');
    // In the row the plugin part gives way first, after a slash that stays; the panel names it in full.
    expect(packagebuild.querySelector('.michi-slash-prefix')?.textContent).toBe('core');
    expect(packagebuild.querySelector('.michi-slash-leaf')?.textContent).toBe(':packagebuild');
    expect(detailTitle()).toBe('/core:packagebuild');
    expect(screen.getByText('Skill · Claude Code')).toBeTruthy();
    expect(screen.getByText('Build with PackageBuild')).toBeTruthy();

    await act(async () => { editor.commands.setContent('/rev'); });
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['/review', '/reviewSkill']);
    expect(within(options[0]).getByText('rev').className).toBe('michi-menu-match');
    expect(screen.getByText('Command')).toBeTruthy();
    expect(detailTitle()).toBe('/review');
    fireEvent.mouseEnter(options[1]);
    expect(screen.getByText('Skill · Michi')).toBeTruthy();
    expect(detailTitle()).toBe('/review <pr>');
    vi.useFakeTimers();
    fireEvent.mouseDown(options[1]);
    act(() => { vi.advanceTimersByTime(160); });
    expect(editor.getText()).toBe('/review ');
    expect(onSlashPick).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'review', skill: expect.objectContaining({ id: 'library:review' }) }));
    await act(async () => { editor.commands.setContent('/reviews'); });
    expect(onSlashPick).toHaveBeenLastCalledWith(null);

    // A row with nothing to complete sends on Enter, as picked.
    vi.useRealTimers();
    await act(async () => { editor.commands.setContent('/status'); });
    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith({ branch: false });
    expect(onSlashPick).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'status', source: 'runtime' }));
  });

  it('puts each description in its row on a touch screen, with no panel, and keeps the highlight where a tap\'s hover lands', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('pointer: coarse'), media: query,
      addEventListener() {}, removeEventListener() {} }));
    const slashEntries = buildSlashEntries({ runtimeId: 'claude', catalog: { commands: [{ name: 'status', description: 'Show status' }], skills: [] } });
    const { editor } = await openEditor('/st', { slashEntries });
    const [status] = screen.getAllByRole('option');
    expect(within(status).getByText('Show status')).toBeTruthy();
    expect(document.querySelector('.michi-slash-detail')).toBeNull();
    await act(async () => { editor.commands.setContent('/'); });
    const options = screen.getAllByRole('option');
    const selected = () => options.map((option) => option.getAttribute('aria-selected'));
    const before = selected();
    fireEvent.mouseEnter(options[3]);
    expect(selected()).toEqual(before);
  });

  it('opens the agent picker after the /agent command, not after a skill row of that name', async () => {
    const slashEntries = buildSlashEntries({ runtimeId: 'kiro', catalog: { commands: [], skills: [
      { id: 'library:agent', name: 'agent', origin: 'library', description: 'Plan an agent', userInvocable: true, modelInvocable: true, enabled: true },
    ] } });
    const { editor } = await openEditor('/agent', { slashEntries, availableModes: [{ id: 'vibe', name: 'vibe' }] });
    vi.useFakeTimers();
    for (const [row, picker] of [[0, true], [1, false]] as const) {
      await act(async () => { editor.commands.setContent('/agent'); });
      fireEvent.mouseDown(screen.getAllByRole('option')[row]);
      act(() => { vi.advanceTimersByTime(160); });
      expect(editor.getText()).toBe('/agent ');
      expect(screen.queryAllByRole('option').map((option) => option.textContent)).toEqual(picker ? ['vibe'] : []);
      // The agent list has no panel beside it and is as wide as its rows want.
      if (picker) expect(screen.getByRole('listbox').style).toMatchObject({ width: '', maxWidth: 'min(480px, calc(100vw - 16px))' });
    }
  });
});

describe('@ menu row motion', () => {
  const artifact = (id: string, name: string) => ({ id, name, filePath: `${id}.md`, source: 'user' as const, createdAt: 1, updatedAt: 1 });

  async function filterAndCountSlides() {
    const animate = vi.fn();
    const offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get(this: HTMLElement) { return this.parentElement ? [...this.parentElement.children].indexOf(this) * 20 : 0; },
    });
    const elementAnimate = Element.prototype.animate;
    Element.prototype.animate = animate as unknown as Element['animate'];
    try {
      const ref = createRef<MentionEditorHandle>();
      render(<MentionEditor ref={ref} value="" mentions={[]} onChange={() => {}} currentNodeId="current"
        sameTreeNodes={[]} onSubmit={() => {}}
        artifacts={[artifact('alpha', 'Alpha notes'), artifact('beta', 'Beta notes'), artifact('gamma', 'Gamma plan')]} />);
      await waitFor(() => expect(ref.current?.editor).toBeTruthy());
      await act(async () => { ref.current!.editor!.commands.insertContent('@'); });
      await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(1));
      const before = screen.getAllByRole('option').length;
      await act(async () => { ref.current!.editor!.commands.insertContent('Gam'); });
      await waitFor(() => expect(screen.getAllByRole('option').length).toBeLessThan(before));
      return animate.mock.calls.length;
    } finally {
      Element.prototype.animate = elementAnimate;
      if (offsetTop) Object.defineProperty(HTMLElement.prototype, 'offsetTop', offsetTop);
    }
  }

  afterEach(() => { delete document.documentElement.dataset.reduceMotion; });

  it('lets the remaining rows ride up when a row above stops matching', async () => {
    expect(await filterAndCountSlides()).toBeGreaterThan(0);
  });

  it('keeps the rows still under Michi\'s Reduce motion with the OS setting off', async () => {
    document.documentElement.dataset.reduceMotion = 'on';
    expect(await filterAndCountSlides()).toBe(0);
  });
});
