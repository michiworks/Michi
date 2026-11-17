// Michi: what a form, poll or choice says once its submission is stored (useBlockSend `submission`), or when storing it failed.
import type { BlockSubmission } from 'michi-shared';
import { relativeTime } from '../../../../../../../../../../lib/relativeTime';

function ago(at: number, now: number): string {
  const text = relativeTime(at, now);
  return text === 'now' ? 'just now' : text === 'yesterday' ? text : `${text} ago`;
}

export function SubmittedNote({ submission, now = Date.now() }: { submission: BlockSubmission; now?: number }) {
  const at = new Date(submission.submittedAt);
  return <p className="desk-submitted">
    Submitted · <time dateTime={at.toISOString()} title={at.toLocaleString()}>{ago(submission.submittedAt, now)}</time>
  </p>;
}

export function SubmitFailedNote() {
  return <p className="desk-submit-failed" role="alert">Couldn’t save your answer, so it wasn’t sent. Try again.</p>;
}
