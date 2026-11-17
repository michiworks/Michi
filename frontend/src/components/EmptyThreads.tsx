import { kbd } from '../lib/platform';
import { Button } from './ui/controls';

export default function EmptyThreads() {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        color: 'var(--term-muted)',
        fontFamily: 'var(--ui-font)',
      }}
    >
      <div style={{ fontSize: 'var(--fs-3xl)', color: 'var(--term-fg)', marginBottom: 8 }}>
        ▂ all threads archived
      </div>
      <div style={{ fontSize: 'var(--fs-md)', marginBottom: 16 }}>
        Start a new thread or unarchive one.
      </div>
      <Button variant="primary" onClick={() => window.dispatchEvent(new CustomEvent('michi:goto-home'))}>
        + new thread ({kbd('mod', 'T')})
      </Button>
    </div>
  );
}
