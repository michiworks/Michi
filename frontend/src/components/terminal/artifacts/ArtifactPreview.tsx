import React, { useEffect, useRef, useState } from 'react';
import type { ArtifactEntry } from '../../../state/chatTypes';
import { ArtifactReadError, fetchArtifactContent } from '../../../services/api/artifacts';
import { Button } from '../../ui/controls';
import { artifactPreviewSrcdoc } from './artifactPreviewDocument';

type View =
  | { kind: 'loading' }
  | { kind: 'ready'; srcdoc: string }
  | { kind: 'missing' }
  | { kind: 'failed'; message: string }
  /** The page loaded a second document: a link or a script took it elsewhere. */
  | { kind: 'left' };

/**
 * An HTML artifact, shown in the Artifacts drawer in place of a download. The
 * file's text comes through the workspace read route and runs in a sandboxed
 * frame (artifactPreviewDocument.ts says what that frame can and can't do).
 */
export function ArtifactPreview({ workspaceId, artifact, label, knownMissing, onDownload, onRemove }: {
  workspaceId: string;
  artifact: ArtifactEntry;
  /** The name the row showed, for the frame's accessible title. */
  label: string;
  /** The drawer already found the file gone; don't ask again. */
  knownMissing: boolean;
  onDownload: () => void;
  onRemove: () => void;
}) {
  const [view, setView] = useState<View>(() => (knownMissing ? { kind: 'missing' } : { kind: 'loading' }));
  const [attempt, setAttempt] = useState(0);
  const loads = useRef(0);
  const { filePath, updatedAt } = artifact;

  useEffect(() => {
    if (knownMissing) {
      setView({ kind: 'missing' });
      return;
    }
    const controller = new AbortController();
    setView({ kind: 'loading' });
    fetchArtifactContent(workspaceId, filePath, false, controller.signal).then(
      (file) => {
        if (controller.signal.aborted) return;
        loads.current = 0;
        setView({ kind: 'ready', srcdoc: artifactPreviewSrcdoc(file.content) });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ArtifactReadError && error.status === 404) setView({ kind: 'missing' });
        else setView({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => controller.abort();
    // updatedAt: an agent's rewrite of the file shows without reopening it.
  }, [workspaceId, filePath, updatedAt, knownMissing, attempt]);

  if (view.kind === 'ready') {
    return (
      <div className="artifact-preview" data-testid="artifact-preview">
        <iframe
          key={attempt}
          className="artifact-preview__frame"
          title={label}
          // Scripts only: no allow-same-origin, so the page's origin is opaque.
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={view.srcdoc}
          onLoad={() => {
            loads.current += 1;
            if (loads.current > 1) setView({ kind: 'left' });
          }}
        />
      </div>
    );
  }

  let note: React.ReactNode;
  if (view.kind === 'loading') {
    note = <p className="artifact-preview__note" role="status">Loading…</p>;
  } else if (view.kind === 'missing') {
    note = (
      <div className="artifact-preview__note">
        <strong>File missing</strong>
        <span><code>{filePath}</code> was moved or deleted.</span>
        <span className="artifact-preview__actions"><Button variant="secondary" size="sm" onClick={onRemove}>Remove from Artifacts</Button></span>
      </div>
    );
  } else if (view.kind === 'left') {
    note = (
      <div className="artifact-preview__note">
        <strong>This page tried to open another page</strong>
        <span>A preview shows the file itself, not the pages it links to.</span>
        <span className="artifact-preview__actions"><Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>Reload preview</Button></span>
      </div>
    );
  } else {
    note = (
      <div className="artifact-preview__note">
        <strong>Couldn&apos;t show this file</strong>
        <span>{view.message}</span>
        <span className="artifact-preview__actions"><Button variant="secondary" size="sm" onClick={onDownload}>Download</Button></span>
      </div>
    );
  }
  return <div className="artifact-preview artifact-preview--message" data-testid="artifact-preview">{note}</div>;
}
