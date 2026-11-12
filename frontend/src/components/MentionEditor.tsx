import { openPreferredUrl } from '../services/openUrl';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Mention from '@tiptap/extension-mention';
import type { SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion';
import { exitSuggestion } from '@tiptap/suggestion';
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { ArtifactEntry, ChatNodeState } from '../state/chatStore';
import type { SessionMode } from '../services/api';
import { keepsSlashPick, type SlashEntry } from '../state/slashEntries';
import type { MentionRecord } from '../lib/mentions';
import { buildAtMentionItems, type AtMentionItem } from './mentionItems';
import {
  matchSlashContext,
  buildSlashItems,
  buildAgentItems,
  type SlashItem,
} from './slashItems';
import { PopoverSurface, MenuItem } from './ui/Popover';
import { useMenuConfirm } from './ui/useMenuConfirm';
import { docToDraft, draftToDoc } from './mentionDoc';
import { MentionEnter, markMentionEnter } from './mentionEnter';
import { markComposerEscape } from './composerEscape';
import { ChatIcon, DocIcon, FileIcon, ImageIcon, LinkIcon } from './terminal/icons';
import { usePhoneLayout } from '../hooks/usePhoneLayout';
import { prefersReducedMotion } from '../hooks/useReducedMotion';
import { isImeComposing } from '../lib/ime';
import { spaceBeforeMention } from './mentionSpacing';

/**
 * An Enter or Tab the composer's input method still owns. Not isImeComposing:
 * ProseMirror already drops the Enter that ends a composition in Safari, and
 * keyCode 229 would cost Android keyboards a second Enter to send.
 */
function composerComposing(view: EditorView, event: KeyboardEvent): boolean {
  // eslint-disable-next-line no-restricted-properties -- the reason is above
  return view.composing || event.isComposing;
}

/**
 * ProseMirror reads a selection made outside its own commands (by script:
 * automation, assistive tech, extensions) on the next `selectionchange`
 * task, but the browser runs input ahead of queued tasks while the main
 * thread is busy, for instance with an animation frame. A Backspace or
 * Delete arriving first would act on the old caret and delete nothing.
 * While ProseMirror still holds a caret and the browser a range inside the
 * editor, deliver that `selectionchange` now: ProseMirror's own listener
 * reads the range (however the browser anchors it, the editor root
 * included) before the key is handled.
 */
function adoptPendingDomSelection(view: EditorView): void {
  if (!view.state.selection.empty) return;
  const doc = view.dom.ownerDocument;
  const dom = doc.getSelection();
  if (!dom || dom.isCollapsed || !dom.anchorNode || !dom.focusNode) return;
  if (!view.dom.contains(dom.anchorNode) || !view.dom.contains(dom.focusNode)) return;
  doc.dispatchEvent(new Event('selectionchange'));
}

/** Line glyph for a mention row: chat bubble for nodes, per-type icon for artifacts. */
function MentionGlyph({ item }: { item: AtMentionItem }) {
  if (item.kind === 'node') return <ChatIcon />;
  switch (item.artifactType) {
    case 'file': return <FileIcon />;
    case 'image': return <ImageIcon />;
    case 'link': return <LinkIcon />;
    default: return <DocIcon />;
  }
}

/**
 * TipTap-backed replacement for MentionTextarea. Presents the SAME controlled
 * `{ value, mentions }` contract (so the store / submit / queue / expandMentions
 * are untouched) but renders an atomic-mention contenteditable instead of a
 * transparent-textarea + overlay. Owns BOTH composer popups that used to be
 * textarea-coupled siblings: @-mention (AtMentionPopup) and /-command (SlashPopup).
 */

export interface MentionEditorHandle {
  focus: () => void;
  /** Type an `@` at the caret (or the end), spaced so the @ picker opens on it. */
  startMention: (at?: 'caret' | 'end') => void;
  /** Underlying TipTap editor, for callers that need imperative access. */
  editor: Editor | null;
}

export interface MentionEditorProps {
  value: string;
  mentions: MentionRecord[];
  onChange: (next: { value: string; mentions: MentionRecord[] }) => void;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  'data-testid'?: string;

  /** @-mention suggestion data source (was AtMentionPopup's props). */
  artifacts: ArtifactEntry[];
  sameTreeNodes: ChatNodeState[];
  currentNodeId: string;
  /** Nodes from other threads in the same workspace, grouped by thread title. */
  crossTreeNodes?: import('./mentionItems').CrossTreeGroup[];

  /** /-command data sources (were SlashPopup's props): the chat's commands and
   *  skills (buildSlashEntries), the composer's own commands when absent. */
  slashEntries?: readonly SlashEntry[];
  /** The / menu opened; the host may refresh what feeds slashEntries. */
  onSlashOpen?: () => void;
  /**
   * A / menu row was picked, so the message's `/name` runs that entry; null
   * once the text no longer starts with its `/name`.
   */
  onSlashPick?: (entry: SlashEntry | null) => void;
  availableModes?: SessionMode[];
  currentModeId?: string | null;
  onSwitchAgent?: (modeId: string) => void;
  /** Enable `/`-command autocomplete (TPane: yes; ManageComposer: no). Default true. */
  enableSlash?: boolean;

  /** Enter (no Shift) always submits; `branch` is true for Mod+Enter. Replaces TPane's onKeyDown. */
  onSubmit?: (opts: { branch: boolean }) => void;
  /** Native paste passthrough (image paste handling lives in the host). */
  onPaste?: (e: ClipboardEvent) => void;
}

// The composer's StarterKit subset. Inline marks AND block nodes (heading,
// lists, blockquote, codeBlock) are enabled: input rules consume the typed
// markdown syntax (`**bold**` → bold mark, `- ` → list item), and docToDraft
// re-emits the equivalent markdown on serialize, so the submitted value keeps
// what the user typed while the composer renders it WYSIWYG.
// horizontalRule stays off (nobody types `---` in chat; easy to mistrigger).
// trailingNode stays off: it auto-appends an empty paragraph after a trailing
// code block / list, which would leak a spurious `\n` into the wire value —
// codeBlock's exitOnArrowDown covers the escape path (plain Enter submits, so
// exitOnTripleEnter never fires; newlines inside the fence come from Shift+Enter).
// Exported so tests can drive a real editor with the exact production config.
//
// Link replaces StarterKit's copy: TipTap makes the link mark inclusive while
// autolink is on, so text typed right after a pasted URL joined the link.
// Don't open links on a plain click — the composer is an editing surface, so a
// bare click should place the caret, not navigate away. Cmd/Ctrl+click opens
// (see the click handler in editorProps.handleDOMEvents).
const ComposerLink = Link.extend({ inclusive: false }).configure({ openOnClick: false });

export const composerStarterKit = StarterKit.extend({
  addExtensions() {
    return [...(this.parent?.() ?? []), ComposerLink];
  },
}).configure({
  horizontalRule: false,
  trailingNode: false,
  link: false,
});

/**
 * Whether the selection sits inside a formatted block (code block, list item,
 * blockquote, heading). Plain Enter ALWAYS submits — chat convention — but
 * Shift+Enter inside one of these runs the block-native Enter instead of the
 * default hardBreak: next list item, newline in code, new paragraph in a
 * quote, body paragraph after a heading.
 */
export function enterContinuesBlock(state: EditorState): boolean {
  const { $from } = state.selection;
  if ($from.parent.type.name === 'heading') return true;
  for (let d = $from.depth; d > 0; d -= 1) {
    const name = $from.node(d).type.name;
    if (name === 'codeBlock' || name === 'listItem' || name === 'blockquote') return true;
  }
  return false;
}

// Mention node extended to carry our MentionRecord fields (refId + kind) on top
// of the default label. Defaults render a `<span class="mention-chip">@label</span>`.
const MentionNode = Mention.extend({
  addAttributes() {
    return {
      refId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-ref-id'),
        renderHTML: (attrs) => (attrs.refId ? { 'data-ref-id': attrs.refId } : {}),
      },
      label: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-label'),
        renderHTML: (attrs) => (attrs.label ? { 'data-label': attrs.label } : {}),
      },
      kind: {
        default: 'context',
        parseHTML: (el) => el.getAttribute('data-kind') || 'context',
        renderHTML: (attrs) => ({ 'data-kind': attrs.kind }),
      },
    };
  },
});

