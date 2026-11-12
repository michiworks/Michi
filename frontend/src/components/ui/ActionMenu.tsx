import React from 'react';
import { PopoverSurface } from './Popover';
import { useBackLayer } from '../../lib/backStack';
import { isImeComposing } from '../../lib/ime';
import { useMenuEscape } from './useMenuEscape';
import { placeBelowAnchor } from './useAnchoredPosition';
import { usePhoneLayout } from '../../hooks/usePhoneLayout';
import { PhoneContextMenu } from './PhoneContextMenu';
import type { MenuSection } from '../ContextMenu';

export interface ActionMenuEntry {
  id: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  dividerBefore?: boolean;
  /** Set for a choice among the entries: the entry is a radio item, checked or not. */
  checked?: boolean;
}

interface ActionMenuProps {
  anchor: HTMLButtonElement;
  onClose: () => void;
  label: string;
  items: readonly ActionMenuEntry[];
  width?: number;
  /** The row the menu acts on. On a phone it lifts, with the menu beside it, as the row's long press would (PhoneContextMenu). */
  liftTarget?: HTMLElement | null;
}

/**
 * A focused button menu for row actions. Context menus keep their
 * active-descendant model. On a phone, a menu given its row opens as that
 * row's phone context menu, so its ⋯ and its long press open the same thing.
 */
export function ActionMenu(props: ActionMenuProps) {
  const phone = usePhoneLayout();
  // Decided once per opening, as ContextMenu does: a menu does not change kind while it is up.
  const [lift] = React.useState(() => (phone && props.items.every((item) => typeof item.label === 'string') ? props.liftTarget ?? null : null));
  if (lift) {
    const box = props.anchor.getBoundingClientRect();
    return <PhoneContextMenu anchor={lift} x={box.left + box.width / 2} y={box.top + box.height / 2} sections={phoneSections(props.items)} onClose={props.onClose} />;
  }
  return <DesktopActionMenu {...props} />;
}

function phoneSections(items: readonly ActionMenuEntry[]): MenuSection[] {
  const sections: MenuSection[] = [];
  for (const item of items) {
    if (item.dividerBefore || sections.length === 0) sections.push({ items: [] });
    sections[sections.length - 1].items.push({
      id: item.id, label: item.label as string, danger: item.danger, disabled: item.disabled,
      glyph: item.checked ? '✓' : undefined, run: item.onSelect,
    });
  }
  return sections;
}

function DesktopActionMenu({ anchor, onClose, label, items, width = 208 }: ActionMenuProps) {
  const surface = React.useRef<HTMLDivElement>(null);
  const [position, setPosition] = React.useState({ left: 0, top: 0 });
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;
  useBackLayer(true, { back: () => closeRef.current() });
  useMenuEscape(true, () => {
    anchor.focus({ preventScroll: true });
    closeRef.current();
  });
  React.useLayoutEffect(() => {
    const box = surface.current!.getBoundingClientRect();
    const { left, top } = placeBelowAnchor(anchor.getBoundingClientRect(), box, { align: 'end', gap: 5 });
    // Fitting on neither side, it still stays on screen.
    setPosition({ left, top: Math.max(8, Math.min(innerHeight - box.height - 8, top)) });
    surface.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [anchor]);
  React.useEffect(() => {
    const dismiss = () => closeRef.current();
    const outside = (event: PointerEvent) => {
      if (!surface.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) dismiss();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isImeComposing(event)) return;
      if (event.key === 'Tab') {
        dismiss();
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const buttons = Array.from(surface.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', keydown);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [anchor]);
  return (
    <PopoverSurface ref={surface} menuKind="context" animate={false} role="menu" aria-label={label}
      width={width} left={position.left} top={position.top} className="trash-menu">
      {items.map((item) => <React.Fragment key={item.id}>
        {item.dividerBefore && <div className="michi-menu-divider" role="separator" />}
        <button type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
          aria-checked={item.checked} className="ui-menu-item" disabled={item.disabled}
          data-danger={item.danger ? 'true' : undefined} onClick={() => {
            anchor.focus({ preventScroll: true });
            onClose();
            item.onSelect();
          }}>
          {item.icon}{item.label}
        </button>
      </React.Fragment>)}
    </PopoverSurface>
  );
}
