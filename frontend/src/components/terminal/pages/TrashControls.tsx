import type React from 'react';
import { Eye, Trash2, Undo2, type LucideIcon } from 'lucide-react';
import { HoverTip } from '../../ui/Popover';
import { ActionMenu } from '../../ui/ActionMenu';

export function TrashIconButton({ icon: Icon, tooltip, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; tooltip: string }) {
  return <HoverTip label={tooltip} disabled={props.disabled}>
    <button {...props} type="button" className={`trash-icon-button ${props.className ?? ''}`}>
      <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
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
    { id: 'preview', label: 'Preview', icon: <Eye size={14} aria-hidden="true" />, onSelect: onPreview },
    { id: 'restore', label: 'Restore', icon: <Undo2 size={14} aria-hidden="true" />, onSelect: onRestore },
    { id: 'delete', label: 'Delete permanently...', icon: <Trash2 size={14} aria-hidden="true" />, danger: true, dividerBefore: true, onSelect: onDelete },
  ]} />;
}
