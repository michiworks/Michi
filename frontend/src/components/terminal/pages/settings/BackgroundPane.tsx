import { confirmDialog } from '../../../ui/ConfirmDialog';
import { shouldShowLifetimeRows } from './desktopLifetime';
import React from 'react';
import type { ScheduledJobSettings } from 'michi-shared';
import { getScheduledJobSettings, updateScheduledJobSettings } from '../../../../services/api/scheduledJobs';
import { useCompanionName } from '../../../../state/companion/companionName';
import { useBackgroundService } from '../../scheduled/useBackgroundService';
import { useDesktopLifetime } from '../../scheduled/useDesktopLifetime';
import { Button, Switch } from '../../../ui/controls';
import { Radio } from './controls';
import { keepRunningShown } from './NotificationsPane';
import { KEEP_RUNNING_LABEL, WINDOWS_CLOSED_TITLE } from './residencyCopy';
import { SettingsRow, SettingsSection } from './SettingsSection';
import { useOpenSettingsPage, useSettingsPhone } from './settingsPhone';

/**
 * Settings › Scheduled jobs: the default thread of a new job, and where the
 * always-on backend is now. Its switch ("Keep Michi running after you
 * quit") moved to Settings › Notifications › When Michi’s windows are closed
 * (DESIGN-v2 §1.5); this page keeps a link to it.
 */
export function BackgroundPane({ onOpenScheduled }: { onOpenScheduled?: () => void }) {
  // The background service belongs to the desktop app; a phone only links to the jobs.
  const phone = useSettingsPhone();
  const openSettingsPage = useOpenSettingsPage();
  const name = useCompanionName();
  // The link shows only where Settings › Notifications shows the switch it leads to.
  const service = useBackgroundService();
  const lifetime = useDesktopLifetime();
  return (
    <SettingsSection title="Background">
      <ScheduledJobDefaults />
      <LifetimeRows lifetime={lifetime} phone={phone} />
      {!phone && keepRunningShown(service) && (
        <SettingsRow label={KEEP_RUNNING_LABEL}
          description={`So scheduled jobs run on time, and ${name} can still notify you, after you quit. It is under Settings › Notifications › ${WINDOWS_CLOSED_TITLE}.`}
          control={<Button size="sm" onClick={() => openSettingsPage('notifications', KEEP_RUNNING_LABEL)}>Open</Button>} />
      )}
      {onOpenScheduled && (
        <SettingsRow label="Manage scheduled jobs"
          control={<Button size="sm" onClick={onOpenScheduled}>Open</Button>} />
      )}
    </SettingsSection>
  );
}

