import React from 'react';
import { AgentDefinitionStatus } from 'michi-shared';
import type { AgentDefinitionDtoV1, AgentCapabilityCatalogEntryV1, AgentEnableBlockerV1 } from 'michi-shared';
import type { AgentResourceIdentity, LocatedAgentResource } from '../../../state/agentIdentity';
import { listAgentCapabilities } from '../../../services/api/agents';
import AgentDefinitionForm, {
  createAgentDefinitionFormValue, draftSaveErrors,
  validateAgentDefinitionForm, type AgentDefinitionFormErrors, type AgentDefinitionFormValue,
} from './AgentDefinitionForm';
import { backendConnectionIdForWorkspace } from '../../../config/backendConnections';
import { useBackendScope } from '../../../hooks/useBackendScope';
import { useRuntimeFieldCatalog } from './useRuntimeFieldCatalog';
import { Button } from '../../ui/controls';

interface Props {
  definition?: LocatedAgentResource<AgentDefinitionDtoV1> | null;
  initialScope?: 'global' | 'workspace';
  backendConnectionId?: string;
  workspaceId?: string | null;
  busy?: boolean;
  error?: string | null;
  /** Structured enable blockers from the backend (AgentEnableBlockedError). */
  blockers?: AgentEnableBlockerV1[] | null;
  onSaveDraft: (value: AgentDefinitionFormValue) => void | Promise<void>;
  onEnable: (value: AgentDefinitionFormValue) => void | Promise<void>;
  onDisable?: (identity: AgentResourceIdentity) => void | Promise<void>;
  onDuplicate?: (identity: AgentResourceIdentity) => void | Promise<void>;
  onDelete?: (identity: AgentResourceIdentity) => void | Promise<void>;
  onCancel?: () => void;
}

const NO_ERRORS: AgentDefinitionFormErrors = {};

