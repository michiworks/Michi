import React, { useMemo } from 'react';
import { useChatStore, useChatNode, useChatNodesSnapshot } from '../../state/chatStore';
import { usePaneShellStyle } from '../../hooks/usePaneShellStyle';
import { useDigestEnabled } from '../../state/prefs';
import { parseDigestStructure, staleSources, visibleDigestMarkdown } from '../../state/digest';
import { requestDigestFocus } from '../../state/digestFocus';
import MarkdownContent from '../MarkdownContent';
import { TERM_PROSE_CLASS } from '../markdownProse';
import DigestGenerationStatus from './DigestGenerationStatus';
import { Tag } from './primitives';
import { navPageEvent } from '../../state/appEvents';
import { formatDigestAge } from './content/michiFormat';
import { BranchIcon, RetryIcon, SpinnerIcon } from './icons';

export default function DigestPane({
  nodeId,
  contentMaxWidth,
}: {
  nodeId: string;
  contentMaxWidth?: number | null;
}) {
  const { focusPane, refreshDigest, createChildChat } = useChatStore();
  const n = useChatNode(nodeId);
  const nodesSnapshot = useChatNodesSnapshot();
  const { style: paneShellStyle, recede } = usePaneShellStyle(nodeId);
  const digestEnabled = useDigestEnabled();

  const savedContent = n?.digest?.content;
  const content = useMemo(
    () => (savedContent !== undefined ? visibleDigestMarkdown(savedContent) : undefined),
    [savedContent],
  );
  const parsed = useMemo(
    () => (content !== undefined ? parseDigestStructure(content) : null),
    [content],
  );
  const stale = useMemo(
    () => (n?.digest ? staleSources(n.digest, nodesSnapshot) : []),
    [n?.digest, nodesSnapshot],
  );

  if (!n || n.kind !== 'digest' || !n.digest) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--term-surface)',
          borderRight: '1px solid var(--term-line)',
          minWidth: 0,
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--term-muted)',
          fontSize: 'var(--fs-sm)',
        }}
      >
        — empty digest pane —
      </div>
    );
  }

  const d = n.digest;
  const title = n.title || 'Workspace digest';
  const innerWrap: React.CSSProperties =
    contentMaxWidth != null
      ? { maxWidth: contentMaxWidth, marginLeft: 'auto', marginRight: 'auto', width: '100%' }
      : { width: '100%' };

  const openFullDetail = () => {
    requestDigestFocus(nodeId);
    navPageEvent.dispatch({ page: 'digest' });
  };

  return (
    <div
      data-node-id={nodeId}
      data-pane-kind="digest"
      className="terminal-pane"
      onMouseDown={() => focusPane(nodeId)}
      style={{
        ...paneShellStyle,
        borderLeft: '3px solid var(--term-digest)',
      }}
    >
      <div
        style={{
          height: 36,
          padding: '0 12px',
          background: 'var(--term-digest-f)',
          borderBottom: '1px solid var(--term-line)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexShrink: 0,
          fontSize: 'var(--fs-sm)',
        }}
      >
        <span style={{ color: 'var(--term-digest)', fontSize: 'var(--fs-xl)', fontWeight: 700, lineHeight: 1 }}>§</span>
        <span
          style={{
            color: 'var(--term-digest)',
            fontWeight: 700,
            letterSpacing: 'var(--ls-caps-wide)',
            fontSize: 'var(--fs-xs)',
          }}
        >
          DIGEST
        </span>
        <span style={{ color: 'var(--term-faint)' }}>·</span>
        <span
          style={{
            color: 'var(--term-fg)',
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
            flex: 1,
          }}
          title={title}
        >
          {title}
        </span>
        {stale.length > 0 && <Tag color="var(--term-waiting-text)">{stale.length} stale</Tag>}
        <span style={{ color: 'var(--term-muted)', fontSize: 'var(--fs-xs)' }}>
          {d.status === 'streaming' ? 'streaming…' : formatDigestAge(d.generatedAt)}
        </span>
        {/* Settings › Digest off: an already-open digest stays readable, without
            rebuild or the Digest page it would open. */}
        {digestEnabled && <>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void refreshDigest(nodeId);
          }}
          disabled={d.status === 'streaming'}
          className="t-icon-btn"
          title="Rebuild digest"
          aria-label="Rebuild digest"
        >
          {d.status === 'streaming'
            ? <SpinnerIcon size="sm" className="motion-safe:animate-spin" style={{ color: 'var(--term-digest)' }} />
            : <RetryIcon size="sm" style={{ color: 'var(--term-digest)' }} />}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            openFullDetail();
          }}
          className="t-text-btn is-bordered"
          title="Open full digest view"
        >
          detail
        </button>
        </>}
      </div>

      <div
        className="term-scrollbar"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '16px 22px 24px',
          color: 'var(--term-fg)',
          fontSize: 'var(--fs-lg)',
          lineHeight: 1.7,
        }}
      >
        <div style={innerWrap}>
          <DigestGenerationStatus key={nodeId} digest={d} />
          {parsed?.tldr && (
            <div
              style={{
                padding: '12px 14px',
                border: '1px solid var(--term-line)',
                background: 'var(--term-surface)',
                borderLeft: '3px solid var(--term-fg)',
                marginBottom: 16,
              }}
            >
              <div
                style={{
                  fontSize: 'var(--fs-xs)',
                  color: 'var(--term-muted)',
                  letterSpacing: 'var(--ls-caps-wide)',
                  marginBottom: 6,
                }}
              >
                ▸ TL;DR
              </div>
              <div style={{ fontSize: 'var(--fs-lg)', color: 'var(--term-fg)', lineHeight: 1.6 }}>
                <MarkdownContent text={parsed.tldr} className={TERM_PROSE_CLASS} />
              </div>
            </div>
          )}

          {parsed && parsed.sections.length > 0 ? (
            <>
              <div
                style={{
                  fontSize: 'var(--fs-xs)',
                  color: 'var(--term-muted)',
                  letterSpacing: 'var(--ls-caps-wide)',
                  marginBottom: 8,
                }}
              >
                ▸ SECTIONS · {parsed.sections.length}
              </div>
              {parsed.sections.map((s, i) => {
                const isStale = s.sourceId ? stale.includes(s.sourceId) : false;
                return (
                  <div
                    key={i}
                    style={{
                      marginBottom: 12,
                      padding: '10px 14px',
                      background: 'var(--term-surface)',
                      border: '1px solid var(--term-line)',
                      borderLeft: isStale
                        ? '3px solid var(--term-select)'
                        : '3px solid var(--term-digest)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ color: 'var(--term-muted)', fontSize: 'var(--fs-xs)' }}>
                        §{String(i + 1).padStart(2, '0')}
                      </span>
                      <span
                        style={{
                          fontFamily: 'var(--ui-font)',
                          fontSize: 'var(--fs-lg)',
                          fontWeight: 600,
                          color: 'var(--term-fg)',
                        }}
                      >
                        {s.title}
                      </span>
                      {isStale && <Tag color="var(--term-waiting-text)">stale</Tag>}
                    </div>
                    <div style={{ fontSize: 'var(--fs-lg)', color: 'var(--term-mid)', lineHeight: 1.6 }}>
                      <MarkdownContent text={s.body} className={TERM_PROSE_CLASS} />
                    </div>
                  </div>
                );
              })}
            </>
          ) : !parsed?.tldr && !parsed?.openThreads.length ? (
            <div style={{ color: 'var(--term-mid)' }}>
              {content ? (
                <MarkdownContent text={content} className={TERM_PROSE_CLASS} />
              ) : d.status === 'idle' ? (
                <span style={{ color: 'var(--term-muted)' }}>— digest is empty —</span>
              ) : null}
            </div>
          ) : null}

          {parsed && parsed.openThreads.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div
                style={{
                  fontSize: 'var(--fs-xs)',
                  color: 'var(--term-muted)',
                  letterSpacing: 'var(--ls-caps-wide)',
                  marginBottom: 8,
                }}
              >
                ▸ OPEN THREADS
              </div>
              <div style={{ border: '1px solid var(--term-line)', background: 'var(--term-surface)' }}>
                {parsed.openThreads.map((q, i) => (
                  <div
                    key={i}
                    style={{
                      padding: '8px 12px',
                      borderBottom:
                        i < parsed.openThreads.length - 1 ? '1px solid var(--term-line)' : 'none',
                      display: 'flex',
                      gap: 10,
                      alignItems: 'flex-start',
                      fontSize: 'var(--fs-md)',
                    }}
                  >
                    <span style={{ color: 'var(--term-accent)' }}>?</span>
                    <span style={{ color: 'var(--term-fg)', flex: 1 }}>{q}</span>
                    <button
                      type="button"
                      onClick={() => void createChildChat(nodeId, q).catch(() => {})}
                      style={{
                        fontSize: 'var(--fs-xs)',
                        color: 'var(--term-mauve)',
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                      }}
                    >
                      <BranchIcon size="sm" />
                      explore
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      {recede}
    </div>
  );
}
