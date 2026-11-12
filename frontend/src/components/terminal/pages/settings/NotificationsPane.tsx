import { IS_MAC } from '../../../../lib/platform';
import { usePrefs } from '../../../../state/prefs';
import { useCompanionName } from '../../../../state/companion/companionName';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import { Switch } from '../../../ui/controls';
import { useBackgroundService, type BackgroundServiceControl } from '../../scheduled/useBackgroundService';
import { Radio } from './controls';
import { HIDE_DOCK_LABEL, KEEP_RUNNING_LABEL, OPEN_AT_LOGIN_LABEL, TRAY_LABEL, WINDOWS_CLOSED_TITLE } from './residencyCopy';
import { SettingsRow, SettingsSection } from './SettingsSection';
import { useOpenSettingsPage, useSettingsPhone } from './settingsPhone';
import { useDesktopResidency } from './useDesktopResidency';

/**
 * The chat notification level: approvals, questions and finished or failed
 * replies in every conversation, the agent's included (DESIGN-v2 §1.5, §5.2),
 * presented through the attention policy (services/attention/policy.ts).
 * Quiet hours don't apply to it; the agent's own notifications have their
 * level under Settings › <name>.
 */
export const NOTIFICATION_OPTIONS: Array<{ value: 'all' | 'approval-only' | 'off'; label: string; description: string }> = [
  { value: 'all', label: 'All', description: 'When an agent needs your input, finishes or fails.' },
  { value: 'approval-only', label: 'Approval only', description: 'Only when an agent needs your approval or an answer.' },
  { value: 'off', label: 'Off', description: 'No notifications.' },
];

export function NotificationsPane() {
  const { prefs, setPref } = usePrefs();
  const name = useCompanionName();
  const openSettingsPage = useOpenSettingsPage();
  return (
    <>
      <SettingsSection title="Notifications"
        intro={`Approvals, questions and finished or failed replies in every conversation, your conversation with ${name} included, whether Michi’s windows are open or closed. Quiet hours don’t apply to them; Michi stays quiet only about a conversation you are looking at.`}>
        <div className="settings-section__block">
          <Radio label="Notification level" opts={NOTIFICATION_OPTIONS} value={prefs.notifications} onChange={(value) => setPref('notifications', value)} />
          <p className="settings-row__note">
            What {name} tells you about on its own (its check-ins, the morning brief, Today) has its own level:{' '}
            <button type="button" className="settings-row__link" onClick={() => openSettingsPage('companion', 'Notifications')}>
              Settings › {name} › Notifications
            </button>
          </p>
        </div>
        <SettingsRow
          label="Notification sounds"
          description="A short tone when a notification appears: one when an agent needs you, another when it finishes."
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
    <SettingsSection title={WINDOWS_CLOSED_TITLE}
      intro={desktop ? `Whether Michi, and ${name} with it, keeps running and notifying you when no Michi window is open.` : undefined}>
      {!desktop && <SettingsRow label={TRAY_LABEL} description="Available in the Michi desktop app." />}
      {control.available && !residency && !control.error && <p className="settings-row__note" role="status">Checking…</p>}
      {residencyRows && (
        <>
          <SettingsRow label={TRAY_LABEL}
            description={residency.tray.supported
              ? `Closing the last window keeps Michi running there, with ${name}’s status and what needs you.`
              : residency.reason ?? 'Not available on this install.'}
            control={residency.tray.supported && (
              <Switch on={residency.tray.enabled} disabled={control.busy} aria-label={TRAY_LABEL}
                onChange={(on) => { void control.set({ tray: on }); }} />
            )} />
          {residency.hideDock.supported && (
            <SettingsRow label={HIDE_DOCK_LABEL}
              description={residency.tray.enabled ? 'Michi stays in the menu bar while no window is open.' : `Needs “${TRAY_LABEL}”.`}
              control={<Switch on={residency.hideDock.enabled} disabled={control.busy || !residency.tray.enabled} aria-label={HIDE_DOCK_LABEL}
                onChange={(on) => { void control.set({ hideDock: on }); }} />} />
          )}
          {residency.openAtLogin.supported && (
            <SettingsRow label={OPEN_AT_LOGIN_LABEL} description="Michi starts in the notification area when you sign in."
              control={<Switch on={residency.openAtLogin.enabled} disabled={control.busy} aria-label={OPEN_AT_LOGIN_LABEL}
                onChange={(on) => { void control.set({ openAtLogin: on }); }} />} />
          )}
        </>
      )}
      {control.error && <p className="settings-row__note" role="alert">{control.error}</p>}
      {serviceRow && (
        <SettingsRow label={KEEP_RUNNING_LABEL}
          description={!status ? <span role="status">Checking…</span>
            : !status.supported ? status.reason ?? 'Not available on this install.'
              : <span role="status">
                {status.running
                  ? `Michi’s backend runs on its own, so scheduled jobs keep running after you quit and ${name} can wake Michi to notify you. It starts when you log in.`
                  : `Michi’s backend stops when you quit. Scheduled jobs and ${name}’s check-ins run only while Michi is open.`}
              </span>}
          control={status?.supported && <>
            <span className="settings-row__state">{service.busy ? (enabled ? 'Stopping…' : 'Starting…') : enabled ? 'On' : 'Off'}</span>
            <Switch on={enabled} disabled={service.busy} aria-label={KEEP_RUNNING_LABEL}
              onChange={(next) => { if (!service.busy) void toggleService(next); }} />
          </>}>
          {service.error && <p role="alert" className="settings-row__note">{service.error}</p>}
          {status?.supported && (
            <p className="settings-row__note">Your Mac still pauses Michi while it sleeps. A job that was due during sleep runs once when the Mac wakes.</p>
          )}
        </SettingsRow>
      )}
    </SettingsSection>
  );
}
