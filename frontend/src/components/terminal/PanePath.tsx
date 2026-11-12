/** The path line under a file-backed pane's caption. The caption already
 *  shows the file name and kind, so the folder stays dim and the name only
 *  slightly brighter. */
export default function PanePath({ path, suffix }: { path: string; suffix?: string }) {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1;
  return (
    <span title={path} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--fs-sm)', color: 'var(--term-muted)' }}>
      {path.slice(0, cut)}<span style={{ color: 'var(--term-mid)' }}>{path.slice(cut)}</span>{suffix}
    </span>
  );
}
