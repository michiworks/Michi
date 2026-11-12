/** Imports the files into the pane's composer; false when the pane takes none. */
type PaneFileDropTarget = (files: readonly File[]) => Promise<boolean>;

const targets = new Map<string, PaneFileDropTarget>();

/** A chat pane on the Dashboard registers here, so a file drop that lands
 *  outside it (the strip, a page or run pane) can reach its composer. */
export function registerPaneFileDropTarget(nodeId: string, target: PaneFileDropTarget): () => void {
  targets.set(nodeId, target);
  return () => {
    if (targets.get(nodeId) === target) targets.delete(nodeId);
  };
}

export function paneFileDropTarget(nodeId: string | null | undefined): PaneFileDropTarget | undefined {
  return nodeId ? targets.get(nodeId) : undefined;
}
