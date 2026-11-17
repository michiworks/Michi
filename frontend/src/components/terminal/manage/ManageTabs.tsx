import type { KeyboardEvent, Ref } from 'react';
import { SearchIcon } from '../icons';
import './manage.css';

type Tab = 'chats' | 'artifacts' | 'digests';

interface Props {
  activeTab: Tab;
  onChange: (t: Tab) => void;
  counts: { chats: number; artifacts: number; digests: number };
  filter: string;
  onFilterChange: (s: string) => void;
  /** The search field, for a list's Clear search to return focus to. */
  searchRef?: Ref<HTMLInputElement>;
  /** A phone's narrower column: the search takes its own full-width row above
   *  the tabs instead of squeezing in beside them. */
  compact?: boolean;
  /** False while Settings › Digest is off: the Digests tab is not offered. */
  showDigests?: boolean;
}

const TAB_LABELS: Record<Tab, string> = {
  chats: 'Chats',
  artifacts: 'Artifacts',
  digests: 'Digests',
};

const TABS: Tab[] = ['chats', 'artifacts', 'digests'];

export default function ManageTabs({ activeTab, onChange, counts, filter, onFilterChange, searchRef, compact = false, showDigests = true }: Props) {
  const tabs = showDigests ? TABS : TABS.filter((t) => t !== 'digests');
  // ←/→ move and select, Home/End go to the ends; focus moves with the selection.
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    if (tabs[next] !== activeTab) onChange(tabs[next]);
    event.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-tab="${tabs[next]}"]`)?.focus();
  };
  return (
    <div
      className={compact ? 'manage-tabs--compact' : undefined}
      style={{
        marginTop: 12,
        borderBottom: '1px solid var(--term-line)',
        display: 'flex',
        flexWrap: compact ? 'wrap' : undefined,
        alignItems: 'flex-end',
        marginBottom: 22,
      }}
    >
      <div role="tablist" aria-label="Workspace lists" style={{ display: 'flex' }}>
        {tabs.map((t, index) => {
          const selected = t === activeTab;
          return (
            <button
              key={t}
              type="button"
              role="tab"
              className="manage-tab"
              data-tab={t}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(t)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              {TAB_LABELS[t]}
              <span className="manage-tab__count">{counts[t]}</span>
            </button>
          );
        })}
      </div>
      <div style={{ flex: 1 }} />
      <label
        className={compact ? 'ui-search' : undefined}
        style={compact ? {
          order: -1,
          flexBasis: '100%',
          height: 'auto',
          minHeight: 44,
          marginBottom: 8,
          padding: '0 12px',
          boxSizing: 'border-box',
        } : {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          color: 'var(--term-muted)',
          fontSize: 'var(--fs-lg)',
        }}
      >
        <SearchIcon style={{ flexShrink: 0 }} />
        <input
          ref={searchRef}
          type="text"
          aria-label="Search this workspace"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder="Search…"
          style={compact ? { fontSize: 'var(--fs-xl)' } : {
            border: 'none',
            background: 'transparent',
            fontFamily: 'var(--ui-font)',
            fontSize: 'var(--fs-lg)',
            color: 'var(--term-fg)',
            padding: 0,
            width: 160,
            minWidth: 0,
          }}
        />
      </label>
    </div>
  );
}
