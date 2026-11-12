import { Extension, type Editor } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * A chip picked from the @ menu grows out of the query it replaces instead of
 * swapping in at full width. For one beat the new mention node carries
 * `.mention-chip--enter` (index.css): its fill opens from the typed query's
 * width to the whole label, its padding eases in so the text after it moves
 * rather than jumps, and the typed `@query` (drawn from `data-from`) fades
 * into the label.
 *
 * It is a node decoration, so ProseMirror owns the class and attributes and
 * maps them through any typing that follows; the chip's own DOM is the one
 * renderHTML always makes.
 */

/** How long the decoration stays: the animation's length plus a frame. */
export const MENTION_ENTER_MS = 380;

type EnterMeta = { pos: number; from: string; width: number } | 'clear';

export const mentionEnterKey = new PluginKey<DecorationSet>('mentionEnter');

export const MentionEnter = Extension.create({
  name: 'mentionEnter',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: mentionEnterKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const meta = tr.getMeta(mentionEnterKey) as EnterMeta | undefined;
            if (meta === 'clear') return DecorationSet.empty;
            const mapped = set.map(tr.mapping, tr.doc);
            if (!meta) return mapped;
            const node = tr.doc.nodeAt(meta.pos);
            if (node?.type.name !== 'mention') return mapped;
            return DecorationSet.create(tr.doc, [
              Decoration.node(meta.pos, meta.pos + node.nodeSize, {
                class: 'mention-chip--enter',
                'data-from': meta.from,
                style: `--mention-from-w: ${Math.max(0, Math.round(meta.width))}px`,
              }),
            ]);
          },
        },
        props: {
          decorations: (state) => mentionEnterKey.getState(state),
        },
      }),
    ];
  },
});

/**
 * Marks the mention just inserted at `pos` as entering, then clears the mark
 * once it has played. Call straight after the insert, before the browser
 * paints, so the chip's first frame already carries the mark.
 */
export function markMentionEnter(editor: Editor, pos: number, from: string, width: number): void {
  const { tr } = editor.state;
  editor.view.dispatch(tr.setMeta(mentionEnterKey, { pos, from, width } satisfies EnterMeta));
  window.setTimeout(() => {
    if (editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(mentionEnterKey, 'clear' satisfies EnterMeta));
  }, MENTION_ENTER_MS);
}