function LifetimeRows({
  lifetime,
  phone,
}: {
  lifetime: ReturnType<typeof useDesktopLifetime>;
  phone: boolean;
}) {
  if (!shouldShowLifetimeRows(lifetime.available, phone, lifetime.status)) return null;
  const status = lifetime.status;
  const toggleTray = async (next: boolean) => {
    const confirmed = await confirmDialog(next
      ? {
          title: 'Keep Michi in the system tray?',
          message: 'Closing the last window will leave Michi running in the tray so chats stay connected. Use Quit or the tray menu to exit.',
          confirmLabel: 'Keep in tray',
          danger: false,
        }
      : {
          title: 'Quit when the last window closes?',
          message: 'Michi will quit when you close the last window. Scheduled jobs then run only while Michi is open.',
          confirmLabel: 'Quit with last window',
        });
    if (confirmed) await lifetime.setKeepInBackground(next);
  };
  const toggleLogin = async (next: boolean) => {
    const confirmed = await confirmDialog(next
      ? {
          title: 'Open Michi when you sign in?',
          message: 'Michi will start when you sign in to Windows. Hidden start is used only while the tray is working. You can turn this off here or in Windows Settings.',
          confirmLabel: 'Open at sign-in',
          danger: false,
        }
      : {
          title: 'Stop opening Michi at sign-in?',
          message: 'Michi will no longer start when you sign in to Windows.',
          confirmLabel: 'Don’t open at sign-in',
        });
    if (confirmed) await lifetime.setOpenAtLogin(next);
  };
  const trayOn = !!status?.keepInBackground;
  const loginOn = !!status?.openAtLogin;
  const ready = !!status?.supported;
  const trayDescription = !status ? <span role="status">Checking…</span>
    : !status.supported ? status.reason ?? 'Not available on this install.'
      : <span role="status">
        {status.trayActive
          ? 'Closing the last window leaves Michi running in the tray. Use Show Michi or Quit from the tray.'
          : trayOn
            ? 'The tray is unavailable, so closing the last window will quit. Michi will not start hidden.'
            : 'Michi quits when you close the last window.'}
      </span>;
  const loginDescription = !status ? <span role="status">Checking…</span>
    : !status.supported ? status.reason ?? 'Not available on this install.'
      : <span role="status">
        {status.openAtLogin
          ? (status.canStartHidden
            ? 'Michi starts when you sign in, hidden while the tray is working.'
            : 'Michi starts when you sign in. It stays visible unless the tray is working.')
          : 'Michi starts only when you open it.'}
      </span>;
  return (
    <>
      <SettingsRow label="Keep Michi in the system tray" description={trayDescription} control={ready && <>
        <span className="settings-row__state">{lifetime.busy ? 'Updating…' : trayOn ? 'On' : 'Off'}</span>
        <Switch on={trayOn} disabled={lifetime.busy} aria-label="Keep Michi in the system tray"
          onChange={(next) => { if (!lifetime.busy) void toggleTray(next); }} />
      </>}>
        {lifetime.error && <p role="alert" className="settings-row__note">{lifetime.error}</p>}
      </SettingsRow>
      <SettingsRow label="Open Michi when I sign in" description={loginDescription} control={ready && <>
        <span className="settings-row__state">{loginOn ? 'On' : 'Off'}</span>
        <Switch on={loginOn} disabled={lifetime.busy} aria-label="Open Michi when I sign in"
          onChange={(next) => { if (!lifetime.busy) void toggleLogin(next); }} />
      </>} />
    </>
  );
}

function ScheduledJobDefaults() {
  const [settings, setSettings] = React.useState<ScheduledJobSettings | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    getScheduledJobSettings().then((value) => { if (active) setSettings(value); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : 'Could not load defaults'); });
    return () => { active = false; };
  }, []);
  const save = async (patch: Partial<ScheduledJobSettings>) => {
    setSaving(true);
    setError(null);
    try { setSettings(await updateScheduledJobSettings(patch)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save default'); }
    finally { setSaving(false); }
  };
  const status = !settings && !error && <p className="settings-row__note" role="status">Loading…</p>;
  const failure = error && <p className="settings-row__note" role="alert">{error}</p>;
  return <>
    <SettingsRow label="Default scheduled job thread"
      description="Applies to new scheduled jobs. You can change the thread mode for each job.">
      {settings && <fieldset disabled={saving}>
        <Radio label="Default scheduled job thread" value={settings.sessionMode} onChange={(sessionMode) => void save({ sessionMode })} opts={[
          { value: 'persistent', label: 'One ongoing thread', description: 'Each job continues its own conversation across runs.' },
          { value: 'fresh', label: 'New thread each run', description: 'Each run starts a separate conversation.' },
        ]} />
      </fieldset>}
      {status}
      {failure}
    </SettingsRow>
    {settings && <SettingsRow label="Ask before agents create scheduled jobs"
      description={settings.requireCreateApproval
        ? 'An agent shows you each new job and saves it only after you approve.'
        : 'An agent saves a new job right away, and the conversation shows what it scheduled. Changing, running or deleting a job always asks.'}
      control={<Switch on={settings.requireCreateApproval} disabled={saving} aria-label="Ask before agents create scheduled jobs"
        onChange={(requireCreateApproval) => { if (!saving) void save({ requireCreateApproval }); }} />} />}
  </>;
}
