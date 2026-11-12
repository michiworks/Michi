import React, { useId } from 'react';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { useChatProjects } from '../../../state/chatStore';
import { usePrefs } from '../../../state/prefs';
import { useBackendConnections } from '../../../state/useBackendConnections';
import { useAuthSession } from '../../../services/auth';
import { LOCAL_BACKEND_CONNECTION_ID } from '../../../config/backendConnections';
import { modelDisplayLabel } from '../../../lib/modelLabel';
import { ACCENT_HUES, resolveAccent } from '../tokens';
import { NOTIFICATION_OPTIONS } from '../pages/settings/NotificationsPane';
import { useLibrarySkillCount } from '../pages/settings/skillsModel';
import { SETTINGS_GROUPS, SETTINGS_PAGES, settingsPageLabel, type SettingsPage } from './settingsPages';

type Tone = 'ok' | 'error';

/** "Claude · Opus 5.5": the runtime's first word, then its model when the runtime reports one. */
function useRuntimeSummary(): string | undefined {
  const { agentStatus } = useChatProjects();
  if (!agentStatus) return undefined;
  const model = agentStatus.model ? modelDisplayLabel(agentStatus.runtime, agentStatus.model, []) : null;
  if (!model || model === 'Default model') return agentStatus.label;
  return `${agentStatus.label.split(' ')[0]} · ${model}`;
}

function useMachinesSummary(): { value: string; tone?: Tone } {
  const remotes = useBackendConnections().filter((connection) => connection.id !== LOCAL_BACKEND_CONNECTION_ID);
  if (remotes.some((connection) => connection.tunnelStatus === 'error')) return { value: 'Connection issue', tone: 'error' };
  return { value: remotes.length === 0 ? 'This machine' : `${remotes.length + 1} machines` };
}

function useAppearanceSummary(): string {
  const { prefs } = usePrefs();
  const accent = resolveAccent(prefs.terminalAccentOverrides, prefs.terminalPalette);
  const hue = ACCENT_HUES.find(([color]) => color === accent)?.[1];
  const palette = prefs.terminalPalette[0].toUpperCase() + prefs.terminalPalette.slice(1);
  return hue ? `${palette} · ${hue[0].toUpperCase()}${hue.slice(1)}` : palette;
}

interface PhoneRowProps {
  id: string;
  label: string;
  /** A second line under the label. */
  sub?: string;
  icon?: LucideIcon;
  value?: string | number;
  tone?: Tone;
  /** Appended to the accessible name, e.g. "needs attention". */
  status?: string;
  onClick: () => void;
  rowRef: (id: string, button: HTMLButtonElement | null) => void;
  children?: React.ReactNode;
}

function PhoneRow({ id, label, sub, icon: Icon, value, tone, status, onClick, rowRef, children }: PhoneRowProps) {
  const valueId = useId();
  const hasValue = value !== undefined && value !== '';
  return (
    <button type="button" className="settings-phone__row" data-row={id}
      ref={(button) => rowRef(id, button)}
      aria-label={status ? `${label}, ${status}` : label}
      aria-describedby={hasValue ? valueId : undefined}
      onClick={onClick}>
      {children ?? (Icon && <span className="settings-phone__icon" aria-hidden="true"><Icon size={16} strokeWidth={1.75} /></span>)}
      {sub ? <span className="settings-phone__text"><span className="settings-phone__label">{label}</span><span className="settings-phone__sub">{sub}</span></span>
        : <span className="settings-phone__label">{label}</span>}
      {hasValue && <span id={valueId} className="settings-phone__value" data-tone={tone}>
        {tone && <span className="settings-phone__dot" aria-hidden="true" />}{value}
      </span>}
      <ChevronRight className="settings-phone__chevron" size={16} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}

function PhoneGroup({ title, children }: { title: string; children: React.ReactNode }) {
  const headingId = useId();
  return <>
    <h2 id={headingId} className="settings-phone__heading">{title}</h2>
    <div className="settings-phone__group" role="group" aria-labelledby={headingId}>{children}</div>
  </>;
}

/**
 * Settings as a phone lists it: one row per topic, grouped, each with its
 * current value, so the list says what is set before anything is opened.
 * Every row opens its page here; Skills, Trash and Archived show how many items they hold.
 * The account sits above the groups; keyboard shortcuts stay on desktop.
 */
export function PhoneSettingsMenu({ name, onOpen, history, metaAgentAlert, rowRef }: {
  /** The agent's name: Settings › <name>'s row. */
  name: string;
  onOpen: (page: SettingsPage) => void;
  /** Counts for Trash and Archived; zero shows none. */
  history: { trash: number; archived: number };
  /** Pages upkeep needs attention: Settings › <name>'s row says so. */
  metaAgentAlert: boolean;
  rowRef: (id: string, button: HTMLButtonElement | null) => void;
}) {
  const { prefs } = usePrefs();
  const user = useAuthSession()?.user;
  const runtime = useRuntimeSummary();
  const machines = useMachinesSummary();
  const appearance = useAppearanceSummary();
  const skills = useLibrarySkillCount();
  const values: Partial<Record<SettingsPage, Partial<PhoneRowProps>>> = {
    runtime: { value: runtime },
    companion: metaAgentAlert ? { value: 'Needs attention', tone: 'error', status: 'needs attention' } : {},
    skills: { value: skills || undefined },
    machines: { ...machines, status: machines.tone === 'error' ? 'connection issue' : undefined },
    appearance: { value: appearance },
    notifications: { value: NOTIFICATION_OPTIONS.find((option) => option.value === prefs.notifications)?.label },
    links: { value: prefs.linkOpenTarget === 'external' ? 'System browser' : 'Michi Browser' },
    trash: { value: history.trash || undefined },
    archived: { value: history.archived || undefined },
  };
  return (
    <nav className="terminal-settings-categories settings-phone" aria-label="Settings sections">
      {user && <div className="settings-phone__group settings-phone__group--account">
        <PhoneRow id="account" label={user.name || user.email} sub={user.name ? user.email : 'Signed in'}
          onClick={() => onOpen('account')} rowRef={rowRef}>
          <span className="settings-phone__avatar" aria-hidden="true">
            {user.image ? <img src={user.image} alt="" /> : (user.name || user.email).slice(0, 1).toUpperCase()}
          </span>
        </PhoneRow>
      </div>}
      {SETTINGS_GROUPS.map((group) => {
        const pages = group.pages.filter((item) => item !== 'account' && SETTINGS_PAGES[item].only !== 'window');
        return <PhoneGroup key={group.title} title={group.title}>
          {pages.map((item) => <PhoneRow key={item} id={item} label={settingsPageLabel(item, name)} icon={SETTINGS_PAGES[item].icon}
            onClick={() => onOpen(item)} rowRef={rowRef} {...values[item]} />)}
        </PhoneGroup>;
      })}
      <p className="settings-phone__note">Keyboard shortcuts and pane layout are in Settings on a computer.</p>
    </nav>
  );
}
