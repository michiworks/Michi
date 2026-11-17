import { DocIcon } from '../icons';
import './source.css';

/** The highlighted message's mark naming the page that cites it. */
export function SourceReferenceMark({ label }: { label: string | null }) {
  if (!label) return null;
  return (
    <div className="source-ref-mark">
      <DocIcon size="sm" aria-hidden="true" />
      <span>Referenced by page “{label}”</span>
    </div>
  );
}
