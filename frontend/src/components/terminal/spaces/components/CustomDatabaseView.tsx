import { useCallback, useMemo, useState } from 'react';
import type { ComponentHost, PageComponentSource, PageDatabase, PageDatabaseView } from 'michi-shared';
import { applyView } from '../../content/db/dbModel';
import { pageDatabaseForMichiView } from '../../content/db/nativeDatabaseAdapter';
import { SandboxFrame } from './SandboxFrame';
import { ComponentSourceAttribution } from './ComponentSourceAttribution';
import { useComponentCapability } from './useComponentCapability';
import { useComponentSource } from './useComponentSource';
import './components.css';

export interface CustomDatabaseViewProps {
  database: PageDatabase;
  view: PageDatabaseView;
  workspaceId: string;
  connectionId: string;
  onAskDraft?: (draft: string) => void;
  onNavigatePage?: (pageId: string) => void;
  onOpenSource?: (source: PageComponentSource) => void | boolean | Promise<void | boolean>;
  readOnly?: boolean;
}

/** The view receives the current native row/column snapshot; its capability can request row-only writes. */
export function CustomDatabaseView(props: CustomDatabaseViewProps) {
  return <CustomDatabaseViewContent key={JSON.stringify([props.connectionId, props.workspaceId, props.database.id, props.view.id, props.view.config.componentId])} {...props} />;
}

function CustomDatabaseViewContent({ database, view, workspaceId, connectionId, onAskDraft, onNavigatePage, onOpenSource, readOnly = false }: CustomDatabaseViewProps) {
  const componentId = view.config.componentId ?? '';
  const version = view.config.pinnedVersion;
  const host = useMemo<ComponentHost>(() => ({ kind: 'database_view', databaseId: database.id, viewId: view.id }), [database.id, view.id]);
  const props = useMemo(() => view.config.props ?? {}, [view.config.props]);
  const data = useMemo(() => {
    const michiDatabase = pageDatabaseForMichiView(database);
    const groups = applyView(michiDatabase, view.config);
    return {
      database: { id: database.id, title: database.title, revision: database.revision },
      columns: database.columns,
      groups: groups.map(group => ({ key: group.key, label: group.label, rows: group.rows })),
      rows: groups.flatMap(group => group.rows),
    };
  }, [database, view.config]);
  const loaded = useComponentSource({ componentId, version, workspaceId, connectionId, events: { databaseId: database.id }, fallbackError: 'Custom view unavailable' });
  const source = componentId ? loaded.source : null;
  const error = componentId ? loaded.error : 'This custom view has no component selected.';
  const [displayedSource, setDisplayedSource] = useState<typeof source>(null);
  const [stopped, setStopped] = useState(false);
  const { state, call } = useComponentCapability({ connectionId, workspaceId, componentId, version: source?.version ?? version ?? 0, host, props, bindingKey: [view.config, view.edit], enabled: source !== null && !stopped && !readOnly });
  const stop = useCallback(() => setStopped(true), []);
  if (readOnly) return <div className="page-component-fallback" role="status"><strong>{source?.name ?? 'Custom view'}</strong><p>This database is read-only, so the component is paused.</p></div>;
  if (stopped) return <div className="page-component-fallback" role="status"><strong>{source?.name ?? 'Custom view'}</strong><p>This component was stopped. Reopen the view to run it again.</p></div>;
  if (!source && error) return <div className="page-component-fallback" role="status"><strong>Custom view unavailable</strong><p>{error}</p></div>;
  if (!source) return <div className="page-component-loading" role="status">Loading custom view…</div>;
  const displayed = displayedSource ?? source;
  return <section className="page-component-host" aria-label={`${displayed.name} custom database view`} data-component-id={componentId} data-component-version={displayed.version}>
    <div className="page-component-host-label">{displayed.name} · v{displayed.version}<ComponentSourceAttribution source={displayed.provenance} onOpenSource={onOpenSource} /></div>
    <SandboxFrame stable onPresented={() => setDisplayedSource(source)} scopeKey={JSON.stringify(host)} candidateReady={Boolean(state?.capability)} connectionId={connectionId} name={source.name} code={source.code} versionKey={source.version} initialHeight={view.config.height} props={props} data={data} capability={state?.capability ? { id: state.capabilityId, token: state.capability, call } : undefined} onAskDraft={onAskDraft} onNavigate={onNavigatePage} onStop={stop} />
    {error && <p className="page-component-notice" role="status">The update is unavailable. {error}</p>}
  </section>;
}
