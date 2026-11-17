import React from 'react';
import type { ArtifactEntry } from '../../../state/chatTypes';
import { artifactType } from '../artifacts/artifactOpen';
import { manageFileType, MANAGE_LINK_TYPE } from './tokens';
import { Button } from '../../ui/controls';
import { HoverTip } from '../../ui/Popover';
import { formatBytes } from '../../../lib/formatBytes';
import { FolderOpenIcon, StarIcon, TrashIcon } from '../icons';
import ManageListEmpty from './ManageListEmpty';
import './manage.css';

interface Props {
  artifacts: ArtifactEntry[];
  filter: string;
  onClearFilter?: () => void;
  selectedContextId: string | null;
  onSelect: (id: string) => void;
  onPin: (id: string) => void;
  onDelete: (id: string) => void;
  onOpen: (artifact: ArtifactEntry) => void;
  onAdd: () => void;
}

/** Artifact type → display group. Absent type is inferred from the URL or file extension. */
const TYPE_GROUPS: Array<{ key: 'doc' | 'file' | 'image' | 'link'; title: string }> = [
  { key: 'doc', title: 'Documents' },
  { key: 'file', title: 'Files' },
  { key: 'image', title: 'Images' },
  { key: 'link', title: 'Links' },
];

export default function ContextList({
  artifacts,
  filter,
  onClearFilter,
  selectedContextId,
  onSelect,
  onPin,
  onDelete,
  onOpen,
  onAdd,
}: Props) {
  const norm = filter.trim().toLowerCase();
  const filtered = norm
    ? artifacts.filter(
        (c) =>
          c.name.toLowerCase().includes(norm) ||
          c.filePath.toLowerCase().includes(norm) ||
          (c.url ?? '').toLowerCase().includes(norm),
      )
    : artifacts;

  const totalBytes = filtered.reduce((acc, c) => acc + (c.size ?? 0), 0);
  const favoriteCount = filtered.filter((c) => c.pinnedAt).length;

  // Group by artifact type; within a group favorites sort first, then newest first.
  const byType = new Map<string, ArtifactEntry[]>();
  for (const c of filtered) {
    const t = artifactType(c);
    const arr = byType.get(t) ?? [];
    arr.push(c);
    byType.set(t, arr);
  }
  for (const arr of byType.values()) {
    arr.sort((a, b) => {
      if (!!a.pinnedAt !== !!b.pinnedAt) return a.pinnedAt ? -1 : 1;
      return (b.createdAt ?? 0) - (a.createdAt ?? 0);
    });
  }

  return (
    <div>
      <Strip totalBytes={totalBytes} favoriteCount={favoriteCount} onAdd={onAdd} />
      {filtered.length === 0 && <ManageListEmpty query={filter.trim()} empty="no artifacts yet — add one above" onClearFilter={onClearFilter} />}
      {TYPE_GROUPS.map((g) => (
        <Section
          key={g.key}
          title={g.title}
          count={(byType.get(g.key) ?? []).length}
          rows={byType.get(g.key) ?? []}
          selectedId={selectedContextId}
          onSelect={onSelect}
          onPin={onPin}
          onDelete={onDelete}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

function Strip({
  totalBytes,
  favoriteCount,
  onAdd,
}: {
  totalBytes: number;
  favoriteCount: number;
  onAdd: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginBottom: 14,
        padding: '0 14px',
        color: 'var(--term-muted)',
        fontFamily: 'var(--ui-font)',
        fontSize: 'var(--fs-lg)',
      }}
    >
      <span>Drag &amp; drop files anywhere, or</span>
      <Button variant="primary" onClick={onAdd}>
        + Add source
      </Button>
      <span style={{ flex: 1 }} />
      <span style={{ color: 'var(--term-muted)', fontSize: 'var(--fs-md)' }}>
        {favoriteCount} favorite{favoriteCount === 1 ? '' : 's'} · {formatBytes(totalBytes, { empty: '—' })} total
      </span>
    </div>
  );
}

function Section({
  title,
  count,
  rows,
  selectedId,
  onSelect,
  onPin,
  onDelete,
  onOpen,
}: {
  title: string;
  count: number;
  rows: ArtifactEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPin: (id: string) => void;
  onDelete: (id: string) => void;
  onOpen: (artifact: ArtifactEntry) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <section style={{ marginBottom: 28 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          padding: '0 14px 8px 14px',
          borderBottom: '1px solid var(--term-line)',
          marginBottom: 4,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--ui-font)',
            fontSize: 'var(--fs-lg)',
            lineHeight: 1.3,
            fontWeight: 500,
            color: 'var(--term-fg)',
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontSize: 'var(--fs-md)',
            color: 'var(--term-muted)',
            fontFamily: 'var(--ui-font)',
          }}
        >
          · {count}
        </span>
        <span style={{ flex: 1 }} />
      </div>
      {rows.map((c) => {
        const isLink = artifactType(c) === 'link';
        const ft = isLink ? MANAGE_LINK_TYPE : manageFileType(c.name);
        const metaLine = isLink ? c.url ?? '' : `${c.kind === 'reference' ? '↗ ' : c.kind === 'symlink' ? '⇄ ' : ''}${c.filePath}`;
        const selected = selectedId === c.id;
        return (
          <div
            key={c.id}
            className="manage-row"
            data-selected={selected}
            style={{
              display: 'flex',
              gap: 14,
              alignItems: 'center',
              padding: '12px 14px',
            }}
          >
            {selected && (
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: 2,
                  background: 'var(--term-accent)',
                }}
              />
            )}
            <div
              style={{
                width: 30,
                height: 36,
                background: ft.fill,
                color: ft.text,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 'var(--fs-xs)',
                fontWeight: 700,
                letterSpacing: 'var(--ls-wide)',
                flexShrink: 0,
                fontFamily: 'var(--ui-font)',
                textTransform: 'uppercase',
              }}
            >
              {ft.label}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <button
                type="button"
                className="manage-row__open"
                aria-current={selected || undefined}
                onClick={() => onSelect(c.id)}
                style={{
                  display: 'block',
                  width: '100%',
                  fontFamily: 'var(--ui-font)',
                  fontSize: 'var(--fs-xl)',
                  lineHeight: 1.3,
                  fontWeight: 500,
                  color: 'var(--term-fg)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {c.name}
              </button>
              <div
                style={{
                  fontSize: 'var(--fs-md)',
                  color: 'var(--term-muted)',
                  marginTop: 2,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  fontFamily: 'var(--ui-font)',
                }}
              >
                {metaLine}
              </div>
            </div>
            <div className="manage-row__above manage-artifact__end">
              <RowMeta size={c.size} />
              <RowActions
                favorite={!!c.pinnedAt}
                onPreview={() => onOpen(c)}
                onPin={() => onPin(c.id)}
                onDelete={() => onDelete(c.id)}
                contextName={c.name}
              />
            </div>
          </div>
        );
      })}
    </section>
  );
}

function RowMeta({ size }: { size: number | undefined }) {
  return (
    <span
      className="manage-artifact__size"
      style={{
        display: 'inline-flex',
        gap: 12,
        color: 'var(--term-muted)',
        whiteSpace: 'nowrap',
        fontFamily: 'var(--ui-font)',
        fontSize: 'var(--fs-md)',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <span style={{ width: 60, textAlign: 'right' }}>{formatBytes(size, { empty: '—' })}</span>
    </span>
  );
}

function RowActions({
  favorite,
  onPreview,
  onPin,
  onDelete,
  contextName,
}: {
  favorite: boolean;
  onPreview: () => void;
  onPin: () => void;
  onDelete: () => void;
  contextName: string;
}) {
  return (
    <span
      className="manage-artifact__actions"
      style={{
        display: 'inline-flex',
        gap: 4,
        whiteSpace: 'nowrap',
      }}
    >
      <IconBtn
        ariaLabel={`preview ${contextName}`}
        title="Open or download file"
        onClick={onPreview}
      >
        <FolderOpenIcon />
      </IconBtn>
      <IconBtn
        ariaLabel={favorite
          ? `Remove ${contextName} from favorites`
          : `Add ${contextName} to favorites`}
        title={favorite ? 'Remove from favorites' : 'Add to favorites'}
        pressed={favorite}
        onClick={onPin}
      >
        <StarIcon fill={favorite ? 'currentColor' : 'none'} />
      </IconBtn>
      <IconBtn
        ariaLabel={`delete ${contextName}`}
        title="Delete"
        danger
        onClick={onDelete}
      >
        <TrashIcon />
      </IconBtn>
    </span>
  );
}

function IconBtn({
  children,
  onClick,
  ariaLabel,
  title,
  pressed,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  ariaLabel: string;
  title: string;
  pressed?: boolean;
  danger?: boolean;
}) {
  return (
    <HoverTip label={title}>
      <button
        type="button"
        className="t-icon-btn manage-icon-btn"
        aria-label={ariaLabel}
        aria-pressed={pressed}
        data-danger={danger || undefined}
        onClick={onClick}
      >
        {children}
      </button>
    </HoverTip>
  );
}