const serialize = (value: string, mentions: MentionRecord[]) =>
  JSON.stringify({ value, mentions });

// ---- @-mention suggestion popup (replaces AtMentionPopup's list rendering).

type PopupState = {
  items: AtMentionItem[];
  command: (item: AtMentionItem) => void;
  rect: DOMRect | null;
  /** One per `@`: filtering keeps it, a new `@` starts the next. */
  session: number;
};

/** Rows ride up into the room the ones above them left (a FLIP on transform). */
const ROW_SETTLE = { duration: 160, easing: 'cubic-bezier(.32, .72, 0, 1)' } as const;

function SuggestionPopup({
  state,
  selected,
  anchor,
  onHover,
  onPick,
  blinkingId,
}: {
  state: PopupState | null;
  selected: number;
  anchor: HTMLElement | null;
  onHover: (i: number) => void;
  onPick: (i: number) => void;
  blinkingId: string | null;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  // While one `@` is being filtered the list holds the tallest it has been,
  // so the menu keeps both edges: it sits on the composer, and a top edge that
  // followed the match count would jump on every key. The height is measured
  // as rendered (after the list's own cap and the room above the composer),
  // before paint. A new `@` starts from its natural height.
  const session = state?.session ?? -1;
  const [held, setHeld] = useState({ session: -1, px: 0 });
  const heldPx = held.session === session ? held.px : 0;
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !state) return;
    const px = list.offsetHeight;
    if (held.session !== session || px > held.px) setHeld({ session, px });
  }, [state, session, held]);

  // Rows that stop matching leave; the ones below ride up into their room
  // instead of snapping there. Positions are visual (scroll taken off), keyed
  // by item, and forgotten when the menu closes.
  const tops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const list = listRef.current;
    const next = new Map<string, number>();
    if (list && state) {
      const still = prefersReducedMotion();
      state.items.forEach((it, i) => {
        const el = list.children[i] as HTMLElement | undefined;
        if (!el) return;
        const top = el.offsetTop - list.scrollTop;
        const was = tops.current.get(it.id);
        if (!still && was !== undefined && was !== top && typeof el.animate === 'function') {
          el.animate([{ transform: `translateY(${was - top}px)` }, { transform: 'none' }], ROW_SETTLE);
        }
        next.set(it.id, top);
      });
    }
    tops.current = next;
  }, [state]);

  if (!state || state.items.length === 0) return null;
  const { items, rect } = state;
  // Horizontal: anchor at the @ caret (the suggestion decoration's rect),
  // clamped so a near-right-edge @ doesn't push the popup off-screen.
  // Vertical: above the composer card (same as the slash popup), via the host.
  // PopoverSurface portals to <body>, so a transformed composer ancestor can't
  // hijack the position:fixed containing block (the bug a plain inline div hit).
  const POPUP_MAX = 420;
  const hostRect = anchor?.getBoundingClientRect();
  const caretLeft = rect ? rect.left : hostRect?.left ?? 0;
  const left = Math.max(8, Math.min(caretLeft, window.innerWidth - POPUP_MAX - 8));
  const anchorTop = hostRect ? hostRect.top : rect ? rect.top : window.innerHeight;
  return (
    <PopoverSurface
      menuKind="mentions"
      className="michi-menu-autocomplete"
      left={left}
      bottom={window.innerHeight - anchorTop + 6}
      minWidth="min(280px, calc(100vw - 16px))"
      maxWidth={`min(${POPUP_MAX}px, calc(100vw - 16px))`}
      maxHeight={`max(80px, ${anchorTop - 14}px)`}
      zIndex={60}
      role="listbox"
      aria-label="Mentions"
      style={{ overflow: 'hidden' }}
    >
      <ul ref={listRef} className="michi-menu-list" style={heldPx ? { minHeight: heldPx } : undefined}>
        {items.map((it, i) => (
          <MenuItem
            key={it.id}
            role="option"
            className={blinkingId === `mention-${it.id}` ? 'ui-menu-blink' : undefined}
            active={i === selected}
            aria-selected={i === selected}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(i);
            }}
          >
            <span className="michi-menu-glyph" aria-hidden="true"><MentionGlyph item={it} /></span>
            <span className="michi-menu-label">
              {it.label}
            </span>
            {it.description && (
              <span className="michi-menu-badge">
                {it.description}
              </span>
            )}
          </MenuItem>
        ))}
      </ul>
      <div className="michi-menu-footer">
        ↑↓ navigate · ↵/⇥ accept · esc cancel
      </div>
    </PopoverSurface>
  );
}

