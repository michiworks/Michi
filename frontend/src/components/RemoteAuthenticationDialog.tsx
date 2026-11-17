import { lazy, Suspense } from 'react';
import { AnimatePresence, useIsPresent } from 'motion/react';
import { remoteSignInLabel } from 'michi-shared';
import {
  closeRemoteAuthentication, requestRemoteAuthentication, usePendingRemoteAuthentications, useRemoteAuthentication,
  type RemoteAuthenticationRequest,
} from '../state/remoteAuthentication';
import { ModalShell } from './ui/ModalShell';
import { Button } from './ui/controls';
import { NoticeMotion, useAnnounceNew } from './terminal/shellNoticeParts';
import './RemoteAuthenticationDialog.css';
const AuthenticationTerminal = lazy(() => import('./RemoteAuthenticationTerminal'));

/**
 * The sign-ins background work asked for, in the shell's notice corner
 * (ShellNotices). Each waits for its Sign in, which opens the dialog; none
 * takes focus while the user may be typing. A notice leaves while its dialog
 * is open and once its sign-in completes.
 */
export function RemoteSignInNotices() {
  const open = useRemoteAuthentication();
  const waiting = usePendingRemoteAuthentications().filter(issue => issue.key !== open?.key);
  useAnnounceNew(waiting.map(issue => issue.key), () => `${waiting[waiting.length - 1]?.target.host}: sign-in needs attention`);
  return <AnimatePresence initial={false}>
    {waiting.map(issue => <NoticeMotion key={issue.key} noticeKey={issue.key}><SignInNotice issue={issue} /></NoticeMotion>)}
  </AnimatePresence>;
}

function SignInNotice({ issue }: { issue: RemoteAuthenticationRequest }) {
  // Leaving, it keeps its words but takes no input.
  const present = useIsPresent();
  return <section className="shell-notice remote-auth-service-notice" aria-label={`Sign-in for ${issue.target.host}`}
    aria-hidden={present ? undefined : true} inert={!present}>
    <p>{issue.target.host}: sign-in needs attention.</p>
    <Button size="sm" variant="primary" onClick={() => requestRemoteAuthentication(issue, true)}>{remoteSignInLabel()}</Button>
  </section>;
}

export function RemoteAuthenticationDialog() {
  const request = useRemoteAuthentication();
  if (!request) return null;
  // No fade-out: closing ends the sign-in terminal session at once (the
  // terminal is destroyed and a late reconnect never runs), so the dialog
  // unmounts with it instead of lingering as a live ghost.
  return <ModalShell open onClose={closeRemoteAuthentication} title={remoteSignInLabel()} width={680} maxHeight="85vh" captureEscape>
    <Suspense fallback={<p role="status">Opening authentication terminal…</p>}>
      <AuthenticationTerminal key={request.key} request={request} />
    </Suspense>
  </ModalShell>;
}
