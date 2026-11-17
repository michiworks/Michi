import React from 'react';
import { workspaceAccent, initialOf } from './workspaceAccent';
import type { Project } from '../../state/chatTypes';
import { FolderIcon } from './icons';
import { WORKSPACE_ICON_SIZE } from './sidebarRowStyle';

export type WorkspaceIconMode = 'badge' | 'outline' | 'mono' | 'folder' | 'none';

interface Props {
  project: Project;
  mode: WorkspaceIconMode;
  /** Folder mode tints every workspace with its own accent; `active` makes that
   *  workspace the anchor (full opacity + faint fill) while the
   *  rest sit back at reduced opacity. Only consulted by `folder` mode. */
  active?: boolean;
}

const SIZE = 16;

export default function WorkspaceIcon({ project, mode, active = false }: Props) {
  if (mode === 'none') return null;

  const accent = workspaceAccent(project.id);
  const letter = initialOf(project.name);

  if (mode === 'folder') {
    // Every workspace gets its own accent-colored outline (hollow, so it stays
    // far quieter than the old filled letter-badges that read as rainbow noise).
    // The active workspace is the anchor: full opacity + a faint accent fill.
    // Inactive folders keep their hue but sit back at reduced opacity, so
    // identity and the active anchor both come through.
    return (
      <span
        aria-hidden
        style={{
          // Slot width == glyph width (15) so the folder has no internal
          // horizontal padding — its left edge is the slot left edge. The
          // WorkspaceRow then positions this slot so the glyph sits centered
          // between the sidebar edge and the workspace text, with the text
          // left-aligned to the thread rows below it. Keep math in sync there.
          width: WORKSPACE_ICON_SIZE, height: SIZE,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          color: accent, opacity: active ? 1 : 0.7, flexShrink: 0,
        }}
      >
        <FolderIcon size={WORKSPACE_ICON_SIZE} fill={active ? `${accent}22` : 'none'} />
      </span>
    );
  }

  const base: React.CSSProperties = {
    width: SIZE, height: SIZE,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 'var(--fs-sm)', fontWeight: 700, flexShrink: 0, boxSizing: 'border-box',
  };

  if (mode === 'outline') {
    return (
      <span style={{ ...base, color: accent, border: `1.5px solid ${accent}` }}>{letter}</span>
    );
  }
  if (mode === 'mono') {
    return (
      <span style={{ ...base, background: 'var(--term-alt)', color: 'var(--term-mid)' }}>{letter}</span>
    );
  }
  // mode === 'badge' (default) — fixed workspace badge palette, not theme-driven.
  // The initial decorates the name beside it: hidden from screen readers, so
  // its white on amber (3.18:1) can stay (TK-02).
  return (
    // eslint-disable-next-line no-restricted-syntax
    <span aria-hidden style={{ ...base, background: accent, color: '#fff' }}>{letter}</span>
  );
}

/** Resolve which workspace-icon mode to use for a given palette.
 *  All palettes now use the muted folder glyph (one accent anchor on the active
 *  workspace) instead of the old per-workspace colored letter badge, which read
 *  as rainbow noise with no system behind it. `palette` is kept for signature
 *  stability and future per-theme overrides. */
export function modeForPalette(_palette: string): WorkspaceIconMode {
  return 'folder';
}
