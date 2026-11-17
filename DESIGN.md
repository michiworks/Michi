# Michi frontend design rules

Binding for Michi frontend code. Precedence: owner decision > these rules > local habit. Values, sources, decided questions: `docs/design/`; baseline f578af740.

Tags: [EK] Kowalski, [RF] Freiberg, [WIG] Vercel, [HIG] Apple, [M3] Material 3, [WCAG] 2.2, [RUI] Refactoring UI, [LIN] Linear, [CODE] code, [OWNER] owner.

## Tokens

- **TK-01** Every `var(--x)` is defined; palette, type, motion and font tokens are written bare. The only token fallback is `var(--term-hover-bg, var(--term-alt))`. [LIN][M3]
- **TK-02** Colour through a role: `var(--term-*)`, `--sel-bar-*` on dark bars, or Tailwind's safe list — `bg-app`, `bg-surface`, `text-fg`, `text-fg-muted`, `text-fg-subtle`, `border-line`, `text-(--term-mid)`. No hex, rgb, legacy alias, `text-muted` or `text-danger`. [HIG]
- **TK-03/TK-04/TK-06** Page `--term-bg`; pane, card, popover, menu, dialog `--term-surface`; card over reading text `--term-float-bg`; chrome code `--term-alt`; dark bar `--sel-bar-bg`. Primary text `--term-fg`, secondary `--term-mid`, accent words `--term-accent-text` (never `--term-accent`), captions and placeholders `--term-muted` (never `--term-faint`), non-informative marks `--term-faint`. New pairs ≥4.5:1; informative icons ≥3:1. [WCAG 1.4.3][RUI]
- **TK-05/ST-16** Running `--term-run` (never accent); waiting `--term-waiting*`; success, finished runs `--term-digest`; tools and merges `--term-mauve`. Words that fail, invalidate or destroy, and new danger glyphs: `--term-danger-text`; borders and fills `--term-danger`; filled danger buttons only `<Button variant="primary" danger>`. [WCAG 1.4.3][RUI]
- **TK-07/TK-08** Hover and pressed fills on rows, menu items, buttons and chips: `var(--term-hover-bg, var(--term-alt))` (`--sb-card-hover` on glass, `--sel-bar-hover` on dark bars), ghost controls pressing 10% further toward `--term-fg`; both change only the fill. Tints: accent soft `--term-accent-f`, translucent accent 12%/18%, skeleton fg 6%, status border hue 35% into `--term-line`, accent-button hover 12% toward `--term-fg`. [HIG][M3][OWNER m:49v1]
- **TK-10** Chrome text sizes through `--fs-*`, never between steps: 2xs 9px kind tags, xs 10px metadata, sm 11px field labels and chips, md 12px buttons and fields, lg 13px titles and menu rows, 3xl 18px empty-state headlines. Touch fields ≥16px. [CODE][M3]
- **TK-17** Spacing (padding, margin, gap, inset): even px 2–24, then multiples of 4, or the density variable that covers it (`--pane-gutter`, `--sb-row-py`, `--m-rowX`); odd px only for 1px-border compensation, a commented ±1px nudge, or the badge (5px) and chip (1×6px) recipes. [RUI][M3]
- **TK-20/TK-21** Round only through the pref: `--ui-radius` floating surfaces, in-flow cards, buttons, tab pills; `--ui-radius-sm` nested rows, inputs, badges, tooltips; `--ui-radius-lg` hover cards; `--ui-radius-pill` dots and avatars, never a button; the composer family `--term-composer-radius`; panes, bars and paper cards square. Step one token down inside a rounded surface. [OWNER c:e6][M3][HIG]
- **TK-24** Shadows by elevation, never a literal: in flow none; clickable card on hover `--term-line-s` + `--term-composer-shadow-muted`; floating `--term-float-shadow`; popovers and menus `--ui-popover-shadow`, tooltips `--ui-tooltip-shadow`; dark bars `--sel-bar-shadow`; modals and drawers `.term-glass` over a scrim. [M3][EK]
- **TK-29/TK-30** Durations: `--t-quick` 60, `--t-soft` 100, `--t-brief` 120, `--t-dismiss` 80, `--t-enter` 180, `--t-exit` 110, `--t-move` 220, `--t-collapse` 160, `--t-scrim-exit` 140, `--t-decay` 360, `--t-slow` 600ms, mirrored in JS `DUR` (plus `DUR.expand` 260ms). State changes `--t-ease`, entrances `EASE.out`, panels `EASE.drawer`. No retyped numbers; no overshoot outside `SPRING` or on a frequent mark. [EK][M3]

## Motion

