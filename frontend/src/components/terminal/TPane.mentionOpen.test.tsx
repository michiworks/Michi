/**
 * A chat's @artifact chip opens the artifact as the Artifacts drawer does.
 * Real TPane with stubbed children, as in TPane.sourceJump.test.tsx; the
 * message list stub clicks a chip through TPane's onMentionClick.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ArtifactEntry } from '../../state/chatTypes';

const H = vi.hoisted(() => ({
  openArtifactPane: vi.fn(),
  openPreferredUrl: vi.fn(),
  artifacts: [] as ArtifactEntry[],
}));

if (typeof (globalThis as any).CSS === 'undefined') (globalThis as any).CSS = {};
if (!(globalThis as any).CSS.highlights) (globalThis as any).CSS.highlights = new Map();
if (typeof (globalThis as any).Highlight === 'undefined') {
  (globalThis as any).Highlight = class Highlight { constructor(..._r: any[]) {} };
}
if (typeof window.matchMedia !== 'function') {
  (window as any).matchMedia = () => ({
    matches: false, media: '', onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
}

vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../state/chatStore');
  const others = new Map<PropertyKey, unknown>();
  const actions = new Proxy({}, {
    get: (_target, key) => {
      if (key === 'openArtifactPane') return H.openArtifactPane;
      if (!others.has(key)) others.set(key, vi.fn());
      return others.get(key);
    },
  });
  const node = {
    id: 'node1', nodeId: 'node1', chatId: 'chat1', projectId: 'p1', kind: 'chat', status: 'idle', messages: [], followUps: [],
    followUpsGenerating: false, title: 'Test thread', pendingComments: [], queuedMessages: [], injectedContexts: [],
  };
  return {
    ...actual,
    useChatActions: () => actions,
    useChatStore: () => ({ focusedPane: null }),
    useChatProjects: () => ({
      availableModes: [], agentStatus: null, refreshAgentStatus: vi.fn(),
      activeProject: { id: 'p1', name: 'P', cwd: '/cwd', artifacts: H.artifacts, edges: [], chatIds: ['node1'], trees: [{ id: 't1', rootNodeId: 'node1' }], activeTreeId: 't1' },
    }),
    useChatPanes: () => ({ focusedPane: null, openPanes: [], focusNonce: 0, paneItems: {}, viewMode: 'single' as const }),
    useChatNode: () => node,
    useStructuralSelector: (sel: any) => { try { return sel({}); } catch { return undefined; } },
  };
});
vi.mock('../../state/prefs', () => ({ usePrefs: () => ({ prefs: {}, setPref: vi.fn() }) }));
vi.mock('../../services/api', () => ({
  listAgentModels: vi.fn(async () => []),
  saveAgentOptions: vi.fn(async () => {}),
  getWebUploadCwd: vi.fn(async () => null),
  importWorkspaceFileUpload: vi.fn(async () => ({ filePath: '', displayName: '' })),
}));
vi.mock('../../services/openUrl', () => ({ openPreferredUrl: H.openPreferredUrl }));
vi.mock('./PaneMessageList', () => ({
  PaneMessageList: ({ onMentionClick }: { onMentionClick?: (name: string, kind: string) => void }) => (
    <div>
      {['design-notes', 'bubble-mock', 'docs-site'].map((name) => (
        <button key={name} type="button" onClick={() => onMentionClick?.(name, 'context')}>@{name}</button>
      ))}
    </div>
  ),
}));
vi.mock('./ComposerShell', () => ({ ComposerShell: React.forwardRef((p: any, _r: any) => p.input) }));
vi.mock('./PaneComposerPreBlocks', () => ({ PaneComposerPreBlocks: () => null }));
vi.mock('./PaneComposerActions', () => ({ PaneComposerActions: () => null }));
vi.mock('./PaneComposerToolbarLeft', () => ({ PaneComposerToolbarLeft: () => null }));
vi.mock('./PaneAgentMenus', () => ({ PaneAgentMenus: () => null }));
vi.mock('./PaneFind', () => ({ default: () => null, PaneFind: () => null }));
vi.mock('./PermissionBanner', () => ({ default: () => null, PermissionBanner: () => null }));
vi.mock('./MergeBanner', () => ({ default: () => null, MergeBanner: () => null }));
vi.mock('./PaneDragOverlays', () => ({ FileDropOverlay: () => null, PaneDropIndicator: () => null }));
vi.mock('../MentionEditor', () => ({ default: React.forwardRef((_p, ref) => {
  React.useImperativeHandle(ref, () => ({ editor: null }));
  return null;
}) }));
vi.mock('../SelectionActions', () => ({ default: () => null }));
vi.mock('../UploadProgressBar', () => ({ default: () => null }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import TPane from './TPane';

function entry(overrides: Partial<ArtifactEntry>): ArtifactEntry {
  return { id: 'a1', name: 'a', filePath: '', source: 'user', createdAt: 1, updatedAt: 1, ...overrides };
}

describe('TPane: an @artifact chip', () => {
  beforeEach(() => {
    H.openArtifactPane.mockReset();
    H.openArtifactPane.mockResolvedValue('pane-1');
    H.openPreferredUrl.mockReset();
    H.artifacts.length = 0;
    H.artifacts.push(
      entry({ id: 'sym', name: 'design-notes', filePath: '.artifacts/design-notes.md', type: 'doc', kind: 'symlink' }),
      entry({ id: 'html', name: 'bubble-mock', filePath: 'mocks/bubble.html', type: 'file', kind: 'embedded' }),
      entry({ id: 'link', name: 'docs-site', url: 'https://example.com/docs', type: 'link' }),
    );
  });
  afterEach(() => cleanup());

  it('opens a symlink artifact at its absolute path, as the drawer does', async () => {
    render(<TPane nodeId="node1" />);
    fireEvent.click(await screen.findByRole('button', { name: '@design-notes' }));
    await waitFor(() => expect(H.openArtifactPane).toHaveBeenCalledWith('/cwd/.artifacts/design-notes.md'));
  });

  it('opens an HTML artifact in the drawer\'s preview', async () => {
    const onDrawer = vi.fn();
    window.addEventListener('michi:toggle-artifacts', onDrawer);
    try {
      render(<TPane nodeId="node1" />);
      fireEvent.click(await screen.findByRole('button', { name: '@bubble-mock' }));
      await waitFor(() => expect(onDrawer).toHaveBeenCalledTimes(1));
      expect((onDrawer.mock.calls[0][0] as CustomEvent).detail).toEqual({ artifactId: 'html' });
      expect(H.openArtifactPane).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('michi:toggle-artifacts', onDrawer);
    }
  });

  it('opens a link artifact\'s URL', async () => {
    render(<TPane nodeId="node1" />);
    fireEvent.click(await screen.findByRole('button', { name: '@docs-site' }));
    await waitFor(() => expect(H.openPreferredUrl).toHaveBeenCalledWith('https://example.com/docs'));
  });
});