// ---- /-command popup.

/** A row's identity: a command and skills may share a name. */
const slashItemKey = (it: SlashItem) => `slash-${it.source}-${it.skill?.id ?? it.modeId ?? it.name}`;

/** Where `query` first occurs in `name`. */
function matchOf(name: string, query: string): readonly [number, number] | null {
  const at = query ? name.toLowerCase().indexOf(query.toLowerCase()) : -1;
  return at < 0 ? null : [at, at + query.length];
}

/** `name[from, to)`, with the part of it inside `match` emphasised. */
function NamePart({ name, from, to, match }: { name: string; from: number; to: number; match: readonly [number, number] | null }) {
  if (!match || match[1] <= from || match[0] >= to) return <>{name.slice(from, to)}</>;
  const start = Math.max(from, match[0]);
  const end = Math.min(to, match[1]);
  return (
    <>
      {name.slice(from, start)}
      <span className="michi-menu-match">{name.slice(start, end)}</span>
      {name.slice(end, to)}
    </>
  );
}

/**
 * A row's `/name` with the first occurrence of `query` emphasised. Of a
 * `plugin:skill` name the plugin part gives way first, so the skill part
 * stays readable in a narrow list; the slash always shows.
 */
function SlashName({ name, query }: { name: string; query: string }) {
  const full = `/${name}`;
  const match = matchOf(full, query);
  const colon = full.lastIndexOf(':');
  const leaf = <span className="michi-slash-leaf"><NamePart name={full} from={colon > 1 ? colon : 0} to={full.length} match={match} /></span>;
  return (
    <span className="michi-slash-name">
      {colon > 1 ? (
        <>
          <NamePart name={full} from={0} to={1} match={match} />
          <span className="michi-slash-plugin">
            <span className="michi-slash-prefix"><NamePart name={full} from={1} to={colon} match={match} /></span>
            {leaf}
          </span>
        </>
      ) : leaf}
    </span>
  );
}