- **MO-01/TR-02** Content on first render — hydration, reload, remount, lazy chunk, tree/page/pane switch, "Show N more", cached Home — renders settled (`AnimatePresence initial={false}`). Only items created while their container is on screen enter, judged once by `useFresh` (`FRESH_MS`, 1000ms). [OWNER c:1fy]
- **MO-04/MO-05** Duration from the element's row: hovers 60ms, menu items and fields 100ms, menus 120/80, modals 180/110, drawers and sheets 180/160, TR-18 disclosures 260/160, layout moves and pane tracks 220/160. Waited-on ≤180ms (overlays), ≤260ms (disclosures, layout). [EK][M3]
- **MO-06/MO-12** Exits shorter than entrances (pairs above; drawers 160ms, not DrawerShell's 180ms); a scrim clears inside its panel's exit. Only TR-18 disclosures scroll: down on open, never back on collapse. [OWNER m:74v1][M3]
- **MO-11/MO-16** Animate `transform` and `opacity`; colour transitions fine. Resize by committing layout in the click's commit, then transform or clip-path, or a motion `height` tween on one small subtree. No `transition: all`, no live blur, no layout reads in animation frames (MO-16's scroll followers excepted). [EK]
- **MO-13** Loops are CSS classes animating only opacity or transform (sole exception: the Map's feeding-edge dashes) on a loop token (1s spinners, 1.4s pulses and skeletons, 2.4s ambient); run while live, pause hidden (`animation-play-state: paused`), rest on a visible frame, stop under reduced motion (WCAG 2.2.2). [CODE][RF][OWNER]
- **MO-14/MO-15** Reduced motion is OS `prefers-reduced-motion` OR Settings › Reduce motion: one catch-all covers both, inline styles too; write a differing end state for both (media query plus `:root[data-reduce-motion='on']`); WAAPI, `animate()`, rAF and scripted scrolls call `prefersReducedMotion()`. Appearing elements keep at most an opacity fade; moves, loops and text pacing stop. [WCAG 2.3.3][EK]
- **MO-17/ST-27** Streaming-time motion costs no extra renders: trigger from a state transition read through `useStructuralSelector`, target module constants, no state, timer or rAF per chunk or frame. Dim with a layer of its own, not `filter` (an unfocused pane's surface recedes under its content, leaving the text); desktop overlays and moving phone surfaces are opaque; background panes never take focus. [OWNER c:3s]

## Transitions

- **TR-01** Every surface that opens, closes or resizes is built from its primitive — `ModalShell`, `DrawerShell`, `BottomSheet`, `PhoneContextMenu`, `PopoverSurface`, `HoverTip`, sonner, `NoticeMotion`, `Reveal` — inheriting its motion and reduced-motion path; extend the closest, never a new recipe, and keep TK-31's owner-set timings. [CODE][LIN][OWNER]
- **TR-03** Closing a surface makes the leaving layer `inert`, `aria-hidden` and click-through in that commit, out of Esc and Back routing, with focus returned; its exit plays on that ghost, nothing waiting for it but a menu's 160ms confirm blink. [HIG][WCAG 2.4.3]
- **TR-12/TR-13** Every desktop menu and anchored popover — `ContextMenu`, `ActionMenu`, `DbPopover`, `MichiMenu` — grows through `PopoverSurface` inside `<AnimatePresence>`: 34ms placement hold, then opacity and scale .97→1 over 120ms `EASE.out`, out 80ms. Autocompletes fade in 100ms; picks blink 160ms unless they navigate. [CODE][EK]
- **TR-28** Lists changed by filter, sort, search, "Show N more", delete or poll re-render in one frame; only fresh arrivals enter (`RevealList` 160ms, `BranchRow` grow, 4px rise); system re-sorts glide 220ms `EASE.drawer` away from the pointer and land at once under it. [RF]
- **TR-41** One-frame change for restores, page/route/tab/view/workspace switches, per-keystroke and poll results, ticking values, keyboard highlights (background only, ≤100ms), a pick that navigates, breakpoint crossings, pointer-tracked manipulation, status swaps, disclosures outside TR-18, banners and palette changes. [M3][EK][RF]
- **TR-43** A non-modal surface over focusable content never fully hides the focused element: reflow beside it, close when focus moves under it, or act modal. [WCAG 2.4.11]

## States

- **ST-01** Build an interactive element from its primitive (`Button`, `.t-icon-btn`, `.t-text-btn`, `Row`, `MenuItem`, `.ui-input`, `Switch`, `Segmented`) and give every state its row — rest, hover, pressed, focus-visible, disabled, selected, busy. When none fits, copy the row. [CODE][WIG]
- **ST-02** Every `:hover` sits inside `@media (hover: hover)`, CSS strings in TSX included; `:active` takes its press fill (ST-06) outside the gate, so taps show a press. [RF][LIN][OWNER c:14q]
- **ST-05** Never set resting `color`, `background`, `border-color` or `opacity` in `style={{…}}` on an element with a state class (it beats the state); pass a custom property the class reads, no `!important`. [CODE]
- **ST-07/ST-08/ST-09** Keyboard focus is `outline: var(--focus-ring)` on `:focus-visible`, offset `1px` standalone, `-2px` on rows and tabs, `--sel-bar-fg` on a dark bar; never thinner, transitioned or a literal colour. Any `outline: none` draws a visible replacement plus `outline: 2px solid transparent`, never inline. Rows light for `:focus-visible`, never `:focus-within`. [WCAG 2.4.7][WIG]
- **ST-11/ST-13** Disabled buttons, fields, switches and chips: `opacity: 0.5; cursor: not-allowed`; primary keeps opacity 1 with `--term-alt2` fill and `--term-muted` ink; menu rows and toolbar chips go `--term-faint`, no opacity; disabled is inert. While async work runs: `aria-disabled`, disabled look, `cursor: progress`, a "…" label at a kept width, `aria-busy`. [M3][EK][WIG]
- **ST-15** Pick loading, empty, no-match or failed from explicit status, never `items.length === 0`: a loader; one `--term-muted` `--fs-md` sentence + one action, below a 30px `--term-faint` line icon; "No matches" + a way to clear; failed in `--term-danger-text` + Retry. Unavailable backend is "not loaded". [LIN][WCAG 4.1.3]
- **ST-20/ST-34** Actions are `<button type="button">`, navigation `<a href>`; a whole-row action is a stretched `<button>` with sibling buttons above it, never a click-only `div`. Use `aria-expanded`, `aria-pressed`, `role="switch"`, `aria-current`, roving `tabIndex`; icon-only buttons carry an `aria-label` matching their `HoverTip`. "↗" only for links leaving Michi. [WIG][WCAG 2.1.1]
- **ST-21** Fine-pointer targets ≥24×24, or 2.5.8 spacing (22px bar controls on a ≥24px pitch, two `Button size="sm"` 5px apart). On touch, rows ≥44px, buttons ≥40×40 via negative margins. Density changes padding, never a minimum. Folder rows: tap opens, caret folds (ST-36). [WCAG 2.5.8][WIG][OWNER]
- **ST-23/ST-27** State never changes `font-weight`, size or letter-spacing: show it by colour, a fill or a bar. Interaction states come from CSS pseudo-classes and attributes, not React pointer state (listbox highlight excepted); live regions announce transitions, never a per-second or per-chunk count. [RF][WCAG 4.1.3]
- **ST-35** An undoable delete (to Trash) runs at once with an Undo toast, never behind a confirm. [OWNER ST-Q8]

## Self-check after writing frontend code

- [ ] `rg -n '[0-9]+ms|cubic-bezier|#[0-9a-fA-F]{3,8}\b|rgba?\('` — every hit is a palette or named constant, never a token's value retyped; each new `var(--…)` is defined (TK-01, TK-02, TK-29, MO-04).
- [ ] `rg -n ':hover|:active'` — `:hover` inside `@media (hover: hover)`, `:active` outside and colour only (ST-02, ST-06).
- [ ] `rg -n 'style=\{\{[^}]*(color|background|border|opacity)'` — none on an element with a state class; no `outline: 'none'` (ST-05, ST-08).
- [ ] `rg -nP "(?<![-\w])color:\s*'?var\(--term-accent\)"` — glyphs and borders only (TK-06).
- [ ] Tab and measure each new control: ST-07's ring, ST-21's minimums, ST-11's disabled and ST-13's busy states.
- [ ] Toggle Settings › Reduce motion, then the OS setting: identical reduced forms (MO-14).
- [ ] Reload, switch tree, reopen a pane: nothing replays, fresh items animate (MO-01).
- [ ] Two panes streaming: no render, timer or rAF per chunk from your change (MO-13, MO-17).
- [ ] New opening or closing surface runs through a primitive, or is a cut TR-41 allows; `rg -n 'animate=\{false\}'` finds no menu (TR-13).
- [ ] `npm test -w frontend -- src/components/terminal/tokens.test.ts src/motion/tokens.test.ts src/motion/tokens.css.test.js src/focusRing.css.test.js src/hoverReveal.css.test.js src/dangerText.css.test.js src/components/terminal/buttonStates.css.test.js src/components/terminal/mobile.css.test.js` passes.

## Index

- [docs/design/tokens.md](docs/design/tokens.md) — colour roles and mix recipes, prose and file-badge colours, type scale, spacing, control, icon and radius sizes, borders, elevation, glass, z-index, opacity, duration, easing and owner-timing tables.
- [docs/design/motion.md](docs/design/motion.md) — durations and curves per element, exits, interruption, origin and scale, animatable properties, scrolling, loops, highlights, reduced motion, streaming cost, panes frozen off the strip.
- [docs/design/transitions.md](docs/design/transitions.md) — per-surface enter and exit: dialogs, palettes, drawers, sheets, menus, tooltips, toasts, disclosures, panes, lists, loading hand-offs, drag, breakpoints, when a hard cut is right.
- [docs/design/states.md](docs/design/states.md) — the component state matrix, hover gating, focus rings and focus management, disabled, busy, empty and failed states, selection, hit targets, cursors, keyboard semantics, drag, confirmation.
