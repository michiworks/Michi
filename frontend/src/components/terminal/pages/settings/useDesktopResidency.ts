import React from 'react';
import { getElectron, type DesktopResidency, type DesktopResidencyPatch } from '../../../../lib/electronBridge';

export interface DesktopResidencyControl {
  /** True inside a desktop build whose bridge has the residency calls (DESIGN-v2 §5.1). */
  available: boolean;
  /** null while it loads, when it could not be read, or outside the desktop app. */
  residency: DesktopResidency | null;
  busy: boolean;
  error: string | null;
  set(patch: DesktopResidencyPatch): Promise<void>;
}

/** Electron's error text without the IPC wrapper ("Error invoking remote method 'x': Error: …"). */
function ipcMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(reason);
}

/**
 * Reads and changes how Michi stays around when its windows are closed: the
 * menu bar / notification area icon, hiding the Dock icon, and opening at
 * login (Electron main owns them; desktop:getResidency / desktop:setResidency).
 */
export function useDesktopResidency(): DesktopResidencyControl {
  const electron = getElectron();
  const available = !!electron?.getResidency && !!electron.setResidency;
  const [residency, setResidency] = React.useState<DesktopResidency | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!available) return;
    let cancelled = false;
    electron!.getResidency!()
      .then((next) => { if (!cancelled) setResidency(next); })
      .catch((reason: unknown) => { if (!cancelled) { setResidency(null); setError(ipcMessage(reason)); } });
    return () => { cancelled = true; };
  }, [available, electron]);

  const set = React.useCallback(async (patch: DesktopResidencyPatch) => {
    if (!available) return;
    setBusy(true);
    setError(null);
    try {
      setResidency(await electron!.setResidency!(patch));
    } catch (reason) {
      setError(ipcMessage(reason));
      try { setResidency(await electron!.getResidency!()); } catch { /* keep the last answer */ }
    } finally {
      setBusy(false);
    }
  }, [available, electron]);

  return { available, residency, busy, error, set };
}