const SLASH_MENU_WIDTH = 560;

/**
 * A touch screen, where a tap also fires the hover events: there the / menu
 * shows each row's description in the row and no panel that follows the
 * highlight, since WebKit drops a tap whose hover changes what is shown.
 */
const TOUCH_QUERY = '(hover: none) and (pointer: coarse)';
const subscribeTouch = (notify: () => void) => {
  const query = window.matchMedia?.(TOUCH_QUERY);
  query?.addEventListener?.('change', notify);
  return () => query?.removeEventListener?.('change', notify);
};
const isTouchScreen = () => window.matchMedia?.(TOUCH_QUERY).matches ?? false;

/**
 * The / menu, as Claude Code shows it: one list of `/name` rows, commands
 * before skills, and the highlighted row's name, arguments, kind and
 * description beside the list (under it on a narrow window). On a touch
 * screen each row carries its description instead. The /agent picker lists
 * agents with their descriptions inline.
 */
function SlashCommandPopup({
  items,
  query,
  selected,
  anchor,
  onHover,
  onPick,
  blinkingId,
}: {
  items: SlashItem[];
  query: string;
  selected: number;
  anchor: HTMLElement | null;
  onHover: (i: number) => void;
  onPick: (i: number) => void;
  blinkingId: string | null;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const phone = usePhoneLayout();
  const touch = useSyncExternalStore(subscribeTouch, isTouchScreen, () => false);
  useLayoutEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  if (items.length === 0 || !anchor) return null;
  const rect = anchor.getBoundingClientRect();
  const agents = items[0].source === 'agent';
  const active = agents || touch ? undefined : items[selected];
  // A list with no panel beside it is as wide as its rows want.
  const width = phone || active ? Math.min(phone ? rect.width : SLASH_MENU_WIDTH, window.innerWidth - 16) : undefined;
  return (
    <PopoverSurface
      menuKind="slash"
      className={touch ? 'michi-menu-autocomplete michi-slash-touch' : 'michi-menu-autocomplete'}
      left={Math.max(8, Math.min(rect.left, window.innerWidth - (width ?? 480) - 8))}
      bottom={window.innerHeight - rect.top + 6}
      {...(width !== undefined ? { width } : {
        minWidth: `min(${Math.max(320, Math.min(420, rect.width))}px, calc(100vw - 16px))`,
        maxWidth: 'min(480px, calc(100vw - 16px))',
      })}
      maxHeight={`max(80px, ${rect.top - 14}px)`}
      zIndex={60}
      role="listbox"
      aria-label="Slash commands"
      style={{ overflow: 'hidden' }}
    >
      <div className="michi-slash-body">
        <ul ref={listRef} className="michi-menu-list">
          {items.map((it, i) => {
            const name = <SlashName name={it.name} query={query} />;
            const tag = it.tag && <span className="michi-slash-tag">{it.tag}</span>;
            return (
              <MenuItem
                key={slashItemKey(it)}
                role="option"
                className={blinkingId === slashItemKey(it) ? 'ui-menu-blink' : undefined}
                active={i === selected}
                aria-selected={i === selected}
                onMouseEnter={touch ? undefined : () => onHover(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(i);
                }}
              >
                {agents ? (
                  <>
                    <span className="michi-menu-command">
                      <NamePart name={it.name} from={0} to={it.name.length} match={matchOf(it.name, query)} />
                    </span>
                    {it.description && <span className="michi-menu-label michi-menu-caption">{it.description}</span>}
                  </>
                ) : touch ? (
                  <span className="michi-slash-row">
                    <span className="michi-slash-line">{name}{tag}</span>
                    {it.description && <span className="michi-slash-row-text">{it.description}</span>}
                  </span>
                ) : (
                  <>{name}{tag}</>
                )}
              </MenuItem>
            );
          })}
        </ul>
        {active && (
          <div className="michi-slash-detail" aria-live="polite">
            <div className="michi-slash-detail-title">
              /{active.name}{active.hint && <span className="michi-slash-detail-hint"> {active.hint}</span>}
            </div>
            <div className="michi-slash-detail-kind">{active.skill ? `Skill · ${active.sourceLabel}` : 'Command'}</div>
            {active.description && <div className="michi-slash-detail-text">{active.description}</div>}
          </div>
        )}
      </div>
      <div className="michi-menu-footer">
        ↑↓ navigate · ↵/⇥ accept · esc cancel
      </div>
    </PopoverSurface>
  );
}

const MentionEditor = forwardRef<MentionEditorHandle, MentionEditorProps>(function MentionEditor(
  props,
  ref,
) {
  const {
    value,
    mentions,
    onChange,
    disabled,
    className,
    artifacts,
    sameTreeNodes,
    currentNodeId,
    crossTreeNodes,
    slashEntries,
    onSlashOpen,
    onSlashPick,
    availableModes,
    currentModeId,
    onSwitchAgent,
    enableSlash = true,
    onSubmit,
    onPaste,
  } = props;

  const hostRef = useRef<HTMLDivElement | null>(null);
  // Editor handle for the (mount-time) handleKeyDown closure — the Shift+Enter
  // path needs editor.commands, but `editor` doesn't exist when useEditor's
  // config object is built. Assigned right after useEditor returns.
  const editorRef = useRef<Editor | null>(null);

  // Refs the (mount-time) ProseMirror plugin callbacks read for fresh values.
  const contextsRef = useRef(artifacts);
  const nodesRef = useRef(sameTreeNodes);
  const crossTreeNodesRef = useRef(crossTreeNodes);
  const currentNodeIdRef = useRef(currentNodeId);
  const onSubmitRef = useRef(onSubmit);
  const onPasteRef = useRef(onPaste);
  const onSwitchAgentRef = useRef(onSwitchAgent);
  const onSlashOpenRef = useRef(onSlashOpen);
  const onSlashPickRef = useRef(onSlashPick);
  contextsRef.current = artifacts;
  nodesRef.current = sameTreeNodes;
  crossTreeNodesRef.current = crossTreeNodes;
  currentNodeIdRef.current = currentNodeId;
  onSubmitRef.current = onSubmit;
  onPasteRef.current = onPaste;
  onSwitchAgentRef.current = onSwitchAgent;
  onSlashOpenRef.current = onSlashOpen;
  onSlashPickRef.current = onSlashPick;

  // The last (value, mentions) WE produced or applied — used to distinguish an
  // echo of our own onChange (skip) from a genuine external change (re-sync).
  const lastSyncedRef = useRef(serialize(value, mentions));

  const [popup, setPopup] = useState<PopupState | null>(null);
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(0);
  const popupRef = useRef<PopupState | null>(null);
  const popupSessionRef = useRef(0);
  const suggestionOpenRef = useRef(false);
  const { blinkingId, confirm, cancel: cancelConfirmation } = useMenuConfirm();
  selectedRef.current = selected;
  popupRef.current = popup;
  const acceptMentionRef = useRef<(index: number) => void>(() => {});
  acceptMentionRef.current = (index) => {
    const current = popupRef.current;
    const item = current?.items[index];
    if (current && item) confirm(`mention-${item.id}`, () => current.command(item));
  };

  // ---- /-command state. Driven by the editor's value + caret (not a textarea).
  const [slashCtx, setSlashCtx] = useState<{ query: string; command?: string } | null>(null);
  const [slashSelected, setSlashSelected] = useState(0);
  const slashItems = useMemo<SlashItem[]>(() => {
    if (!enableSlash || !slashCtx) return [];
    if (slashCtx.command === 'agent') return buildAgentItems(availableModes, currentModeId, slashCtx.query);
    return buildSlashItems(slashEntries, slashCtx.query);
  }, [enableSlash, slashCtx, slashEntries, availableModes, currentModeId]);
  const commandMenuOpen = enableSlash && !!slashCtx && slashCtx.command !== 'agent';
  useEffect(() => {
    if (commandMenuOpen) onSlashOpenRef.current?.();
  }, [commandMenuOpen]);
  const slashItemsRef = useRef<SlashItem[]>([]);
  const slashSelectedRef = useRef(0);
  const slashOpenRef = useRef(false);
  slashItemsRef.current = slashItems;
  slashSelectedRef.current = slashSelected;
  slashOpenRef.current = !!slashCtx && slashItems.length > 0;

  // The row picked last, while the text still starts with its `/name`.
  const pickedSlashRef = useRef<SlashEntry | null>(null);
  const pickSlash = useCallback((entry: SlashEntry) => {
    pickedSlashRef.current = entry;
    onSlashPickRef.current?.(entry);
  }, []);

  // Imperative slash actions, rebound when `editor` becomes available so the
  // editor-creation keymap closure can reach them via refs.
  const acceptSlashRef = useRef<(idx: number) => void>(() => {});
  const escapeSlashRef = useRef<() => void>(() => {});

  // Memoize the extensions array so TipTap doesn't diff/setOptions() every render.
  // All dynamic data inside suggestion callbacks is accessed via refs, so [] deps is safe.
  const extensions = useMemo(
    () => [
      composerStarterKit,
      MentionNode.configure({
        HTMLAttributes: { class: 'mention-chip' },
        renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.refId ?? ''}`,
        suggestion: {
          char: '@',
          items: ({ query }) =>
            buildAtMentionItems(query, contextsRef.current, nodesRef.current, currentNodeIdRef.current, crossTreeNodesRef.current),
          command: ({ editor: ed, range, props: picked }) => {
            const item = picked as unknown as AtMentionItem;
            const refId = item.kind === 'context' ? item.token : item.token.replace(/^node:/, '');
            // The typed `@query` and its on-screen width, read before the
            // insert replaces them, so the chip can grow out of them.
            const typed = ed.state.doc.textBetween(range.from, range.to);
            const typedWidth = popupRef.current?.rect?.width ?? 0;
            ed
              .chain()
              .focus()
              .insertContentAt(range, [
                { type: 'mention', attrs: { refId, label: item.label, kind: item.kind } },
                { type: 'text', text: ' ' },
              ])
              .run();
            if (typed && typedWidth > 0) markMentionEnter(ed, range.from, typed, typedWidth);
          },
          render: () => ({
            onStart: (sp: SuggestionProps) => {
              cancelConfirmation();
              suggestionOpenRef.current = true;
              setSelected(0);
              popupSessionRef.current += 1;
              setPopup({
                items: sp.items as AtMentionItem[],
                command: (it: AtMentionItem) => sp.command(it as unknown as Record<string, unknown>),
                rect: sp.clientRect?.() ?? null,
                session: popupSessionRef.current,
              });
            },
            onUpdate: (sp: SuggestionProps) => {
              cancelConfirmation();
              setSelected(0);
              setPopup({
                items: sp.items as AtMentionItem[],
                command: (it: AtMentionItem) => sp.command(it as unknown as Record<string, unknown>),
                rect: sp.clientRect?.() ?? null,
                session: popupSessionRef.current,
              });
            },
            onKeyDown: (sp: SuggestionKeyDownProps): boolean => {
              const cur = popupRef.current;
              if (!cur || cur.items.length === 0) return false;
              const n = cur.items.length;
              if (sp.event.key === 'ArrowDown') {
                cancelConfirmation();
                setSelected((i) => (i + 1) % n);
                return true;
              }
              if (sp.event.key === 'ArrowUp') {
                cancelConfirmation();
                setSelected((i) => (i - 1 + n) % n);
                return true;
              }
              if (sp.event.key === 'Enter' || sp.event.key === 'Tab') {
                if (composerComposing(sp.view, sp.event)) return false;
                acceptMentionRef.current(selectedRef.current);
                return true;
              }
              if (sp.event.key === 'Escape') {
                markComposerEscape(sp.event);
                cancelConfirmation();
                exitSuggestion(sp.view);
                return true;
              }
              return false;
            },
            onExit: () => {
              cancelConfirmation();
              suggestionOpenRef.current = false;
              setPopup(null);
            },
          }),
        },
      }),
      MentionEnter,
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const editor = useEditor({
    extensions,
    content: draftToDoc(value, mentions),
    editable: !disabled,
    editorProps: {
      attributes: { role: 'textbox', 'aria-label': 'Message', 'aria-multiline': 'true' },
      handleKeyDown: (view, event) => {
        if (event.key === 'Backspace' || event.key === 'Delete') adoptPendingDomSelection(view);
        // The @-mention suggestion owns navigation/accept keys while open.
        if (suggestionOpenRef.current) return false;

        // The /-command popup owns ↑↓/Enter/Tab/Esc while open.
        if (slashOpenRef.current) {
          const n = slashItemsRef.current.length;
          if (event.key === 'ArrowDown') {
            cancelConfirmation();
            setSlashSelected((s) => (s + 1) % n);
            return true;
          }
          if (event.key === 'ArrowUp') {
            cancelConfirmation();
            setSlashSelected((s) => (s - 1 + n) % n);
            return true;
          }
          const highlighted = slashItemsRef.current[slashSelectedRef.current];
          // A row that takes nothing after it and is already the whole text
          // has nothing left to complete: Enter sends it.
          const complete = event.key === 'Enter' && highlighted && highlighted.source !== 'agent' && !highlighted.takesArgs
            && view.state.doc.textContent === `/${highlighted.name}`;
          if (complete) {
            cancelConfirmation();
            pickSlash(highlighted as SlashEntry);
          } else if (event.key === 'Enter' || event.key === 'Tab') {
            if (composerComposing(view, event)) return false;
            event.preventDefault();
            acceptSlashRef.current(slashSelectedRef.current);
            return true;
          }
          if (event.key === 'Escape') {
            markComposerEscape(event);
            event.preventDefault();
            escapeSlashRef.current();
            return true;
          }
        }

        if (event.key === 'Enter') {
          // IME guard: never submit mid-composition (matches the old textarea path).
          if (composerComposing(view, event)) return false;
          // ⇧⌘↩ belongs to the shell (zoom the pane): no newline, no send.
          if (event.shiftKey && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            return true;
          }
          if (event.shiftKey) {
            // Shift+Enter inside a formatted block runs the block-native Enter
            // (next list item, newline in code, new paragraph in a quote) so
            // markdown drafting can continue; in a plain paragraph fall
            // through to the default hardBreak soft newline.
            if (!enterContinuesBlock(view.state)) return false;
            const ed = editorRef.current;
            if (!ed) return false;
            event.preventDefault();
            return ed.commands.first(({ commands }) => [
              () => commands.newlineInCode(),
              () => commands.splitListItem('listItem'),
              () => commands.createParagraphNear(),
              () => commands.liftEmptyBlock(),
              () => commands.splitBlock(),
            ]);
          }
          const branch = event.metaKey || event.ctrlKey;
          event.preventDefault();
          onSubmitRef.current?.({ branch });
          return true;
        }
        return false;
      },
      handleDOMEvents: {
        paste: (_view, event) => {
          onPasteRef.current?.(event as ClipboardEvent);
          // If the host handler called preventDefault (e.g. long-text→file),
          // tell ProseMirror to skip its default text insertion.
          return event.defaultPrevented;
        },
        // openOnClick is off (links are editable text); only Cmd/Ctrl+click
        // opens. Every other click on a link places the caret and must not
        // navigate natively (a disabled composer is not contenteditable).
        click: (_view, event) => {
          const href = (event.target as HTMLElement | null)?.closest('a[href]')?.getAttribute('href');
          if (!href) return false;
          event.preventDefault();
          if (event.metaKey || event.ctrlKey) openPreferredUrl(href);
          return true;
        },
        auxclick: (_view, event) => {
          if ((event.target as HTMLElement | null)?.closest('a[href]')) event.preventDefault();
          return false;
        },
      },
    },
    onUpdate: ({ editor: ed }) => {
      const draft = docToDraft(ed.getJSON() as Parameters<typeof docToDraft>[0]);
      const serialized = serialize(draft.value, draft.mentions);
      // TipTap can emit an unchanged document during initialization. Echoing
      // it can overwrite an external draft waiting for its next React render.
      if (serialized === lastSyncedRef.current) return;
      lastSyncedRef.current = serialized;
      onChange(draft);
      // hardBreak at the bottom of the scroll window doesn't auto-scroll; assert
      // it next frame. Guard isDestroyed: the editor may unmount between this
      // edit and the rAF (e.g. submit clears + the pane closes, fast nav).
      requestAnimationFrame(() => {
        if (!ed.isDestroyed) ed.commands.scrollIntoView();
      });
    },
  });
  editorRef.current = editor ?? null;

  // External → editor: re-sync only when the incoming props differ from what we
  // last emitted/applied (draft restore, clear-on-send, history redo). Guard
  // prevents the onChange → setState → props → setContent feedback loop.
  useEffect(() => {
    if (!editor) return;
    const incoming = serialize(value, mentions);
    if (incoming === lastSyncedRef.current) return;
    lastSyncedRef.current = incoming;
    // The text a pick was made for is gone; the host gives the pick of a
    // restored draft itself (onSlashPick is not told).
    pickedSlashRef.current = null;
    editor.commands.setContent(draftToDoc(value, mentions), { emitUpdate: false });
  }, [editor, value, mentions]);

  useEffect(() => {
    if (disabled) cancelConfirmation();
    editor?.setEditable(!disabled);
  }, [editor, disabled, cancelConfirmation]);

  // Recompute /-command context from the editor's text + caret on every doc or
  // selection change. The caret's TEXT offset is derived with the same leaf
  // serialization docToDraft uses (mention → `@label`, hardBreak → `\n`) so it
  // lines up with `value`.
  useEffect(() => {
    if (!editor) return;
    const recompute = () => {
      cancelConfirmation();
      const v = docToDraft(editor.getJSON() as Parameters<typeof docToDraft>[0]).value;
      const before = editor.state.doc.textBetween(0, editor.state.selection.from, '\n', (node) =>
        node.type.name === 'mention'
          ? `@${node.attrs.label ?? node.attrs.refId ?? ''}`
          : node.type.name === 'hardBreak'
            ? '\n'
            : '',
      );
      const picked = pickedSlashRef.current;
      if (picked && !keepsSlashPick(v, picked.name)) {
        pickedSlashRef.current = null;
        onSlashPickRef.current?.(null);
      }
      const ctx = matchSlashContext(v, before.length);
      // A skill picked by the name /agent takes arguments, not an agent.
      setSlashCtx(ctx?.command === 'agent' && pickedSlashRef.current?.source === 'skill' ? null : ctx);
      setSlashSelected(0);
    };
    editor.on('update', recompute);
    editor.on('selectionUpdate', recompute);
    const blur = () => {
      cancelConfirmation();
      exitSuggestion(editor.view);
      setSlashCtx(null);
    };
    editor.on('blur', blur);
    recompute();
    return () => {
      editor.off('update', recompute);
      editor.off('selectionUpdate', recompute);
      editor.off('blur', blur);
    };
  }, [editor, cancelConfirmation]);

  // An Escape that ends an IME composition belongs to it. ProseMirror skips
  // keys during a composition, so mark them in a capture listener on the
  // editor's own element, ahead of its handlers and without changing them.
  //
  // The editor may have no view here: useEditor can hand over an instance
  // its own scheduled destroy already took (a slow commit lets that 1ms
  // timer win; the replacement arrives next render), and TipTap's `view`
  // throws for `dom` until one is mounted. Listen whenever a view exists.
  useEffect(() => {
    if (!editor) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (editor.view.composing || isImeComposing(event))) {
        markComposerEscape(event);
      }
    };
    let dom: HTMLElement | null = null;
    const detach = () => {
      dom?.removeEventListener('keydown', onKeyDown, true);
      dom = null;
    };
    const attach = () => {
      detach();
      // isDestroyed is also true while no view is mounted.
      if (editor.isDestroyed) return;
      dom = editor.view.dom;
      dom.addEventListener('keydown', onKeyDown, true);
    };
    attach();
    editor.on('mount', attach);
    editor.on('unmount', detach);
    return () => {
      editor.off('mount', attach);
      editor.off('unmount', detach);
      detach();
    };
  }, [editor]);

  // Links open only on Cmd/Ctrl+click, so they show the pointer only while one
  // of those keys is held: flag the host for the CSS.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const sync = (event: KeyboardEvent | MouseEvent) => {
      host.toggleAttribute('data-link-modifier', event.metaKey || event.ctrlKey);
    };
    const clear = () => host.removeAttribute('data-link-modifier');
    window.addEventListener('keydown', sync, true);
    window.addEventListener('keyup', sync, true);
    window.addEventListener('blur', clear);
    host.addEventListener('mousemove', sync);
    return () => {
      window.removeEventListener('keydown', sync, true);
      window.removeEventListener('keyup', sync, true);
      window.removeEventListener('blur', clear);
      host.removeEventListener('mousemove', sync);
      clear();
    };
  }, []);

  // Bind slash actions once the editor exists.
  useEffect(() => {
    acceptSlashRef.current = (idx: number) => {
      const it = slashItemsRef.current[idx];
      if (!it || !editor) return;
      confirm(slashItemKey(it), () => {
        // Agent picker: invoke the switch and clear the composer.
        if (it.source === 'agent') {
          if (it.modeId) onSwitchAgentRef.current?.(it.modeId);
          editor.commands.clearContent();
          editor.commands.focus('end');
          return;
        }
        // Replace the whole composer with `/<name> ` (slash is always at start).
        // Picked first, so the update the new text fires knows what it is for.
        pickSlash(it as SlashEntry);
        const text = `/${it.name}${it.takesArgs ? ' ' : ''}`;
        editor.commands.setContent(draftToDoc(text, []));
        editor.commands.focus('end');
      });
    };
    escapeSlashRef.current = () => {
      cancelConfirmation();
      editor?.commands.clearContent();
      editor?.commands.focus();
    };
  }, [editor, confirm, cancelConfirmation, pickSlash]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => editor?.commands.focus(),
      startMention: (at = 'caret') => {
        if (!editor || editor.isDestroyed) return;
        editor.commands.focus(at === 'end' ? 'end' : null);
        editor.commands.insertContent(`${spaceBeforeMention(editor)}@`);
      },
      editor: editor ?? null,
    }),
    [editor],
  );

  return (
    <div ref={hostRef} style={{ position: 'relative', flex: 1, minWidth: 0 }} className="mention-editor-host" data-handles-links="" data-empty={editor?.isEmpty ? 'true' : undefined}>
      {props.placeholder && <span className="mention-editor-placeholder" aria-hidden="true">{props.placeholder}</span>}
      <EditorContent editor={editor} className={className} data-testid={props['data-testid']} />
      <SuggestionPopup state={popup} selected={selected} anchor={hostRef.current} onHover={setSelected}
        onPick={(i) => acceptMentionRef.current(i)} blinkingId={blinkingId} />
      <SlashCommandPopup
        items={slashItems}
        query={slashCtx?.query ?? ''}
        selected={slashSelected}
        anchor={hostRef.current}
        onHover={setSlashSelected}
        onPick={(i) => acceptSlashRef.current(i)}
        blinkingId={blinkingId}
      />
    </div>
  );
});

export default MentionEditor;
