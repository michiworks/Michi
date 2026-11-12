import { useCallback, useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from 'react';
import { toast } from 'sonner';
import { copyWorkspaceFile, getWebUploadCwd, importWorkspaceFileUpload, type UploadProgress } from '../../services/api';
import { getElectron } from '../../lib/electronBridge';
import { openFilePicker } from '../../hooks/useKeyboardDismiss';
import type { UploadProgressViewState } from '../UploadProgressBar';
import type { PanePendingAttachment } from './PaneComposerPreBlocks';
import { longPastedText, savePastedText } from './pastedTextAttachment';
import { isLocalProject } from '../../config/backendConnections';

type AttachmentWorkspace = { id: string; cwd?: string; backendConnectionId?: string };
type ImportedAttachment = { abs: string; displayName?: string; relPath?: string };

function absPathIn(cwd: string, filePath: string): string {
  return filePath.startsWith('/') ? filePath : `${cwd.replace(/\/$/, '')}/${filePath}`;
}

/** Pasted images often arrive as "image.png" or without an extension: take
 *  the extension from the MIME type and add a timestamp so pastes don't collide. */
function pastedAttachmentName(file: File): string {
  const nameExtMatch = file.name && file.name.match(/\.[a-zA-Z0-9]{1,8}$/);
  const ext = nameExtMatch
    ? nameExtMatch[0]
    : (file.type && file.type.startsWith('image/')
        ? `.${file.type.slice('image/'.length).split(';')[0] || 'png'}`
        : '');
  const stem = (file.name && file.name.replace(/\.[a-zA-Z0-9]{1,8}$/, '')) || 'pasted';
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${stem}-${ts}${ext}`;
}

function toastFailures(errors: readonly string[], noun: 'file' | 'paste') {
  if (errors.length === 0) return;
  toast.error(
    `${errors.length} ${noun}${errors.length === 1 ? '' : 's'} failed`,
    { description: errors.join('\n'), style: { whiteSpace: 'pre-line' } },
  );
}

/**
 * A composer's pending attachments and the ways files reach them: drop,
 * paste (files, or long text saved as a .txt), and the file picker. Files
 * are imported into the workspace's .attachments/ folder. A restricted
 * composer (the assistant) takes no files.
 */
export function useComposerAttachments(workspace: AttachmentWorkspace | null | undefined, { restricted = false } = {}) {
  const [pending, setPending] = useState<PanePendingAttachment[]>([]);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressViewState | null>(null);
  const workspaceId = workspace?.id;
  const workspaceCwd = workspace?.cwd;
  const remote = !!workspace && !isLocalProject(workspace);

  const addPending = useCallback((items: ReadonlyArray<string | ImportedAttachment>, inWorkspaceId?: string) => {
    if (items.length === 0) return;
    setPending((prev) => {
      const have = new Set(prev.map((p) => p.absPath));
      const next = [...prev];
      for (const item of items) {
        const abs = typeof item === 'string' ? item : item.abs;
        const override = typeof item === 'string' ? undefined : item.displayName;
        const relPath = typeof item === 'string' ? undefined : item.relPath;
        if (have.has(abs)) continue;
        next.push({
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: override || abs.split('/').pop() || abs,
          absPath: abs,
          relPath,
          ...(inWorkspaceId ? { workspaceId: inWorkspaceId } : {}),
        });
        have.add(abs);
      }
      return next;
    });
  }, []);

  const removePending = useCallback((id: string) => {
    setPending((prev) => prev.filter((x) => x.id !== id));
  }, []);

  // A workspace with a folder imports there. Web mode (or a workspace
  // without a cwd) uses a backend-allocated upload directory. Null when
  // there is no workspace.
  const resolveCwd = useCallback(async (): Promise<string | null> => {
    if (workspaceCwd) return workspaceCwd;
    if (!workspaceId) return null;
    return getWebUploadCwd(workspaceId);
  }, [workspaceCwd, workspaceId]);

  const uploadFiles = useCallback(async (files: readonly File[], noun: 'file' | 'paste') => {
    const items: ImportedAttachment[] = [];
    const errors: string[] = [];
    for (const [fileIndex, file] of files.entries()) {
      const label = file.name || 'pasted file';
      try {
        const cwd = await resolveCwd();
        if (!cwd || !workspaceId) {
          errors.push(`${label}: no workspace folder`);
          continue;
        }
        const fileName = noun === 'paste' ? pastedAttachmentName(file) : file.name;
        const result = await importWorkspaceFileUpload(workspaceId, cwd, file, {
          ...(noun === 'paste' ? { originalName: fileName } : {}),
          onProgress: (progress: UploadProgress) => setUploadProgress({
            fileName, fileIndex, fileCount: files.length, phase: progress.phase, percent: progress.percent,
          }),
          subdir: '.attachments',
        });
        items.push({ abs: absPathIn(cwd, result.filePath), displayName: result.displayName || fileName, relPath: result.filePath });
      } catch (err) {
        errors.push(`${label}: ${(err as Error).message}`);
      }
    }
    setUploadProgress(null);
    addPending(items, workspaceId);
    toastFailures(errors, noun);
  }, [addPending, resolveCwd, workspaceId]);

  /** Imports dropped or forwarded files. False when this composer takes none. */
  const attachFiles = useCallback(async (files: readonly File[]): Promise<boolean> => {
    if (restricted) return false;
    if (files.length > 0) await uploadFiles(files, 'file');
    return true;
  }, [restricted, uploadFiles]);

  const handlePaste = useCallback(async (e: ReactClipboardEvent) => {
    const dt = e.clipboardData;
    // In the assistant a paste is only text: no files, no long-text attachments.
    if (!dt || restricted) return;

    const longText = longPastedText(dt);
    if (longText) {
      e.preventDefault();
      try {
        const cwd = await resolveCwd();
        if (!cwd || !workspaceId) {
          toast.error('No workspace folder for text attachment');
          return;
        }
        addPending([await savePastedText(workspaceId, cwd, longText)], workspaceId);
      } catch (err) {
        toast.error('Failed to save pasted text as file', { description: (err as Error).message });
      }
      return;
    }

    const files: File[] = [];
    for (const item of Array.from(dt.items)) {
      if (item.kind !== 'file') continue;
      const f = item.getAsFile();
      if (f) files.push(f);
    }
    if (files.length === 0) return;
    e.preventDefault();
    await uploadFiles(files, 'paste');
  }, [addPending, resolveCwd, restricted, uploadFiles, workspaceId]);

  // The web picker's input outlives a render; its change handler reads the
  // latest upload path (and so the current workspace) through this ref.
  const uploadFilesRef = useRef(uploadFiles);
  uploadFilesRef.current = uploadFiles;
  const webFileInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => () => {
    webFileInputRef.current?.remove();
    webFileInputRef.current = null;
  }, [workspaceId]);

  const pickFiles = useCallback(async () => {
    const electron = getElectron();
    if (electron?.chooseFiles && !remote) {
      const res = await electron.chooseFiles();
      if (res.canceled || !res.paths?.length) return;
      const cwd = await resolveCwd();
      if (!cwd || !workspaceId) {
        toast.error('No workspace folder for file attachment');
        return;
      }
      const items: ImportedAttachment[] = [];
      const errors: string[] = [];
      for (const sourcePath of res.paths) {
        try {
          const result = await copyWorkspaceFile(workspaceId, cwd, sourcePath, { subdir: '.attachments' });
          items.push({
            abs: absPathIn(cwd, result.filePath),
            displayName: result.displayName || sourcePath.split('/').pop() || sourcePath,
            relPath: result.filePath,
          });
        } catch (err) {
          errors.push(`${sourcePath.split('/').pop() || sourcePath}: ${(err as Error).message}`);
        }
      }
      addPending(items, workspaceId);
      toastFailures(errors, 'file');
      return;
    }
    if (!webFileInputRef.current) {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.style.display = 'none';
      input.addEventListener('change', () => {
        const files = Array.from(input.files ?? []);
        input.value = '';
        if (files.length > 0) void uploadFilesRef.current(files, 'file');
      });
      document.body.appendChild(input);
      webFileInputRef.current = input;
    }
    openFilePicker(webFileInputRef.current);
  }, [addPending, remote, resolveCwd, workspaceId]);

  return { pending, setPending, addPending, removePending, uploadProgress, attachFiles, handlePaste, pickFiles, resolveCwd };
}
