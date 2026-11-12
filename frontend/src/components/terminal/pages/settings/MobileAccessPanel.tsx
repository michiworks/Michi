import { useEffect, useId, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import type { MobileAccessLink, MobileAccessProvider, MobileAccessStatus } from 'michi-shared';
import { Button, Switch } from '../../../ui/controls';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import { createMobileAccessLink, mobileAccessRequest, setPhoneTerminal, type MobileAccessAction } from '../../../../services/api/mobileAccess';
import { openExternalUrl } from '../../../../services/openUrl';
import { copyText } from '../../../../lib/clipboard';
import { LOCAL_BACKEND_CONNECTION_ID, type BackendConnectionSummary } from '../../../../config/backendConnections';
import { useNow } from '../../../../hooks/useNow';
import { SettingsRow, SettingsSection } from './SettingsSection';
import './mobileAccess.css';

/** True when this page itself was opened through the phone access address. */
function servedThrough(url: string | undefined): boolean {
  if (!url) return false;
  try { return new URL(url).origin === window.location.origin; } catch { return false; }
}

export function MobileAccessPanel({ connections }: { connections: BackendConnectionSummary[] }) {
  const machineId = useId();
  const providerId = useId();
  const [machine, setMachine] = useState(LOCAL_BACKEND_CONNECTION_ID);
  const [status, setStatus] = useState<MobileAccessStatus | null>(null);
  const [link, setLink] = useState<MobileAccessLink | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);
  const mutation = useRef(0);
  const acting = useRef(false);
  useEffect(() => {
    const revision = ++generation.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setStatus(null); setLink(null); setError(''); setBusy(false); setCopied(false); acting.current = false;
    const refresh = async () => {
      const version = mutation.current;
      try {
        if (acting.current) { timer = setTimeout(refresh, 3000); return; }
        const next = await mobileAccessRequest(machine, undefined, controller.signal);
        if (generation.current !== revision) return;
        if (version !== mutation.current || acting.current) { timer = setTimeout(refresh, 3000); return; }
        setStatus(next); setError('');
        if (next.state !== 'connected') setLink(null);
      } catch (err) { if (!controller.signal.aborted && generation.current === revision && version === mutation.current && !acting.current) setError((err as Error).message); }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 3000);
    };
    void refresh();
    return () => { ++generation.current; controller.abort(); clearTimeout(timer); };
  }, [machine]);
  useEffect(() => {
    if (machine !== LOCAL_BACKEND_CONNECTION_ID && !connections.some(c => c.id === machine)) setMachine(LOCAL_BACKEND_CONNECTION_ID);
  }, [connections, machine]);
  useEffect(() => {
    if (status?.provider !== 'tailscale' || status.state !== 'connected') return;
    let cancelled = false;
    const revision = generation.current;
    const version = mutation.current;
    void createMobileAccessLink(machine).then(next => {
      if (!cancelled && revision === generation.current && version === mutation.current) setLink(next);
    }, err => { if (!cancelled && revision === generation.current && version === mutation.current) setError((err as Error).message); });
    return () => { cancelled = true; };
  }, [machine, status?.provider, status?.state, status?.url]);
  const now = useNow(1_000, !!link && !link.reusable);
  const activeLink = link && (link.reusable || link.expiresAt > now) ? link : null;
  const qr = useMemo(() => {
    if (!activeLink) return null;
    const code = qrcode(0, 'M'); code.addData(activeLink.url); code.make();
    return code;
  }, [activeLink]);
  const act = async (action: MobileAccessAction) => {
    if (acting.current) return;
    // Turning it off from a device connected through it ends that device's session.
    if (action === 'stop' && machine === LOCAL_BACKEND_CONNECTION_ID && servedThrough(status?.url) && !(await confirmDialog({
      title: 'Turn off phone access?',
      message: 'This page is open through phone access, so turning it off ends this session. Turn it on again from Michi on this machine.',
      confirmLabel: 'Turn off',
    }))) return;
    if (acting.current) return;
    const revision = generation.current;
    ++mutation.current; acting.current = true;
    setBusy(true); setError(''); setCopied(false);
    try {
      if (action === 'link') {
        const next = await createMobileAccessLink(machine);
        if (generation.current === revision) setLink(next);
      } else {
        const next = await mobileAccessRequest(machine, action);
        if (generation.current === revision) { setStatus(next); setLink(null); }
      }
    } catch (err) { if (generation.current === revision) setError((err as Error).message); }
    finally { if (generation.current === revision) { acting.current = false; setBusy(false); } }
  };
  const toggleTerminal = async (enabled: boolean) => {
    if (acting.current) return;
    if (enabled && !(await confirmDialog({
      title: 'Allow terminals from your phone?',
      message: 'Your phone link will be able to open a shell on this machine and run any command as you, the same as typing at this computer. Only your sign-in can open the link, and you can turn this off here at any time.',
      confirmLabel: 'Allow',
    }))) return;
    if (acting.current) return;
    const revision = generation.current;
    ++mutation.current; acting.current = true;
    setBusy(true); setError('');
    try {
      const next = await setPhoneTerminal(machine, enabled);
      if (generation.current === revision) setStatus(next);
    } catch (err) { if (generation.current === revision) setError((err as Error).message); }
    finally { if (generation.current === revision) { acting.current = false; setBusy(false); } }
  };
  const running = status && ['starting', 'connected', 'reconnecting'].includes(status.state);
  const tailscale = status?.provider === 'tailscale';
  const setup = status?.tailscale;
  const ready = !tailscale || setup?.state === 'ready';
  // One row: what phone access does, then which machine and the switch for it.
  return <SettingsSection className="mobile-access" title="Phone access"
    aside={status && <span role="status">{{ stopped: 'Off', starting: 'Connecting…', connected: 'Connected', reconnecting: 'Reconnecting…', error: 'Unavailable' }[status.state]}</span>}>
    <SettingsRow label="Open on your phone"
      description={tailscale ? 'Open this machine’s Michi on your phone through your private Tailscale network.' : 'Open this machine’s Michi on your phone.'}
      control={<>
        <select id={machineId} className="ui-select settings-row__select" aria-label="Machine" value={machine} onChange={event => setMachine(event.target.value)}>
          <option value="local">This machine</option>{connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <Button disabled={busy || !status || (!running && (!status.available || !ready))} variant={running ? 'secondary' : 'primary'} onClick={() => void act(running ? 'stop' : 'start')}>{running ? 'Turn off' : 'Enable phone access'}</Button>
      </>}>
      {(error || status?.error) && <p role="alert" className="settings-row__note">{error || status?.error}</p>}
    </SettingsRow>
    {tailscale && <div className="mobile-access__setup">
      <ol>
        <li><strong>Connect this machine.</strong> {setup?.account ? <>Signed in as {setup.account}.</> : setup?.message || 'Checking Tailscale…'}</li>
        <li><strong>Connect your phone.</strong> Install Tailscale on your phone, sign in with the same account and allow its VPN connection. <button type="button" className="mobile-access__text-link" onClick={() => openExternalUrl('https://tailscale.com/download')}>Get Tailscale</button></li>
        <li><strong>Open Michi.</strong> Scan the code below inside Michi on your iPhone to connect the app. Your phone’s Camera app opens the web version, which you can bookmark or add to your home screen.</li>
      </ol>
      {setup?.state === 'not-installed' && <Button onClick={() => openExternalUrl('https://tailscale.com/download')}>Install Tailscale on this machine</Button>}
      {setup?.state === 'not-running' && setup.canOpenApp && <Button disabled={busy} onClick={() => void act('open-app')}>Open Tailscale</Button>}
      {setup?.state === 'needs-login' && <Button disabled={busy} onClick={() => void act('login')}>Connect Tailscale</Button>}
      {setup?.state === 'needs-approval' && !setup.actionUrl && <Button onClick={() => openExternalUrl('https://login.tailscale.com/admin/machines')}>Approve this machine</Button>}
      {setup?.actionUrl && <Button onClick={() => openExternalUrl(setup.actionUrl!)}>{setup.state === 'needs-login' ? 'Continue Tailscale sign-in' : 'Allow Tailscale HTTPS'}</Button>}
      {setup?.state === 'not-running' && !setup.canOpenApp && <p>Start the Tailscale app or service on this computer, then connect it to your account.</p>}
    </div>}
    {status?.state === 'connected' && !activeLink?.reusable && <div className="mobile-access__actions">
      <Button disabled={busy} onClick={() => void act('link')}>{activeLink ? 'New sign-in link' : 'Connect phone'}</Button>
    </div>}
    {status && typeof status.terminal === 'boolean' && <SettingsRow label="Terminal"
      description={status.terminal
        ? 'On. Your phone can open terminals on this machine and use the ones open here. Turning this off disconnects the phone; the terminals keep running here.'
        : 'Open terminals from your phone. They run on this machine, with your account.'}
      control={<Switch on={status.terminal} disabled={busy} aria-label="Terminal on phone" onChange={next => void toggleTerminal(next)} />} />}
    {activeLink && qr && <div className="mobile-access__link">
      <svg role="img" aria-label="Scan to connect to Michi" viewBox={`-4 -4 ${qr.getModuleCount() + 8} ${qr.getModuleCount() + 8}`} width="192" height="192" shapeRendering="crispEdges">
        <rect x="-4" y="-4" width={qr.getModuleCount() + 8} height={qr.getModuleCount() + 8} fill="white" />
        <path fill="black" d={Array.from({ length: qr.getModuleCount() }, (_, r) => Array.from({ length: qr.getModuleCount() }, (_, c) => qr.isDark(r, c) ? `M${c} ${r}h1v1h-1z` : '').join('')).join('')} />
      </svg>
      <div><p>{'Keep Tailscale connected on your phone, then scan inside Michi or with your camera.'}</p><p>{activeLink.reusable ? 'Reuse or bookmark this link while phone access is enabled.' : <>One use · expires in {Math.max(1, Math.ceil((activeLink.expiresAt - now) / 60_000))} min</>}</p>
        <Button onClick={() => { const revision = generation.current; void copyText(activeLink.url).then((ok) => { if (revision !== generation.current) return; if (ok) setCopied(true); else setError('Could not copy. Scan the code to connect.'); }); }}>{copied ? 'Copied' : activeLink.reusable ? 'Copy phone link' : 'Copy sign-in link'}</Button>
      </div>
    </div>}
    {link && !activeLink && <p>The sign-in link expired. Create a new one to connect.</p>}
    {status?.url && <a className="mobile-access__url" href={status.url} target="_blank" rel="noreferrer">{status.url}</a>}
    {tailscale && status?.state === 'connected' && <p>On iPhone, enable VPN On Demand in Tailscale to reconnect automatically. Another VPN may interrupt the connection. This machine must stay awake with Michi running.</p>}
  </SettingsSection>;
}
