import type React from 'react';
import { EyeIcon, TrashIcon, UndoIcon, type IconComponent } from '../icons';
import { HoverTip } from '../../ui/Popover';
import { ActionMenu } from '../../ui/ActionMenu';

/** With a `blockedReason` it is unavailable for a reason the user can change:
 *  it stays focusable, ignores clicks and shows the reason as its tip.
 *  A plain `disabled` button shows no tip. */
export function TrashIconButton({ icon: Icon, tooltip, blockedReason, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconComponent;
  tooltip: string;
  blockedReason?: string;
}) {
  const blocked = blockedReason !== undefined && !props.disabled;
  return <HoverTip label={blocked ? blockedReason : tooltip} disabled={props.disabled}>
    <button {...props} type="button" aria-disabled={blocked || undefined}
      onClick={(event) => { if (!blocked) onClick?.(event); }}
      className={`trash-icon-button ${props.className ?? ''}`}>
      <Icon size="lg" aria-hidden="true" />
    </button>
  </HoverTip>;
}

export function TrashMenu({ anchor, onClose, onPreview, onRestore, onDelete }: {
  anchor: HTMLButtonElement;
  onClose: () => void;
  onPreview: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  return <ActionMenu anchor={anchor} onClose={onClose} label="Trash actions" items={[
    { id: 'preview', label: 'Preview', icon: <EyeIcon aria-hidden="true" />, onSelect: onPreview },
    { id: 'restore', label: 'Restore', icon: <UndoIcon aria-hidden="true" />, onSelect: onRestore },
    { id: 'delete', label: 'Delete permanently…', icon: <TrashIcon aria-hidden="true" />, danger: true, dividerBefore: true, onSelect: onDelete },
  ]} />;
}
