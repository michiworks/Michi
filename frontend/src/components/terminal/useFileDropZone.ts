import { useCallback, useRef, useState, type DragEvent } from 'react';

export function isFileDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes('Files');
}

/**
 * The drag-depth counter behind a file drop zone: a child's dragenter/
 * dragleave pair keeps it shown until the drag really leaves. The drop
 * handler stays with the caller, which calls endDrag first.
 */
export function useFileDropZone({ enabled = true, ignore, stopPropagation = false }: {
  /** False: the drag is still claimed (no browser navigation), but the zone stays hidden. */
  enabled?: boolean;
  /** A drag over this target belongs to someone else; must be stable. */
  ignore?: (e: DragEvent) => boolean;
  /** Keep the drag from an enclosing drop zone. */
  stopPropagation?: boolean;
} = {}) {
  const depthRef = useRef(0);
  const [visible, setVisible] = useState(false);
  const [fileCount, setFileCount] = useState(0);

  const onDragEnter = useCallback((e: DragEvent) => {
    if (!isFileDrag(e) || ignore?.(e)) return;
    e.preventDefault();
    if (stopPropagation) e.stopPropagation();
    if (!enabled) return;
    depthRef.current += 1;
    if (depthRef.current === 1) {
      setVisible(true);
      setFileCount(e.dataTransfer.items.length);
    }
  }, [enabled, ignore, stopPropagation]);

  const onDragOver = useCallback((e: DragEvent) => {
    if (!isFileDrag(e) || ignore?.(e)) return;
    e.preventDefault();
    if (stopPropagation) e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }, [ignore, stopPropagation]);

  const onDragLeave = useCallback((e: DragEvent) => {
    if (!isFileDrag(e)) return;
    if (stopPropagation) e.stopPropagation();
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (depthRef.current === 0) setVisible(false);
  }, [stopPropagation]);

  const endDrag = useCallback(() => {
    depthRef.current = 0;
    setVisible(false);
  }, []);

  return { visible, fileCount, onDragEnter, onDragOver, onDragLeave, endDrag };
}
