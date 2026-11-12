import { useEffect, useMemo, useState } from 'react';
import type { ArtifactEntry } from '../../../state/chatTypes';
import { fetchArtifactHead } from '../../../services/api/artifacts';
import { artifactTitleFromHead, artifactTitleSource, artifactTouchedAt } from './artifactListModel';
import { isEmbeddedArtifact } from './artifactOpen';

export interface ArtifactHeadInfo {
  /** The page title or first heading, when the file has one. */
  title?: string;
  /** The file is gone from the workspace (a 404). */
  missing?: boolean;
}

const CONCURRENCY = 4;
const NONE: ReadonlySet<string> = new Set();

/** Titles read this session, by workspace, path and last touch: a rewrite re-reads. */
const titles = new Map<string, string | null>();

function cacheKey(workspaceId: string, c: ArtifactEntry): string {
  return `${workspaceId}\0${c.filePath}\0${artifactTouchedAt(c)}`;
}

/** Files inside the workspace, read through its download route. */
function readable(c: ArtifactEntry): boolean {
  return !c.url && !!c.filePath && isEmbeddedArtifact(c)
    && (c.type === undefined || c.type === 'doc' || c.type === 'file');
}

/**
 * While the drawer is open, read the first 4 KB of each workspace file once
 * for its title (artifactTitleFromHead), a few at a time. A file that answers
 * 404 is marked missing. Missing files are asked again each time the drawer
 * opens, since a file can come back.
 */
export function useArtifactHeads(
  workspaceId: string | undefined,
  artifacts: readonly ArtifactEntry[],
  enabled: boolean,
): ReadonlyMap<string, ArtifactHeadInfo> {
  // This render's copy of the session cache, so reads re-render the rows.
  const [known, setKnown] = useState<ReadonlyMap<string, string | null>>(() => new Map(titles));
  const [missing, setMissing] = useState<ReadonlySet<string>>(NONE);
  const files = useMemo(() => artifacts.filter(readable), [artifacts]);
  // A string, so a new array of the same artifacts doesn't restart the reads.
  const filesKey = workspaceId ? files.map((c) => `${c.id}\0${cacheKey(workspaceId, c)}`).join('\n') : '';

  useEffect(() => {
    if (!enabled || !workspaceId || !filesKey) return;
    const controller = new AbortController();
    const queue = files.filter((c) => !titles.has(cacheKey(workspaceId, c)));
    const gone = new Set<string>();
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const c = queue[cursor++];
        const head = await fetchArtifactHead(workspaceId, c.filePath, 4096, controller.signal);
        if (controller.signal.aborted) return;
        if (head.status === 'missing') {
          gone.add(c.id);
          setMissing((prev) => (prev.has(c.id) ? prev : new Set([...prev, c.id])));
        } else if (head.status === 'ok') {
          const source = artifactTitleSource(c.filePath);
          titles.set(cacheKey(workspaceId, c), source ? artifactTitleFromHead(head.text, source) : null);
          setKnown(new Map(titles));
        }
      }
    };
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker);
    // Once every file has answered, a file that came back stops reading as missing.
    void Promise.all(workers).then(() => {
      if (!controller.signal.aborted) setMissing(gone.size ? gone : NONE);
    });
    return () => controller.abort();
    // filesKey stands for `files`: same artifacts, same reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, workspaceId, filesKey]);

  return useMemo(() => {
    const out = new Map<string, ArtifactHeadInfo>();
    if (!workspaceId) return out;
    for (const c of files) {
      const title = known.get(cacheKey(workspaceId, c)) ?? undefined;
      const gone = missing.has(c.id);
      if (title || gone) out.set(c.id, gone ? { title, missing: true } : { title });
    }
    return out;
  }, [workspaceId, files, missing, known]);
}
