import React, { useState } from 'react';
import { FileText } from 'lucide-react';
import { remoteEntityIdentity } from '../../../../config/backendIdentity';
import { openSpacesPage } from '../../../../state/metaChat/spacesPages';
import { useMetaChatRevealPage } from './metaChatRevealPage';

function textOf(children: React.ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textOf).join('');
  if (React.isValidElement<{ children?: React.ReactNode }>(children)) return textOf(children.props.children);
  return '';
}

/** The remote connection a page id names, if it names one. */
function remoteConnectionOf(id: string): string | undefined {
  try {
    return remoteEntityIdentity(id)?.connectionId;
  } catch {
    return undefined;
  }
}

/** A `michi://page/<id>[?block=<id>]` link in an assistant reply: opens the page and flashes the block. */
export function PageLinkChip({ id, blockId, children }: { id: string; blockId?: string; children: React.ReactNode }) {
  const label = textOf(children).trim() || 'Page';
  const [gone, setGone] = useState(false);
  const revealPage = useMetaChatRevealPage();
  return (
    <button
      type="button"
      className="assistant-cite"
      data-assistant-link={blockId ? 'page-block' : 'page'}
      aria-disabled={gone || undefined}
      title={gone ? `${label} — deleted` : label}
      onClick={() => {
        if (!gone) revealPage?.();
        const backendConnectionId = remoteConnectionOf(id);
        void openSpacesPage({ pageId: id, ...(backendConnectionId ? { backendConnectionId } : {}), ...(blockId ? { blockId } : {}) })
          .then((result) => { if (result === 'deleted') setGone(true); });
      }}
    >
      <span className="assistant-cite__icon" aria-hidden="true"><FileText size={11} /></span>
      <span className="assistant-cite__text">{label}</span>
      {gone && <span className="assistant-cite__note">deleted</span>}
    </button>
  );
}
