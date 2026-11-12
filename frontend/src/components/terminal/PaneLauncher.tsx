import React from 'react';
import { toast } from 'sonner';
import { useChatActions } from '../../state/chatStore';
import { HoverTip } from '../ui/Popover';
import { TOPBAR_TIP_DELAY_MS } from './TopbarIconButton';

export default function PaneLauncher() {
  const { openLauncherPane } = useChatActions();

  return (
    <HoverTip label="New pane" delayMs={TOPBAR_TIP_DELAY_MS}>
      <button
        type="button"
        className="t-icon-btn"
        aria-label="New pane"
        onClick={() => {
          try {
            openLauncherPane();
          } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Unable to open pane');
          }
        }}
        style={{
          width: 26,
          height: 26,
          fontSize: 'var(--fs-2xl)',
          color: 'var(--term-mid)',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        +
      </button>
    </HoverTip>
  );
}
