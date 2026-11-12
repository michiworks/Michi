import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import FolderList from './FolderList';
import type { FolderEntry } from '../../../state/chatTypes';

const electron = vi.hoisted(() => ({ current: null as null | { chooseFolders: () => Promise<{ canceled: boolean; folders: { path: string; name: string }[] }> } }));
vi.mock('../../../lib/electronBridge', () => ({ getElectron: () => electron.current }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const folders: FolderEntry[] = [
  { id: 'f0', path: '/code/web', addedAt: 0 },
  { id: 'f1', path: '/code/docs', addedAt: 1 },
];

function renderList() {
  const onUpdateLabel = vi.fn();
  render(<FolderList folders={folders} projectId="p1" onAddFolder={vi.fn()} onRemoveFolder={vi.fn()} onUpdateLabel={onUpdateLabel} />);
  fireEvent.click(screen.getByText('docs'));
  return { onUpdateLabel, field: screen.getByRole('textbox') as HTMLInputElement };
}

describe('FolderList label', () => {
  it('saves nothing when the label is left as it was', () => {
    const { onUpdateLabel, field } = renderList();
    expect(field.value).toBe('docs');
    fireEvent.blur(field);
    expect(onUpdateLabel).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('saves a new label, trimmed, on Enter', () => {
    const { onUpdateLabel, field } = renderList();
    fireEvent.change(field, { target: { value: '  Docs site ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onUpdateLabel).toHaveBeenCalledExactlyOnceWith('p1', 'f1', 'Docs site');
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])('leaves Enter and Esc that end an IME composition to the field (%o)', (ime) => {
    const { onUpdateLabel, field } = renderList();
    fireEvent.change(field, { target: { value: '文档' } });
    fireEvent.keyDown(field, { key: 'Enter', ...ime });
    fireEvent.keyDown(field, { key: 'Escape', ...ime });
    expect(onUpdateLabel).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toBe(field);
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(onUpdateLabel).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('FolderList adding folders', () => {
  afterEach(() => { electron.current = null; vi.mocked(toast.error).mockClear(); });

  it('counts only the picks it adds against the limit', async () => {
    const eight: FolderEntry[] = Array.from({ length: 8 }, (_, i) => ({ id: `f${i}`, path: `/w/${i}`, addedAt: i }));
    electron.current = {
      chooseFolders: async () => ({ canceled: false, folders: [
        { path: '/w/0', name: '0' }, { path: '/w/1/sub', name: 'sub' }, { path: '/new', name: 'new' },
      ] }),
    };
    const onAddFolder = vi.fn();
    render(<FolderList folders={eight} projectId="p1" onAddFolder={onAddFolder} onRemoveFolder={vi.fn()} onUpdateLabel={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByText('+ Add folder')); });
    expect(onAddFolder).toHaveBeenCalledExactlyOnceWith('p1', '/new', 'new');
    expect(vi.mocked(toast.error).mock.calls.flat().some((message) => String(message).startsWith('Maximum'))).toBe(false);
  });
});
