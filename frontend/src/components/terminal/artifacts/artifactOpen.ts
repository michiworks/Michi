import { artifactHasImagePreview, artifactTypeForPath } from 'michi-shared';
import type { ArtifactEntry, Project } from '../../../state/chatTypes';
import { artifactImageUrl, downloadArtifactFile } from '../../../services/api/artifacts';
import { openPreferredUrl } from '../../../services/openUrl';
import { MAX_PREVIEW_BYTES } from '../../../services/workspaceFileReader';
import { getElectron } from '../../../lib/electronBridge';
import { formatBytes } from '../../../lib/formatBytes';
import { artifactHostPath } from '../../../lib/workspaceFilePath';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { artifactHasWebPreview } from './artifactListModel';

export type ArtifactType = 'doc' | 'file' | 'image' | 'link';

/** The stored type; a legacy row without one is inferred from its URL or path. */
export function artifactType(c: ArtifactEntry): ArtifactType {
  if (c.type) return c.type;
  return c.url ? 'link' : artifactTypeForPath(c.filePath);
}

/** Inside the workspace folder, so the workspace file routes can read it. */
export function isEmbeddedArtifact(c: ArtifactEntry): boolean {
  return c.kind === undefined || c.kind === 'embedded';
}

type OpenProject = Pick<Project, 'id' | 'cwd' | 'backendConnectionId'>;

export type ArtifactOpenPlan =
  | { kind: 'missing' }
  | { kind: 'url'; url: string }
  /** `external` is the host path the OS can open instead; `confirmLarge` asks first when the file is too large to show. */
  | { kind: 'pane'; path: string; external: string | null; confirmLarge: boolean }
  | { kind: 'lightbox'; workspaceId: string }
  | { kind: 'web-preview' }
  | { kind: 'os'; path: string }
  | { kind: 'download'; workspaceId: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'none' };

/** How a tap on an artifact opens it, wherever the artifact is listed. */
export function planArtifactOpen(c: ArtifactEntry, { project, missing, hasDesktop }: {
  project: OpenProject | null | undefined;
  /** The drawer found the file gone. */
  missing: boolean;
  /** The desktop app can hand a path to the OS. */
  hasDesktop: boolean;
}): ArtifactOpenPlan {
  const t = artifactType(c);
  if (missing) return { kind: 'missing' };
  if (t === 'link') return c.url ? { kind: 'url', url: c.url } : { kind: 'none' };
  const hostPath = artifactHostPath(c, project);
  // A reference is a path outside the workspace; a symlink's target is too,
  // and the workspace read route refuses it, so both open at the host path.
  if (!isEmbeddedArtifact(c)) {
    if (t === 'doc') return { kind: 'pane', path: hostPath ?? c.filePath, external: hostPath, confirmLarge: true };
    return hostPath && hasDesktop ? { kind: 'os', path: hostPath } : { kind: 'unavailable', message: 'Open this reference on its desktop host' };
  }
  if (t === 'doc') return { kind: 'pane', path: c.filePath, external: hostPath, confirmLarge: false };
  if (!project) return { kind: 'none' };
  if (t === 'image' && artifactHasImagePreview(c.filePath)) return { kind: 'lightbox', workspaceId: project.id };
  if (artifactHasWebPreview(c.filePath)) return { kind: 'web-preview' };
  return { kind: 'download', workspaceId: project.id };
}

/**
 * Open the Artifacts drawer on one artifact, for its HTML preview, missing
 * note or lightbox. TerminalShell owns the drawer.
 */
export function showArtifactInDrawer(artifactId: string): void {
  window.dispatchEvent(new CustomEvent('michi:toggle-artifacts', { detail: { artifactId } }));
}

/** Run planArtifactOpen's plan; each list supplies where its previews and errors show. */
export async function openArtifact(c: ArtifactEntry, context: {
  project: OpenProject | null | undefined;
  missing?: boolean;
  openArtifactPane: (filePath: string) => Promise<unknown>;
  onLightbox: (src: string) => void;
  /** The drawer's preview of the artifact: an HTML page, or the note that its file is gone. */
  onPreview: () => void;
  onError: (message: string) => void;
  /** After a pane opened. */
  onOpened?: () => void;
}): Promise<void> {
  const electron = getElectron();
  const openPath = electron?.openPath;
  const plan = planArtifactOpen(c, { project: context.project, missing: !!context.missing, hasDesktop: !!openPath });
  const openViaOS = (path: string) => {
    void openPath?.(path).then((r) => {
      if (!r.ok && r.error) console.warn(`openPath(${path}) failed:`, r.error);
    });
  };
  switch (plan.kind) {
    case 'missing':
    case 'web-preview':
      context.onPreview();
      return;
    case 'url':
      openPreferredUrl(plan.url);
      return;
    case 'lightbox':
      context.onLightbox(artifactImageUrl(plan.workspaceId, c.filePath));
      return;
    case 'os':
      openViaOS(plan.path);
      return;
    case 'download':
      try { await downloadArtifactFile(plan.workspaceId, c.filePath); } catch (err) { context.onError((err as Error).message); }
      return;
    case 'unavailable':
      context.onError(plan.message);
      return;
    case 'pane': {
      if (plan.confirmLarge && plan.external && electron?.statFile) {
        const stat = await electron.statFile(plan.external);
        if (stat && stat.size > MAX_PREVIEW_BYTES) {
          const confirmed = await confirmDialog({
            title: 'File too large',
            message: `This file is ${formatBytes(stat.size)} (over 5 MB). Open in external app?`,
            confirmLabel: 'Open externally',
            cancelLabel: 'Cancel',
            danger: false,
          });
          if (confirmed) openViaOS(plan.external);
          return;
        }
      }
      try {
        await context.openArtifactPane(plan.path);
        context.onOpened?.();
      } catch (err) {
        if (plan.external && openPath) openViaOS(plan.external);
        else context.onError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    case 'none':
      return;
  }
}
