import React from 'react';
import { permissionSourceLabel } from 'michi-shared';
import type { PermissionRequest } from '../../state/chatTypes';
import { Button } from '../ui/controls';

/** How a choice reads by its kind: the runtime's own names vary, so its prompts read the same everywhere. */
const KIND_LABEL: Record<string, string> = {
  reject_once: 'Deny',
  reject_always: 'Never allow',
  allow_once: 'Allow Once',
  allow_always: 'Trust this tool',
  allow_session: 'Trust all tools for this session',
};

/**
 * The button's words. Michi's own prompts (source michi_policy: Pi's tool
 * approvals and the single-use questions it asks, like a follow-up's "Don't
 * send / Send / Send, and stop asking for this conversation") name each
 * answer, so their name shows; a name that is only the kind's label in
 * other case keeps the label. A runtime's prompts read by kind.
 */
function optionLabel(permission: PermissionRequest, option: PermissionRequest['options'][number]): string {
  const label = KIND_LABEL[option.kind] ?? option.name;
  if (permission.source !== 'michi_policy') return label;
  const name = typeof option.name === 'string' ? option.name.trim() : '';
  return name && name.toLowerCase() !== label.toLowerCase() ? name : label;
}

interface PermissionBannerProps {
  permission: PermissionRequest;
  onRespond: (optionId: string) => void;
  readOnly?: boolean;
}

export default function PermissionBanner({ permission, onRespond, readOnly = false }: PermissionBannerProps) {
  const rejectOptions = permission.options.filter(
    (o) => o.kind === 'reject_once' || o.kind === 'reject_always',
  );
  const allowOptions = permission.options.filter(
    (o) => o.kind === 'allow_once' || o.kind === 'allow_always' || o.kind === 'allow_session',
  );
  const hasTrustChoices = allowOptions.some((o) => o.kind === 'allow_session');

  return (
    <div
      role="group"
      aria-label="Permission request"
      style={{
        borderTop: '1px solid var(--term-line)',
        padding: '12px 14px',
        background: 'var(--term-alt)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        outline: 'none',
        flexShrink: 0,
      }}
    >
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          fontSize: 'var(--fs-md)',
          fontWeight: 600,
          color: 'var(--term-fg)',
          fontFamily: 'var(--ui-font)',
        }}
      >
        {permission.title}
        {readOnly && <span className="sr-only"> — Viewing only; another window must respond.</span>}
        <div
          data-testid="permission-source"
          style={{ fontWeight: 400, color: 'var(--term-muted)', fontSize: 'var(--fs-sm)', marginTop: 4 }}
        >
          {permissionSourceLabel(permission.source)}
        </div>
      </div>
      {permission.detail && (
        <pre
          style={{
            margin: 0,
            maxHeight: 96,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            border: '1px solid var(--term-line)',
            borderRadius: 'var(--ui-radius)',
            padding: '8px 10px',
            background: 'var(--term-bg)',
            color: 'var(--term-muted)',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-sm)',
            lineHeight: 1.45,
          }}
        >
          {permission.detail}
        </pre>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {readOnly ? (
          <div
            style={{
              fontFamily: 'var(--ui-font)',
              fontSize: 'var(--fs-sm)',
              color: 'var(--term-muted)',
            }}
          >
            Viewing only — another window must respond
          </div>
        ) : (
        <>
        <div style={{ display: 'flex', gap: 6 }}>
          {rejectOptions.map((o) => (
            <Button
              key={o.optionId}
              variant="secondary"
              className="t-permission-choice t-permission-choice--deny"
              disabled={o.disabled}
              onClick={() => onRespond(o.optionId)}
            >
              {optionLabel(permission, o)}
            </Button>
          ))}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {allowOptions.map((o) => {
            return (
              <Button
                key={o.optionId}
                variant="secondary"
                className="t-permission-choice"
                disabled={o.disabled}
                title={o.disabled ? 'The runtime did not provide a stable tool name. Allow this request once or trust this session.' : undefined}
                onClick={() => onRespond(o.optionId)}
              >
                {optionLabel(permission, o)}
              </Button>
            );
          })}
        </div>
        </>
        )}
      </div>
      {hasTrustChoices && <div style={{ color: 'var(--term-muted)', fontSize: 'var(--fs-sm)', fontFamily: 'var(--ui-font)' }}>
        Trust applies only to this conversation. Session trust ends when the runtime session is recreated. Select Ask to clear trust.
      </div>}
    </div>
  );
}
