import { AnimatePresence } from 'motion/react';
import { closeSourcePopover, openPopoverSource, useSourceNav } from '../../../state/sourceNav/sourceNav';
import { SourcePopover } from './SourcePopover';
import './source.css';

/** The shell's one source popover, opened by any "Source" link through openSourcePopover. */
export function SourcePopoverHost() {
  const { popover } = useSourceNav();
  const key = popover && `${popover.target.backendConnectionId}:${popover.target.nodeId}:${popover.target.messageId ?? ''}`;
  // A closed popover fades out with what it last showed.
  return (
    <AnimatePresence>
      {popover && key && (
        <SourcePopover
          key={key}
          popover={popover}
          onClose={closeSourcePopover}
          onGo={(focus, preview) => {
            void openPopoverSource(focus, preview ? { nodeId: preview.nodeId, workspaceId: preview.workspaceId, messageId: preview.message?.id ?? null } : null);
          }}
        />
      )}
    </AnimatePresence>
  );
}
