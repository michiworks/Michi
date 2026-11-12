import { useState } from 'react';
import { artifactHasImagePreview } from 'michi-shared';
import type { MessageAttachment } from '../../state/chatTypes';
import { attachmentImageUrl } from '../../services/api/artifacts';
import { Lightbox } from './Lightbox';

function isImageAttachment(a: MessageAttachment): boolean {
  return artifactHasImagePreview(a.name);
}

interface Props {
  items: MessageAttachment[];
  /** The message's workspace, where its attachments were uploaded. */
  workspaceId?: string;
}

export function AttachmentPills({ items, workspaceId }: Props) {
  const [zoom, setZoom] = useState<{ src: string; filename: string } | null>(null);
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());

  if (items.length === 0) return null;

  const imageItems = items.filter(isImageAttachment);
  const fileItems = items.filter(a => !isImageAttachment(a));

  return (
    <div className="t-att-chips" style={{ marginBottom: 8 }}>
      {/* Image attachments: render as thumbnails */}
      {imageItems.length > 0 && (
        <div className="t-att-thumbs" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: fileItems.length > 0 ? 6 : 0 }}>
          {imageItems.map((a, i) => {
            const src = attachmentImageUrl(workspaceId, a);
            if (!src || broken.has(src)) {
              // Fallback to pill if image can't be served
              return (
                <span
                  key={`${a.absPath}-${i}`}
                  data-testid="attachment-pill"
                  className="t-att-chip"
                  title={a.absPath}
                >
                  <span style={{ fontSize: 'var(--fs-xs)', opacity: 0.7 }} aria-hidden>🖼</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.name}
                  </span>
                </span>
              );
            }
            return (
              <button
                key={`${a.absPath}-${i}`}
                type="button"
                data-testid="attachment-thumb"
                className="t-att-thumb-btn"
                title={a.name}
                onClick={() => setZoom({ src, filename: a.name })}
                style={{
                  border: 'none',
                  padding: 0,
                  background: 'none',
                  cursor: 'zoom-in',
                  display: 'block',
                  overflow: 'hidden',
                  lineHeight: 0,
                }}
              >
                <img
                  src={src}
                  alt={a.name}
                  loading="lazy"
                  onError={() => setBroken(prev => new Set(prev).add(src))}
                  style={{
                    width: 'var(--att-thumb-size, 160px)',
                    height: 'var(--att-thumb-size, 160px)',
                    objectFit: 'cover',
                    display: 'block',
                  }}
                />
              </button>
            );
          })}
        </div>
      )}

      {/* Non-image attachments: original pill style */}
      {fileItems.map((a, i) => (
        <span
          key={`${a.absPath}-${i}`}
          data-testid="attachment-pill"
          className="t-att-chip"
          title={a.absPath}
        >
          <span style={{ fontSize: 'var(--fs-xs)', opacity: 0.7 }} aria-hidden>📄</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {a.name}
          </span>
        </span>
      ))}

      {/* Lightbox for zoomed image */}
      {zoom && (
        <Lightbox
          src={zoom.src}
          alt={zoom.filename}
          filename={zoom.filename}
          onClose={() => setZoom(null)}
        />
      )}
    </div>
  );
}
