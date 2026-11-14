import { useId } from 'react';
import { IS_MAC } from '../../../../lib/platform';
import { usePrefs } from '../../../../state/prefs';
import { useCompanionName } from '../../../../state/companion/companionName';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import { Switch } from '../../../ui/controls';
import { useBackgroundService, type BackgroundServiceControl } from '../../scheduled/useBackgroundService';
import { HIDE_DOCK_LABEL, KEEP_RUNNING_LABEL, OPEN_AT_LOGIN_LABEL, TRAY_LABEL, WINDOWS_CLOSED_TITLE } from './residencyCopy';
import { SettingsRow, SettingsSection } from './SettingsSection';
import { useSettingsPhone } from './settingsPhone';
import { useDesktopResidency } from './useDesktopResidency';

/**
 * The one notification level (DESIGN P4): every notification Michi raises,
 * in any window or from the desktop app while none is open, is an attention
 * record the backend decided, presented through the attention policy
 * (services/attention/policy.ts, shared attentionLevelAllows). The stored
 * value `approval-only` is "Only when something needs me". Michi keeps no
 * quiet hours: it stays quiet about what you are looking at.
 */
export const NOTIFICATION_OPTIONS: Array<{ value: 'all' | 'approval-only' | 'off'; label: string; description: string }> = [
  { value: 'all', label: 'All', description: 'also when a conversation or a scheduled job with Notify finishes, and Michi’s updates and morning brief.' },
  { value: 'approval-only', label: 'Only when something needs me', description: 'approvals, questions, what needs you in Today, and a task of yours that failed.' },
  { value: 'off', label: 'Off', description: 'No notifications.' },
];

export function NotificationsPane() {
  const { prefs, setPref } = usePrefs();
  const name = useCompanionName();
  const levelId = useId();
  return (
    <>
      <SettingsSection title="Notifications">
        <SettingsRow label="Notify me" labelFor={levelId}
          tip={`One level for every notification: your conversations, ${name}, scheduled jobs and agent runs, windows open or closed. `
            + NOTIFICATION_OPTIONS.filter((option) => option.value !== 'off').map((option) => `${option.label}: ${option.description}`).join(' ')}
          control={(
            <select id={levelId} className="ui-select settings-row__select" value={prefs.notifications}
              onChange={(event) => setPref('notifications', event.target.value as typeof prefs.notifications)}>
              {NOTIFICATION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          )} />
        <SettingsRow
          label="Sounds"
          tip="A short tone when a notification appears: one when an agent needs you, another when it finishes."
          control={(
            <Switch
              on={prefs.notificationSounds}
              disabled={prefs.notifications === 'off'}
              aria-label="Notification sounds"
              onChange={(value) => setPref('notificationSounds', value)}
            />
          )}
        />
      </SettingsSection>
      <WindowsClosedSection name={name} />
    </>
  );
}

/**
 * Whether "Keep Michi running after you quit" shows: the service is the
 * macOS LaunchAgent, so only where the desktop app has its bridge and either
 * says it is supported or runs on a Mac (where it says why it isn't). The
 * link to it in Settings › Scheduled jobs follows the same rule.
 */
export function keepRunningShown(service: Pick<BackgroundServiceControl, 'available' | 'status'>): boolean {
  return service.available && (!!service.status?.supported || IS_MAC);
}

/**
 * When Michi's windows are closed (DESIGN-v2 §5): stay in the menu bar or
 * notification area, hide the Dock icon (macOS), open at login (Windows),
 * and keep the backend running after Quit (macOS; the background service,
 * moved here from Settings › Scheduled jobs). Each row shows only where
 * this install can offer it; a phone leaves the desktop app's section out.
 */
function WindowsClosedSection({ name }: { name: string }) {
  const phone = useSettingsPhone();
  const control = useDesktopResidency();
  const service = useBackgroundService();
  if (phone) return null;
  const residency = control.residency;
  const status = service.status;
  const desktop = control.available || service.available;
  const residencyRows = control.available && residency;
  const serviceRow = keepRunningShown(service);
  const enabled = !!status?.enabled;

  const toggleService = async (next: boolean) => {
    const confirmed = await confirmDialog(next
      ? {
          title: 'Keep Michi running after you quit?',
          message: `Michi’s backend will keep running after you quit the app and start when you log in, so scheduled jobs run on time and ${name} can still notify you. Open chats reconnect in a moment.`,
          confirmLabel: 'Keep running',
        }
      : {
          title: 'Stop the background service?',
          message: `Michi’s backend will stop when you quit the app. Scheduled jobs run, and ${name} notifies you, only while Michi is open. Open chats reconnect in a moment.`,
          confirmLabel: 'Stop service',
        });
    if (confirmed) await service.setEnabled(next);
  };

  return (
    <SettingsSection title={WINDOWS_CLOSED_TITLE}>
      {!desktop && <SettingsRow label={TRAY_LABEL} description="Available in the Michi desktop app." />}
      {control.available && !residency && !control.error && <p className="settings-row__note" role="status">Checking…</p>}
      {residencyRows && (
        <>
          <SettingsRow label={TRAY_LABEL}
            tip={residency.tray.supported ? `Closing the last window keeps Michi running there, with ${name}’s status and what needs you.` : undefined}
            description={!residency.tray.supported && (residency.reason ?? 'Not available on this install.')}
            control={residency.tray.supported && (
              <Switch on={residency.tray.enabled} disabled={control.busy} aria-label={TRAY_LABEL}
                onChange={(on) => { void control.set({ tray: on }); }} />
            )} />
          {residency.hideDock.supported && (
            <SettingsRow label={HIDE_DOCK_LABEL}
              description={!residency.tray.enabled && `Needs “${TRAY_LABEL}”.`}
              control={<Switch on={residency.hideDock.enabled} disabled={control.busy || !residency.tray.enabled} aria-label={HIDE_DOCK_LABEL}
                onChange={(on) => { void control.set({ hideDock: on }); }} />} />
          )}
          {residency.openAtLogin.supported && (
            <SettingsRow label={OPEN_AT_LOGIN_LABEL}
              control={<Switch on={residency.openAtLogin.enabled} disabled={control.busy} aria-label={OPEN_AT_LOGIN_LABEL}
                onChange={(on) => { void control.set({ openAtLogin: on }); }} />} />
          )}
        </>
      )}
      {control.error && <p className="settings-row__note" role="alert">{control.error}</p>}
      {serviceRow && (
        <SettingsRow label={KEEP_RUNNING_LABEL}
          tip={status?.supported ? `Michi’s backend keeps running after you quit and starts when you log in, so scheduled jobs run on time and ${name} can notify you. `
            + 'Your Mac still pauses it while it sleeps; a job that was due then runs once when the Mac wakes.' : undefined}
          description={!status ? <span role="status">Checking…</span>
            : !status.supported ? status.reason ?? 'Not available on this install.'
              : enabled && !status.running && !service.busy ? <span role="status">Not running right now</span> : undefined}
          control={status?.supported && <>
            {service.busy && <span className="settings-row__state" role="status">{enabled ? 'Stopping…' : 'Starting…'}</span>}
            <Switch on={enabled} disabled={service.busy} aria-label={KEEP_RUNNING_LABEL}
              onChange={(next) => { if (!service.busy) void toggleService(next); }} />
          </>}>
          {service.error && <p role="alert" className="settings-row__note">{service.error}</p>}
        </SettingsRow>
      )}
    </SettingsSection>
  );
}