export default function AgentEditorPage({
  definition, backendConnectionId, initialScope = 'workspace', workspaceId = null, busy = false, error, blockers = null,
  onSaveDraft, onEnable, onDisable, onDuplicate, onDelete, onCancel,
}: Props) {
  const [value, setValue] = React.useState(() => createAgentDefinitionFormValue(definition?.value, initialScope, workspaceId));
  const [submitting, setSubmitting] = React.useState<string | null>(null);
  const [capabilities, setCapabilities] = React.useState<AgentCapabilityCatalogEntryV1[] | null>(null);
  const catalogConnectionId = definition?.backendConnectionId ?? backendConnectionId ?? (workspaceId ? backendConnectionIdForWorkspace(workspaceId) : undefined);
  const catalogScope = useBackendScope(catalogConnectionId);
  const runtimeCatalog = useRuntimeFieldCatalog(catalogScope.connectionId);
  React.useEffect(() => setValue(createAgentDefinitionFormValue(definition?.value, initialScope, workspaceId)), [definition?.backendConnectionId, definition?.value.id, initialScope, workspaceId]);
  const effectiveWorkspaceId = definition?.value.workspaceId ?? workspaceId;
  React.useEffect(() => {
    // Catalog is advisory: on failure the form falls back to manual refs.
    const controller = new AbortController();
    let cancelled = false;
    setCapabilities(null);
    listAgentCapabilities(effectiveWorkspaceId, controller.signal, catalogScope.connectionId)
      .then((next) => { if (!cancelled) setCapabilities(next); })
      .catch(() => { if (!cancelled) setCapabilities(null); });
    return () => { cancelled = true; controller.abort(); };
  }, [effectiveWorkspaceId, catalogScope.key, catalogScope.connectionId]);
  const problems = React.useMemo(() => validateAgentDefinitionForm(value, runtimeCatalog), [value, runtimeCatalog]);
  // Field errors show once Save Draft or Enable was pressed, then follow every
  // edit: after Save Draft the ones that stop a draft, after Enable all (ST-17).
  const [tried, setTried] = React.useState<'draft' | 'enable' | null>(null);
  const errors = tried === 'enable' ? problems : tried === 'draft' ? draftSaveErrors(problems) : NO_ERRORS;
  // Bumped when problems stop a save: once their errors show, the first invalid field takes focus.
  const [stopped, setStopped] = React.useState(0);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (stopped > 0) bodyRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [stopped]);
  const identity = definition ? { backendConnectionId: definition.backendConnectionId, id: definition.value.id } : null;
  const status = definition?.value.status ?? AgentDefinitionStatus.Draft;
  const blocked = busy || submitting !== null;
  const invoke = async (label: string, action: () => void | Promise<void>) => {
    setSubmitting(label);
    try { await action(); } finally { setSubmitting(null); }
  };
  // Save Draft and Enable stay pressable while the form has problems; a press
  // they stop shows them instead of saving (ST-11).
  const submit = (label: 'draft' | 'enable', action: () => void | Promise<void>) => {
    setTried((current) => (current === 'enable' ? current : label));
    const stopping = label === 'enable' ? problems : draftSaveErrors(problems);
    if (Object.keys(stopping).length > 0) { setStopped((count) => count + 1); return; }
    void invoke(label, action);
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--term-page-bg, var(--term-bg))', color: 'var(--term-fg)' }}>
      <div ref={bodyRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '28px 56px 40px' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20, marginBottom: 28 }}>
        <div>
          <div style={{ color: 'var(--term-muted)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', letterSpacing: 'var(--ls-caps-wide)', textTransform: 'uppercase' }}>{definition ? 'Edit custom agent' : 'New custom agent'}</div>
          <h1 style={{ margin: '6px 0 4px', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-6xl)', lineHeight: 1.1, fontWeight: 500 }}>{value.name.trim() || 'Untitled Agent'}</h1>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--term-muted)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}>
            <ScopeBadge scope={value.scope} />
            <span>{status}</span>
          </div>
        </div>
        {onCancel && <Button onClick={onCancel}>close</Button>}
      </header>

      {blockers && blockers.length > 0 && (
        <div role="alert" data-testid="enable-blockers" style={{ border: '1px solid var(--term-select)', background: 'var(--term-select-f)', padding: '9px 11px', marginBottom: 16 }}>
          <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, letterSpacing: 'var(--ls-wide)', textTransform: 'uppercase', color: 'var(--term-fg)', fontFamily: 'var(--ui-font)' }}>
            Cannot enable yet — {blockers.length} condition{blockers.length === 1 ? '' : 's'}
          </div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4, color: 'var(--term-mid)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-md)' }}>
            {blockers.map((blocker, index) => (
              <li key={index}>
                {blocker.ref ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', color: 'var(--term-fg)' }}>{blocker.ref}</span> : null}
                {blocker.ref ? ' — ' : ''}{blocker.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && (!blockers || blockers.length === 0) && <div role="alert" style={{ border: '1px solid var(--term-danger)', color: 'var(--term-danger-text)', padding: 10, marginBottom: 16, fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-md)' }}>{error}</div>}
      <AgentDefinitionForm value={value} onChange={setValue} errors={errors} capabilities={capabilities} runtimeCatalog={runtimeCatalog} />
      </div>

      {/* Outside the scroll area: always flush with the pane bottom; the form
          scrolls underneath it instead of showing text below the buttons. */}
      <footer aria-label="Agent editor actions" style={{ flexShrink: 0, padding: '12px 56px', borderTop: '1px solid var(--term-line)', background: 'var(--term-page-bg, var(--term-bg))', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Button style={{ fontSize: 'var(--fs-sm)' }} disabled={blocked} onClick={() => submit('draft', () => onSaveDraft(value))} variant="primary">Save Draft</Button>
        {status === AgentDefinitionStatus.Enabled ? (
          <Button style={{ fontSize: 'var(--fs-sm)' }} disabled={blocked || !identity || !onDisable} onClick={() => identity && onDisable && void invoke('disable', () => onDisable(identity))}>Disable</Button>
        ) : (
          <Button style={{ fontSize: 'var(--fs-sm)' }} disabled={blocked} onClick={() => submit('enable', () => onEnable(value))}>Enable</Button>
        )}
        {identity && <Button style={{ fontSize: 'var(--fs-sm)' }} disabled={blocked || !onDuplicate} onClick={() => onDuplicate && void invoke('duplicate', () => onDuplicate(identity))}>Duplicate</Button>}
        {identity && <Button style={{ fontSize: 'var(--fs-sm)' }} disabled={blocked || !onDelete} onClick={() => onDelete && void invoke('delete', () => onDelete(identity))} danger>Delete</Button>}
        <span aria-live="polite" style={{ marginLeft: 'auto', color: 'var(--term-muted)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)' }}>
          {submitting ? `${submitting}…` : Object.keys(problems).length > 0 ? `${Object.keys(problems).length} validation issue${Object.keys(problems).length === 1 ? '' : 's'}` : 'ready to enable'}
        </span>
      </footer>
    </div>
  );
}

function ScopeBadge({ scope }: { scope: 'global' | 'workspace' }) {
  return <span style={{ border: '1px solid var(--term-line)', padding: '2px 6px', color: 'var(--term-fg)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: 'var(--ls-caps)', textTransform: 'uppercase' }}>{scope}</span>;
}
