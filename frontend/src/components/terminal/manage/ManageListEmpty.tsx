/** A Manage list with nothing to show: what goes here, or, under a search, that nothing matched and a way back. */
export default function ManageListEmpty({ query, empty, onClearFilter }: {
  /** The trimmed search; empty when the list is not filtered. */
  query: string;
  empty: string;
  onClearFilter?: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        padding: '20px 0',
        fontFamily: 'var(--ui-font)',
        fontSize: 'var(--fs-lg)',
        color: 'var(--term-muted)',
      }}
    >
      {query ? (
        <>
          <span role="status">No matches for “{query}”</span>
          {onClearFilter && <button type="button" className="t-text-btn" onClick={onClearFilter}>Clear search</button>}
        </>
      ) : empty}
    </div>
  );
}
