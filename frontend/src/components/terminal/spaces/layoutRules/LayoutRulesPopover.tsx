import React from 'react';
import { useIsPresent } from 'motion/react';
import { HOME_SECTION_SHORT_TITLES, type PageLayoutRule } from 'michi-shared';
import { measureSurface, PopoverSurface } from '../../../ui/Popover';
import { useBackLayer } from '../../../../lib/backStack';
import { Button } from '../../../ui/controls';
import { placeBelowAnchor, useAnchoredPosition } from '../../../ui/useAnchoredPosition';
import { formatMichiAgo } from '../../content/michiFormat';
import { LayoutPreferencesEditor } from './LayoutPreferencesEditor';
import { useCompanionName } from '../../../../state/companion/companionName';
import { isImeComposing } from '../../../../lib/ime';
import '../../content/page/michiPage.css';
import './layoutRules.css';

const GAP = 4;
const PAD = 8;
const WIDTH = 320;

/** Who the rule binds and where it came from: "Stalled · applied by Michi · from your message · 2h ago". */
export function layoutRuleMeta(rule: PageLayoutRule, name: string, now = Date.now()): string {
  return [
    rule.sectionLimit ? `${HOME_SECTION_SHORT_TITLES[rule.sectionLimit.section]} · applied by Michi` : `followed by ${name}`,
    rule.createdBy === 'user' ? 'added by you' : rule.sourceMessage ? 'from your message to the assistant' : null,
    formatMichiAgo(rule.createdAt, now) || null,
  ].filter(Boolean).join(' · ');
}

/**
 * The page's layout rules hung from its ⋯ button: each rule's text, what it
 * binds and a Delete. Opening it focuses the preferences document, else the
 * first Delete; Esc or a click outside closes it and gives focus back to the
 * button.
 */
export function LayoutRulesPopover({ anchor, rules, error, readOnly, preferences, onDelete, onClose }: {
  anchor: HTMLElement;
  rules: readonly PageLayoutRule[] | null;
  error?: string | null;
  readOnly?: boolean;
  preferences?: { pageId: string; backendConnectionId: string };
  onDelete: (rule: PageLayoutRule) => Promise<void>;
  onClose: (restoreFocus: boolean) => void;
}) {
  const name = useCompanionName();
  const surface = React.useRef<HTMLDivElement>(null);
  const [position, setPosition] = React.useState<{ left: number; top: number } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const editableDocument = Boolean(preferences);
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;
  // Closed, it fades out for a moment (PopoverSurface) and takes no keys, presses or Back.
  const present = useIsPresent();
  const initialFocus = React.useRef<HTMLElement | null>(null);
  // The document's field arrives with its first read: it takes focus then, unless the person has moved it meanwhile.
  const takeInput = React.useCallback((input: HTMLTextAreaElement | null) => {
    const active = document.activeElement;
    if (input && (active === initialFocus.current || active === anchor || active === document.body)) input.focus({ preventScroll: true });
  }, [anchor]);
  useBackLayer(present, { back: () => closeRef.current(true) });

  // Follows its button as the page scrolls or the window or its content resizes.
  useAnchoredPosition({ anchor, surfaceRef: surface, dependencies: [rules?.length, editableDocument], measure: () => {
    // The size it settles to, not the scaled box it grows in from.
    const size = surface.current ? measureSurface(surface.current) : null;
    const { left, top } = placeBelowAnchor(anchor.getBoundingClientRect(), { width: size?.width || (editableDocument ? 440 : WIDTH), height: size?.height || 0 }, { align: 'end', gap: GAP, pad: PAD });
    setPosition(current => current?.left === left && current.top === top ? current : { left, top });
  } });

  React.useEffect(() => {
    if (!present) return;
    const root = surface.current;
    initialFocus.current = root?.querySelector<HTMLElement>('textarea:not(:disabled)') ?? root?.querySelector<HTMLElement>('button:not(:disabled)') ?? null;
    initialFocus.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isImeComposing(event)) return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current(true);
    };
    // Focus inside goes back to the ⋯ button; focus elsewhere stays where it is.
    const dismiss = () => closeRef.current(surface.current?.contains(document.activeElement) ?? false);
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (surface.current?.contains(target) || anchor.contains(target))) return;
      dismiss();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    if (!editableDocument) window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [present, anchor, editableDocument]);

  const remove = async (rule: PageLayoutRule) => {
    if (busy) return;
    setBusy(rule.id);
    setFailed(null);
    try {
      await onDelete(rule);
    } catch (cause) {
      setFailed(cause instanceof Error && cause.message ? `Couldn't delete: ${cause.message}` : "Couldn't delete this rule.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <PopoverSurface
      ref={surface}
      menuKind="context"
      width={preferences ? 440 : WIDTH}
      maxHeight={`calc(100vh - ${position?.top ?? PAD}px - ${PAD}px)`}
      left={position?.left ?? 0}
      top={position?.top ?? 0}
      role="dialog"
      aria-label={preferences ? 'Layout preferences' : 'Layout rules'}
      escapeLayer="over"
      className="michi-doc-menu layout-rules-menu"
      style={position ? undefined : { visibility: 'hidden' }}
    >
      <ul className="michi-menu-list">
        <li className="michi-menu-section michi-doc-menu__caption" role="presentation">{preferences ? 'Layout preferences' : 'Layout rules'}</li>
        {preferences && <li className="layout-rules-menu__document"><LayoutPreferencesEditor {...preferences} readOnly={readOnly} inputRef={takeInput} /></li>}
        {preferences && <li className="michi-menu-section michi-doc-menu__caption" role="presentation">Existing rules</li>}
        {rules === null && !error && <li className="layout-rules-menu__note" role="status">Loading…</li>}
        {rules === null && error && <li className="layout-rules-menu__note" role="alert">{error}</li>}
        {rules?.length === 0 && (
          <li className="layout-rules-menu__note">
            No layout rules yet. Ask {name}, for example “Stalled: only the last 3 days”.
          </li>
        )}
        {rules?.map((rule) => (
          <li key={rule.id} className="ui-menu-item michi-doc-menu__item--sub layout-rules-menu__rule" data-testid="layout-rule">
            <span className="michi-menu-label michi-doc-menu__label">
              <span className="michi-doc-menu__title">{rule.text}</span>
              <span className="michi-doc-menu__sub">{layoutRuleMeta(rule, name)}</span>
            </span>
            <Button variant="ghost" size="sm" danger disabled={readOnly || busy !== null} aria-label={`Delete rule: ${rule.text}`}
              aria-busy={busy === rule.id || undefined} onClick={() => { void remove(rule); }}>
              Delete
            </Button>
          </li>
        ))}
        {failed && <li className="layout-rules-menu__note" role="alert">{failed}</li>}
      </ul>
    </PopoverSurface>
  );
}
