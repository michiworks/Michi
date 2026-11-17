import React from 'react';
import { useChatActions, useChatProjects, useStructuralSelector } from '../../state/chatStore';
import type { ChatNodeState } from '../../state/chatTypes';
import { selectableTreeIds } from '../../state/sidebarSelectors';
import { BusyLabel } from '../ui/controls';
import { CloseIcon } from './icons';

/** Select all's box: checked when the selection holds every thread it takes, mixed when it holds some. */
function SelectAllBox({ held, onChange }: { held: 'all' | 'some' | 'none'; onChange: (on: boolean) => void }) {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useLayoutEffect(() => {
    if (ref.current) ref.current.indeterminate = held === 'some';
  }, [held]);
  return (
    <label className="tree-selection-bar__all">
      <input ref={ref} type="checkbox" checked={held === 'all'} onChange={(event) => onChange(event.currentTarget.checked)} />
      Select all
    </label>
  );
}

export default function TreeSelectionBar() {
  const {
    treeSelection,
    activeProject,
  } = useChatProjects();
  const {
    clearTreeSelection,
    selectAllTrees,
    bulkArchiveTrees,
    bulkDeleteTrees,
    createMergedChat,
  } = useChatActions();
  const [merging, setMerging] = React.useState(false);

  // Map selected tree IDs → root node IDs (createMergedChat takes node IDs).
  const count = treeSelection.size;
  const rootNodeIds = React.useMemo(
    () =>
      Array.from(treeSelection)
        .map((tid) => activeProject?.trees.find((t) => t.id === tid)?.rootNodeId)
        .filter((id): id is string => !!id),
    [activeProject, treeSelection],
  );
  const anyStreaming = useStructuralSelector(
    React.useCallback(
      (nodes) => rootNodeIds.some((id) => nodes[id]?.status === 'streaming'),
      [rootNodeIds],
    ),
  );
  const held = useStructuralSelector(
    React.useCallback((nodes: Record<string, ChatNodeState>) => {
      const ids = activeProject ? selectableTreeIds(activeProject, nodes) : [];
      const selected = ids.filter((id) => treeSelection.has(id)).length;
      return selected === 0 ? 'none' : selected === ids.length ? 'all' : 'some';
    }, [activeProject, treeSelection]),
  );
  if (count === 0) return null;

  // Merge works within one workspace, the active one; a selected thread from
  // another (Activity lists them all) would otherwise drop out of the merge.
  const outsideWorkspace = rootNodeIds.length < count;
  const showMerge = count >= 2;
  const mergeDisabled = outsideWorkspace || anyStreaming;
  // While a merge runs, Merge keeps focus and takes no second press.
  const mergeBlocked = mergeDisabled || merging;

  const onMerge = async () => {
    if (mergeBlocked) return;
    setMerging(true);
    try {
      await createMergedChat(rootNodeIds);
      clearTreeSelection();
    } catch {
      // createMergedChat already surfaced a toast on validation failure.
    } finally {
      setMerging(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 10px 5px 14px',
        background: 'var(--term-alt)',
        borderBottom: '1px solid var(--term-line)',
        fontSize: 'var(--fs-sm)',
        fontFamily: 'var(--ui-font)',
      }}
    >
      <span style={{ color: 'var(--term-fg)', fontWeight: 600 }}>{count} selected</span>
      <div style={{ flex: 1 }} />
      <SelectAllBox held={held} onChange={(on) => (on ? selectAllTrees() : clearTreeSelection())} />
      {showMerge && (
        // aria-disabled, not disabled, so focus and the hint stay reachable.
        <button
          type="button"
          className="tree-selection-bar__action"
          data-strong=""
          aria-disabled={mergeBlocked || undefined}
          aria-busy={merging || undefined}
          title={
            outsideWorkspace
              ? 'Only threads of the current workspace can be merged.'
              : anyStreaming
                ? 'Wait for streaming to finish before merging.'
                : 'Merge selected threads into a new chat'
          }
          onClick={onMerge}
        >
          <BusyLabel busy={merging} label="Merging…">Merge</BusyLabel>
        </button>
      )}
      <button type="button" className="tree-selection-bar__action" onClick={bulkArchiveTrees}>
        Archive
      </button>
      <button
        type="button"
        className="tree-selection-bar__action"
        data-danger=""
        onClick={bulkDeleteTrees}
      >
        Delete
      </button>
      <button type="button" className="tree-selection-bar__action" onClick={clearTreeSelection} aria-label="Clear selection">
        <CloseIcon size="sm" />
      </button>
    </div>
  );
}
