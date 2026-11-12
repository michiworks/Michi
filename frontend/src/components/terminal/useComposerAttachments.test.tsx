import { act, renderHook } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importWorkspaceFile, importWorkspaceFileUpload } from '../../services/api';
import { useComposerAttachments } from './useComposerAttachments';

vi.mock('../../services/api', () => ({
  getWebUploadCwd: vi.fn(async () => '/uploads'),
  importWorkspaceFile: vi.fn(),
  importWorkspaceFileUpload: vi.fn(),
  copyWorkspaceFile: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const workspace = { id: 'ws1', cwd: '/w' };

function pasteEvent({ text = '', files = [] as File[] }) {
  const preventDefault = vi.fn();
  const clipboardData = {
    getData: (type: string) => (type === 'text/plain' ? text : ''),
    items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
  };
  return { event: { clipboardData, preventDefault } as unknown as React.ClipboardEvent, preventDefault };
}

describe('useComposerAttachments', () => {
  beforeEach(() => {
    vi.mocked(importWorkspaceFile).mockReset().mockResolvedValue({ filePath: '.attachments/pasted.txt' } as never);
    vi.mocked(importWorkspaceFileUpload).mockReset().mockResolvedValue({
      name: '__', filePath: '.attachments/__.png', displayName: '截图.png', size: 1,
    });
  });

  it('turns a paste of 10,000 characters into a .txt attachment', async () => {
    const { result } = renderHook(() => useComposerAttachments(workspace));
    const { event, preventDefault } = pasteEvent({ text: 'x'.repeat(10_000) });
    await act(async () => { await result.current.handlePaste(event); });
    expect(preventDefault).toHaveBeenCalled();
    expect(importWorkspaceFile).toHaveBeenCalledWith('ws1', '/w', expect.stringMatching(/^pasted-text-.*\.txt$/), 'x'.repeat(10_000), { subdir: '.attachments' });
    expect(result.current.pending).toEqual([expect.objectContaining({ absPath: '/w/.attachments/pasted.txt', relPath: '.attachments/pasted.txt' })]);
  });

  it('uploads a pasted image under a timestamped name and keeps the original name', async () => {
    const { result } = renderHook(() => useComposerAttachments(workspace));
    const { event } = pasteEvent({ files: [new File(['x'], 'image', { type: 'image/png' })] });
    await act(async () => { await result.current.handlePaste(event); });
    expect(importWorkspaceFileUpload).toHaveBeenCalledWith('ws1', '/w', expect.any(File), expect.objectContaining({
      originalName: expect.stringMatching(/^image-\d{4}-.*\.png$/), subdir: '.attachments',
    }));
    expect(result.current.pending).toEqual([expect.objectContaining({ name: '截图.png', relPath: '.attachments/__.png' })]);
  });

  it('takes no files when restricted, and leaves a paste as text', async () => {
    const { result } = renderHook(() => useComposerAttachments(workspace, { restricted: true }));
    const { event, preventDefault } = pasteEvent({ text: 'x'.repeat(10_000), files: [new File(['x'], 'a.png')] });
    let accepted = true;
    await act(async () => {
      await result.current.handlePaste(event);
      accepted = await result.current.attachFiles([new File(['x'], 'a.png')]);
    });
    expect(accepted).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(importWorkspaceFileUpload).not.toHaveBeenCalled();
    expect(result.current.pending).toEqual([]);
  });

  it('removes the web file picker on unmount, and its upload reads the current workspace', async () => {
    const { result, rerender, unmount } = renderHook(({ cwd }) => useComposerAttachments({ id: 'ws1', cwd }), { initialProps: { cwd: '/w' } });
    await act(async () => { await result.current.pickFiles(); });
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
    rerender({ cwd: '/moved' });
    Object.defineProperty(picker, 'files', { value: [new File(['x'], 'a.txt')], configurable: true });
    await act(async () => { picker.dispatchEvent(new Event('change')); });
    expect(importWorkspaceFileUpload).toHaveBeenCalledWith('ws1', '/moved', expect.any(File), expect.anything());
    unmount();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});
