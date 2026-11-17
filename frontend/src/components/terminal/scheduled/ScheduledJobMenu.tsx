import { CopyIcon, EditIcon, HistoryIcon, PauseIcon, PlayIcon, TrashIcon } from '../icons';
import { ActionMenu } from '../../ui/ActionMenu';

export interface ScheduledJobMenuActions {
  onEdit(): void;
  onRuns(): void;
  onToggle(): void;
  onDuplicate(): void;
  onDelete(): void;
}

/** Row "more" menu; same keyboard and dismissal behavior as the Trash menu. */
export function ScheduledJobMenu({ anchor, row, paused, onClose, actions }: {
  anchor: HTMLButtonElement;
  /** The job's row, lifted with the menu on a phone. */
  row?: HTMLElement | null;
  paused: boolean;
  onClose: () => void;
  actions: ScheduledJobMenuActions;
}) {
  return <ActionMenu anchor={anchor} liftTarget={row} onClose={onClose} label="Scheduled job actions" items={[
    { id: 'edit', label: 'Edit', icon: <EditIcon aria-hidden="true" />, onSelect: actions.onEdit },
    { id: 'runs', label: 'View runs', icon: <HistoryIcon aria-hidden="true" />, onSelect: actions.onRuns },
    { id: 'toggle', label: paused ? 'Resume' : 'Pause', icon: paused ? <PlayIcon aria-hidden="true" /> : <PauseIcon aria-hidden="true" />, onSelect: actions.onToggle },
    { id: 'duplicate', label: 'Duplicate', icon: <CopyIcon aria-hidden="true" />, onSelect: actions.onDuplicate },
    { id: 'delete', label: 'Delete…', icon: <TrashIcon aria-hidden="true" />, danger: true, dividerBefore: true, onSelect: actions.onDelete },
  ]} />;
}
