# Landing engine and replica kit: the contract for section builders

Owner: engine. Files: `css/30-kit.css` (replica kit), `css/31-kit-motion.css` (motion, states, engine CSS),
`js/00-core.js` (namespace `M`, clock, takes, gating, fitting, text, follow-the-tail, debug API), `js/05-ops.js`
(generic ops), `js/10-boot.js` (boot protocol, listeners), `js/99-start.js` (boot call), `smoke.mjs` (test).
The sections below describe the shipped landing engine.

Everything below is a promise: if you follow the markup and API, the engine handles timing, gating, reduced motion,
no-JS, controls, focus and replay for you. Section files only describe *what* happens and *when*.

---

## 1. The model in one paragraph

The HTML ships every figure at its settled frame **tB** (that is what no-JS, reduced motion, link previews and late
boots show). Each animated figure is a **take**: a named root element, a list of steps `[atMs, op, ...args]`, and a
description of its start frame **tA** (mostly declarative, `data-ta`). The engine snapshots tB at boot, brings a take
to tA invisibly when it needs to, plays its steps on one shared `requestAnimationFrame` clock, holds at the end, and
can always jump to tB (`finish`) or back to tA (`reset`). Ops only toggle classes, set text or set inline values; CSS
does every tween with Michi's own tokens. Text is laid out at final size from the start: words and typed characters
are hidden with `visibility`, never inserted, so nothing reflows.

---

## 2. Markup conventions

### 2.1 A take

```html
<section id="how" aria-labelledby="how-h">
  <h2 id="how-h">Every branch is a whole conversation. <span class="h2-c" data-live-for="verbs">Open more, …<i class="live-caret"></i></span></h2>
  <figure class="how-fig" data-take="verbs">                          <!-- take root: data-take = take name -->
    <div class="mk-fit" data-w="760" data-h="520" data-take-observe>  <!-- gating target (optional; default = root) -->
      <div class="mk mk-canvas" aria-hidden="true">                   <!-- the replica: aria-hidden, nothing focusable -->
        … kit markup (§4) …
      </div>
    </div>
    <p class="sr-only">Animated example in three steps. …</p>        <!-- narration beside the replica (brief §3.15) -->
    <div class="take-bar"> … shell take chrome (20-components.css header) … </div>
  </figure>
</section>
```

| Attribute | On | Meaning |
|---|---|---|
| `data-take="name"` | take root | The take's name and scope. `M.take({name})` finds it by default. Classes the engine puts here: `.instant`, `.is-paused`; attribute `data-take-state="armed|playing|paused|held"`. |
| `data-take-observe` | one element in the root | The element whose visibility gates the take (use the replica box, not the whole section). |
| `data-take-control="pause|replay|play"` | `<button hidden>` | Take chrome (the shell's `.take-ctl`). The engine binds clicks, toggles `hidden`, sets `aria-pressed` on Pause and moves focus to the replacement button. Ship them `hidden`. |
| `data-take-hold` | caption, hint, breadcrumb | Hold UI: always laid out (no shift), `.is-off` (faded, hidden) until the hold. |
| `data-take-for="name"` | an ancestor of controls/hold UI outside the root | Binds them to that take (the hero's bar uses `data-take-for="hero"`). |
| `data-live-for="name"` | the H2's consequence span | Goes `.is-live` (violet, `.live-caret` fades in) when the take starts; at most one on the page; cleared when it leaves view (brief P7/P8). Its resting colour comes from your heading CSS. |
| `data-t0="hide|shift"` | hero only | The CSS first-paint start frame (brief §5.12): `hide` = exists only in tB (`visibility:hidden`, CSS fail-safe reveals it at 2.5 s), `shift` = main content `translateX(var(--t0-shift, 250px))`. `data-t0="hide"` also means "off at tA" for the JS start frame. |
| `data-ta="off|on|hide"` | any element in a take | Declarative tA. `off`: add `.is-off` (element must carry a motion class, §5); `on`: remove `.is-off` (shown at tA, hidden at tB); `hide`: hide every streamed/typed token inside. Space-separated. |
| `data-ta-text="…"` | a plain label | Its text at tA (the HTML holds the tB text). |
| `data-ta-cls="+a -b"` | any element | Classes added/removed at tA (e.g. `+is-running`, `+has-caret`, `-is-focused`). |
| `data-stream` | prose container | Text inside becomes `.w` word tokens (stream op). |
| `data-type` | span inside an input | Text inside becomes `.c` character tokens (type op). Whitespace is normalised; write the text inline. |
| `data-token` | element inside `data-stream`/`data-type` | One token (chips are tokens automatically: `.mk-mention`). |
| `data-skip` | element inside `data-stream`/`data-type` | Not tokenised. `.mk-placeholder` and `<svg>` are skipped too. |
| `data-follow` | `.mk-list` | Follow-the-tail list (§7). |
| `data-rt` | nodes you create at runtime | Removed by `reset()` (visitor-branch bookmarks, rows you insert). |
| `data-keep-style` | element in a take | Inline style is yours; `reset()` will not restore it. |

### 2.2 tB in HTML, tA declared

- Write the replica exactly as it looks at the hold. Everything a take reveals is already there.
- Anything that is hidden at tA must carry a motion class so `.is-off` hides it: `.e` + shape (enter/exit), `.grow`
  (row that grows), `.draw` (SVG stroke), `.strike`, `.e-scene` (scene in a frame), or be a token container
  (`data-ta="hide"`). Elements present in both frames need nothing.
- Inputs that hold typed text at tB carry `.has-text` in the HTML (hides `.mk-placeholder` without JS).
- `reset()` = restore the boot snapshot (every element's `class` and `style`, markup touched by `text`, attributes
  touched by `attr`), remove `[data-rt]`, show all tokens, apply `data-t0="hide"` / `data-ta*`, run your
  `def.reset(tk, c)`, fit follow lists to their tA tail. So a take can be reset from any state.
- Every replica box has a fixed size at every breakpoint (a `.mk-fit` canvas or an explicit height in your CSS).
  Rows that grow change layout *inside* the box only. Fluid compositions must reserve their slots.

### 2.3 Accessibility

Replicas are `aria-hidden="true"`, not `inert` (hot phrases take pointer clicks), and contain no focusable elements:
build them from `div`/`span`, never `button`/`a`. The sr-only narration sits beside each replica; the Map's cards
become real buttons after its hold (map builder). Controls are real buttons from the shell's chrome.

---

## 3. Lifecycle

States: `armed` (at tA, waiting), `playing`, `paused`, `held` (at tB; Replay shows). Steps scheduled after a `hold`
step keep running as a coda while `held` (Replay already shows).

Boot (`M.boot`, from 99-start.js, after every file registered):
1. Fit every `.mk-fit`, read every take's observe box.
2. Per take: `M.prepare` (tokenise), snapshot tB, then place it:
   - reduced motion, or `autoplay:false`: **tB** (`held`).
   - `hero:true`: **tA** if the head script set `data-take-hero="t0"` and we boot before 2400 ms; otherwise **tB** with
     Replay (the CSS fail-safe may have revealed tB already).
   - `session` key already set this session: **tB**.
   - otherwise **tB** if the observe box intersects the viewport at boot, **tA** (invisibly) if it does not.
   Setting `data-motion` top-anchors every follow list (§7), so every take fits its lists in this same task: armed
   ones in `reset()`, held ones with `tk.fit()`. No frame shows a list unfitted, and the switch from the CSS
   bottom anchoring is a same-frame transform hand-over (no layout shift is reported for it).
3. `data-hero-ready` is set on `<html>` in the same task as the hero's reset, so the CSS start frame hands over without
   a flash. The hero's `--k` is already final before first paint: an inline script right after the hero figure
   (20-hero.html) runs the same fit as `M.fit`, so boot finds it unchanged.
4. One IntersectionObserver (thresholds `0, .25, .5`) gates every take: an armed take starts at >= 50 % visible
   (once per load); a playing or paused take is `finish()`ed below 25 %; starting one take finishes any other.
   A box taller than the viewport counts the share of the viewport it fills, tracked on scroll (its IO ratio lags
   that share, so the crossings alone would start it late and could leave it running under 25 %). The hidden-tab,
   reduced-motion and breakpoint listeners are live: hidden tab pauses (no catch-up burst on return), reduced
   motion on finishes everything, a new composition (1280 / 1024 / 768) finishes busy takes, re-applies tA to
   armed ones and refits held ones. Window resizes and the fonts arriving refit every idle take (`tk.fit()`).
5. `onBoot` hooks run, then `window.__michi` is exposed and `'boot'` is emitted.

Boot also wires the nav hairline's fallback (brief P1): where `animation-timeline: scroll()` is unsupported, the
shared scroll listener (passive, rAF-throttled) toggles `.is-scrolled` on `header.nav` past 8 px; the 150 ms
linear transition is in `20-components.css`.

Reduced motion (live): every figure at tB, the take's Play button shows ("Play the example as steps"), which replays
the step list as discrete cuts 700 ms apart (tA first, then each cut; steps closer than `cutMerge`, 240 ms, share a
cut), no tweens. All engine and kit transitions and animations are off under the media query.

Pause and resume: `pause()` freezes every animation in the root (`animation-play-state`); `resume()` skips each
infinite loop forward by the pause length, so loops stay in the wall-clock phase `M.lock` gives loops that start
later (staggers kept). One-shots stay on take time. A hidden tab pauses the same way.

Focus: `restart()` (Replay, Play as steps, a tab pick, `R`) keeps focus on the take. If it was on a control or inside
the figure and that element is now hidden (Replay, a Map card), it moves to the control now shown (Pause). The engine
does this after `play()`, because browsers blur a hidden focused element only later.

No JS: the HTML is tB; the shell hides controls and hints; nothing in the kit depends on JS to look settled. If
main.js never boots after the head script set `.js`, the JS-only affordances (hints, keycaps, the keys line,
`.js-only`) keep their box but stay invisible until `data-motion` appears (90-global.css).

---

## 4. Kit reference (`.mk` scope, design px at k = 1)

Wrap every replica in `.mk` (token scope, Geist, border-box, list/margin reset). Footnote cards outside replicas use
`<div class="mk mk-bcard" role="dialog">`.

Colours below are Slate's (index.html). The page also ships in Monokai (monokai.html, `html[data-palette="monokai"]`),
so a rule never carries a colour literal: use a `.mk` token (30-kit.css), a page token (01-tokens.css) or a Map band
token (55-map.css), and give a new token a value in every palette block (95-monokai.css).

| Piece | Markup (classes) | Notes |
|---|---|---|
| Canvas | `.mk-fit[data-w][data-h] > .mk.mk-canvas` | §6 fitting. Known sizes 1280/1180/1000/760/640/500 × 740/620/520/440/360/300 need no inline `--w/--h`. `.use-zoom` switches the canvas to `zoom` (Safari fallback). |
| Window | `.mk-window > .mk-top + .mk-winbody` | 10 radius, OS shadow, `#f3f4f6`, clips. Home/Map frames can use `.mk-window` alone. |
| Top row | `.mk-top > .mk-top-l (.mk-tile.mk-top-tile, .mk-top-name, .mk-top-icons) + .mk-top-r (.mk-head-icons)` | 40 tall; icons at x 104/130/156. Beside open panes the app's top row shows the pane captions and, 14 px from the window's right edge, the view cluster (Topbar.tsx); there is no breadcrumb or New chat button. The hero's wide window puts the cluster here and keeps the captions in the pane headers (a simplified layout). |
| Tile | `<span class="mk-tile"><svg viewBox="0 0 1078 1080">…mark without clipPath…</svg></span>` | The span clips the corners (no duplicate `clipPath` ids). Ids `mark-blob`/`mark-eyes` only on the close's copy. |
| Area rail | `.mk-rail > .mk-rail-btn(.is-on) … .mk-rail-spacer .mk-rail-btn` | 48 wide; 34 buttons, radius 7; active: `#d8dbe1`, violet icon, 2 px bar. |
| Sidebar | `.mk-side > .mk-side-label, .mk-srow.is-project[style=--c:#2f6b4e], .mk-srow.is-thread(.is-sel), .mk-srow.is-child, .mk-side-gap, .mk-side-foot > .mk-sfoot` | Row 30, Geist 14. Row text in `.mk-srow-t`; `.mk-srow-caret` (▾); open-in-pane rail `<i class="mk-srow-rail">` (`.is-live` pulses). A row that appears: wrap in `<div class="grow" data-ta="off"><div>…row…</div></div>`. |
| Strip, pane | `.mk-strip > .mk-pane(.is-focused)(.is-streaming)` | Pane width `--pane-w` (500). Second pane gets the 1 px split automatically. |
| Pane header | `.mk-head > i.mk-dot + .mk-head-title + .mk-head-icons` | 36 tall. Title 13: 600 fg focused, 400 mid otherwise (PaneCaption.tsx). Dot: faint, violet focused, amber + pulse while the pane `.is-streaming`. Icon row only on the focused pane: the app's view cluster (`.mk-head-icons`: `span.mk-hplus` "+" mid, then Overview, Map, Digest, Artifacts in faint, 26 px buttons 6 apart, §4.1), folded into one `span.mk-hmore` "⋯" at 700 px and under as ResponsiveToolbar does. Header flash: `fx` op `fx-flash` 600. A `text` crossfade on the title keeps its ellipsis (`.mk-head-title.xf` is a one-column grid). |
| Messages viewport | `.mk-view > .mk-list[data-follow] > .mk-col` | Bottom-anchored before boot (tB needs no JS), top-anchored once `html[data-motion]` is set (§7), padding 16, column `--col` (460), message gap 18. A 16 px surface fade (`.mk-view::before`, the app's pane top fade scaled to the kit's padding) sits under the header (z-index 2, surface fill), so content scrolled past the top never shows a sliver. |
| User bubble | `.mk-user > .mk-over + (.mk-pre … ) + text` | Overline `YOU · 14:05` (write it `You · 14:05`; CSS uppercases). Order: overline, comment blocks, quote chip, text. |
| Assistant | `.mk-msg > .mk-label (> michi) + agent blocks + .mk-prose` | Label 10.5 in the message font, muted, 4 below (MessageBlock.tsx). Prose 15/1.5, `p`/`ol`/`ul` .75em apart, `li` .25em, numerals mid. |
| Quote chip | `.mk-pre.is-msg > .mk-pre-col (.mk-pre-cap "replying to <b>selection</b>", .mk-pre-body) + .mk-pre-exp "expand ▾"` | `.t-pre-block tone-accent is-msg`. |
| Comment (composer) | `.mk-cpre > .mk-pre.tone-select > .mk-pre-col (.mk-pre-cap "comment <b>1</b> · pending on next send", .mk-pre-q, .mk-pre-r) + .mk-pre-x "×"` | Amber 2 px rule. Sent variant: `.mk-pre.tone-select.is-msg` with `.mk-pre-exp`, caption `comment <b>N</b>`. |
| Thought row | `.mk-thought > svg(sparkle) + .mk-thought-label + .mk-chev(▸)` | Bordered card row. |
| Tool card | `.mk-tool > .mk-tool-row > .mk-tool-ic + .mk-tool-main(.mk-tool-title, .mk-tool-sub) + .mk-tool-dur + .mk-tool-st(i.mk-spin, svg.mk-check)` | `tool` op: `.is-running` = violet wash, violet icon, spinner, no duration/check. |
| Tool group | `.mk-group(.is-open) > .mk-group-head(.mk-group-ic(svg, i.mk-spin), .mk-group-label, .mk-group-meta, .mk-chev) + .mk-group-rows > .mk-tool-row.is-line(.mk-tool-name, .mk-tool-detail, .mk-tool-st)` | CardGroupHeader: one label that never changes while the tools run: the collapsed summary (`used 2 tools`, mid) or, expanded (`.is-open`, ▾), `N tool calls` in fg. `group` op: `.is-running` swaps the glyph for the spinner; the meta counts `done/total` (`text` op), then shows the duration. |
| Composer | `.mk-composer(.is-focused) > .mk-cpre? + .mk-cin(.mk-prompt ›_, .mk-input) + .mk-tools(.mk-tchip.is-icon ×2, .mk-tools-gap, .mk-tchip.is-perm (shield Ask), .mk-tchip.is-model, span.mk-tbranch, .mk-send(.is-empty))` | Inset 16/16/12. No context ring (the app draws none below 50 % usage). `.mk-tbranch` (BranchIcon 16, mid, 30 square) shows while the draft has text, that is while the send is neither `.is-empty` nor `.is-stop`; it sits out of flow beside the send and the two chips before it translate 34 px, so typing never reflows the toolbar. A streaming pane dims its model chip to .45 (the disabled trigger). Input min 1.5 rows (`--rows`). Typed text: `<div class="mk-input"><span data-type data-ta="hide">…</span></div>`. Caret: `.has-caret` on the input (start caret when empty, follows typing). `.mk-send.is-empty` = disabled plate (`#c5b7dc`), `.is-stop` shows `.when-stop`. Narrow toolbars follow TPane `tierFor` through a container query on the composer's content box (toolbar + 2 × 10 padding): under 380 px (the app's 360 px toolbar) the permission chip (`.mk-tchip.is-perm`, label in a `<span>`) shows only its glyph and the model chip drops `.mk-tchip-effort`; under 280 px (260 px of toolbar) the branch action stays out. |
| Selection tint | `<span class="mk-hl">task runner role</span>` | `.is-sel` wipes the 26 % tint in (220, `--ease`); `.is-mark` = 30 % highlight, radius 2. |
| Branch underline | `<span class="mk-anchor">…</span>` | Dotted violet underline; `.is-off` = transparent (fades in 180); `.is-open`/hover = mauve 15 % wash. |
| Hot phrase | `<span class="mk-hot">…</span>` | `fx-invite` (2 × 600 wash), `.is-rest` = touch rest tint `#f3f1f8`. |
| Floats | `.mk-float` | Dark surface shared by the selection bar and branch composer (the morph moves one surface). Position it yourself (absolute, in canvas px). |
| Selection bar | `.mk-float > .mk-selbar-tools > .mk-selbar-btn ×3` | `press` op with `{down: 60}` on Branch (`#46505e`). The hero morphs one `.mk-float` surface from the bar into the composer (40-hero.css `.hero-pop`). |
| Branch composer | `.mk-bcomp-head(span, .mk-bcomp-x) + .mk-bcomp-quote + .mk-bcomp-input(.mk-placeholder, span[data-type]) + .mk-bcomp-foot(.mk-bcomp-btn Cancel .mk-kbd, .mk-bcomp-btn.is-submit Branch .mk-kbd)` inside a 340-wide float | `.mk-kbd` keeps the button's Geist even on a `<kbd>`. |
| Branch card | `.mk-bcard > .mk-bcard-item > .mk-bcard-head(svg.mk-bcard-glyph, .mk-bcard-title, .mk-bcard-state(.is-running), svg.mk-bcard-open) + .mk-bcard-ex(.mk-bcard-who, .mk-bcard-q, .mk-bcard-who, .mk-bcard-r or .mk-bcard-typing.is-live > i×3)` | 364 wide, radius 8. Enter with `.e.e-soft` (100 in / 80 out). |
| Branch list | `.mk-blist > .mk-blist-h("Branches <span>2</span>") + .grow > div > .mk-brow(.mk-brow-glyph, .mk-brow-name, .mk-brow-meta(.mk-bstat.xf(span.is-running…Running, span…Idle), .mk-bdetails))` | Narrow-container variant of BranchAnchorRow (name 14, meta 12). Status swap: `pick` op. `Running` is the app's static amber LoaderCircle (nothing turns it), here and in branch cards. |
| Edge bookmark | `.mk-arrivals > .mk-arrival.e.e-slide(.is-working) > i.mk-dot + .mk-arrival-text(.mk-arrival-title, .mk-arrival-status) + svg` | Put `.mk-arrivals` inside the strip (`position:absolute` right edge). Status crossfade: `text` op or an `.xf` stack. |
| Mention chip | `<span class="mk-mention">@post-deploy-checks</span>` | A token in typed and streamed text (snaps in). |
| MapCard | `.mk-mslot[style=left/top] > .mk-mcard(.is-merge .is-anc .is-dim .is-source) > .mk-heat(.is-streaming) > i + .mk-asked(.mk-asked-k ASKED, .mk-asked-q) + .mk-mbody(.mk-mtitle-row(.mk-mtitle, .mk-mchev ▾), .mk-msum, .mk-mchips(.mk-mchip.is-main/.is-merged/.is-msgs, .mk-mtime, .mk-mlive(.is-live)(span.mk-mlive-dot ●)))` | 300 wide; selection outline on the slot: `.mk-mslot.is-picked`. Heat fill: `.mk-heat.is-off` -> on grows the fill over 1200 out (M3). A card rising: wrap it, `.mk-mslot > .e.e-rise > .mk-mcard` (see §5 on wrappers). Summary appearing: `.mk-msum.e`; `● streaming` -> `now`: wrap both in an `.xf` stack and `pick`. |
| Map edges | `<svg class="mk-medges"><path class="mk-medge(.is-lit .is-merge .is-flow .is-dim)" pathLength="1" d="…"/></svg>` | Branch 1.4 fg 25 %; lit 1.8 violet; merge mauve `6 4` .65; flow `5 9` moving; dim × .3. Draws: add `.draw` (§5) on a solid copy or mask. |
| Map bar | `.mk-mapbar.e.e-lift > .mk-mapbar-n + .mk-mapbar-k SELECTED + .mk-mapbar-dot · + .mk-mapbar-names + .mk-mapbar-btn ×4` | Absolute bottom 14, left/right 16. |
| Home | `.mk-home > p.mk-home-h(.mk-home-mark "_ ") + .mk-composer.is-home` | Headline 28/1.3 500; composer 560, 2 rows; workspace chip `.mk-tchip.is-ws` first in the toolbar. Visitor caret: `<i class="mk-caret">` + `fx-blink3`. |

Helpers: `.mk-chev`, `.mk-check`, `.mk-spin` (10 px card spinner), `.mk-dot`, `.mk-caret`. The Map band draws its own dot field (55-map.css, 20 px as pages/Map.tsx).

### 4.1 Icons (paste as-is; `class="i"`, colour from `currentColor`)

Lucide (viewBox 24). Stroke widths are the app's: rail 1.5, header/top row 1.75, composer 2.4 (= 1.6 px at 16),
selection bar 1.8, BranchIcon 2.4, status and arrows 2.

```html
<!-- BranchIcon (lucide Split rotated 90°): 18 in branch rows, 16 in the composer, 13 in cards -->
<svg class="i i-r90" width="18" height="18" viewBox="0 0 24 24" stroke-width="2.4"><path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"/><path d="m15 9 6-6"/></svg>
<!-- Selection bar (12 px by CSS): Branch = the same Split paths unrotated, stroke-width 1.8; Comment; Quote -->
<svg class="i" viewBox="0 0 24 24" stroke-width="1.8"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
<svg class="i" viewBox="0 0 24 24" stroke-width="1.8"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>
<!-- Area rail, 17: MessageSquare, Layers, Clock, Settings (stroke-width 1.5) -->
<svg class="i" width="17" height="17" viewBox="0 0 24 24" stroke-width="1.5"><path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/></svg>
<svg class="i" width="17" height="17" viewBox="0 0 24 24" stroke-width="1.5"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/></svg>
<svg class="i" width="17" height="17" viewBox="0 0 24 24" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
<svg class="i" width="17" height="17" viewBox="0 0 24 24" stroke-width="1.5"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/></svg>
<!-- Top row, 15 (stroke-width 1.75): PanelLeft, Plus (app glyph, viewBox 16), Search -->
<svg class="i" width="15" height="15" viewBox="0 0 24 24" stroke-width="1.75"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>
<svg class="i" width="15" height="15" viewBox="0 0 16 16" stroke-width="1.6"><path d="M8 3v10M3 8h10"/></svg>
<svg class="i" width="15" height="15" viewBox="0 0 24 24" stroke-width="1.75"><path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/></svg>
<!-- Composer toolbar, 16 (stroke-width 2.4 = 1.6 px): Plus, AtSign -->
<svg class="i" width="16" height="16" viewBox="0 0 24 24" stroke-width="2.4"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
<svg class="i" width="16" height="16" viewBox="0 0 24 24" stroke-width="2.4"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/></svg>
<!-- Branch status 13 (stroke-width 2): LoaderCircle (static: the app never turns it), Circle; card open: ArrowUpRight 13 -->
<svg class="i" width="13" height="13" viewBox="0 0 24 24" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
<svg class="i" width="13" height="13" viewBox="0 0 24 24" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>
<svg class="i mk-bcard-open" width="13" height="13" viewBox="0 0 24 24" stroke-width="2"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>
```

App glyphs (not lucide):

```html
<!-- Card agent icons, 13, viewBox 14, stroke-width 1.2: sparkle (thought), read (file), grep (search), edit, bash (>_ group) -->
<svg class="i" width="13" height="13" viewBox="0 0 14 14" stroke-width="1.2"><path d="M7 1.6L8.3 5.7 12.4 7 8.3 8.3 7 12.4 5.7 8.3 1.6 7 5.7 5.7z"/></svg>
<svg class="i" width="13" height="13" viewBox="0 0 14 14" stroke-width="1.2"><path d="M3.5 1.5h4.6l2.4 2.4v8.6h-7z"/><path d="M8 1.5v2.6h2.5"/></svg>
<svg class="i" width="13" height="13" viewBox="0 0 14 14" stroke-width="1.2"><circle cx="6" cy="6" r="3.6"/><path d="M8.8 8.8l3 3"/></svg>
<svg class="i" width="13" height="13" viewBox="0 0 14 14" stroke-width="1.2"><path d="M9.6 2.2l2.2 2.2-7.4 7.4-2.9.7.7-2.9z"/></svg>
<svg class="i" width="13" height="13" viewBox="0 0 14 14" stroke-width="1.2"><path d="M2.5 4l3 3-3 3"/><path d="M7.5 10.5h4"/></svg>
<!-- Done check, 10 -->
<svg class="mk-check" width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2.5 7.5l3 3 6-6.5"/></svg>
<!-- icons.tsx (viewBox 16, stroke-width 1.6): Home 15, Workspaces 15, Shield 14, Folder 12, ChevronRight 12 (bookmark; add i-r90 for the model chevron) -->
<svg class="i" width="15" height="15" viewBox="0 0 16 16" stroke-width="1.6"><path d="M2.5 8 L8 3 L13.5 8"/><path d="M4 7.4 V13 H12 V7.4"/><path d="M6.8 13 V9.8 H9.2 V13"/></svg>
<svg class="i" width="15" height="15" viewBox="0 0 16 16" stroke-width="1.6"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/></svg>
<svg class="i" width="14" height="14" viewBox="0 0 16 16" stroke-width="1.6"><path d="M8 1.8l5 2v4.1c0 3-2.1 5.1-5 6.3-2.9-1.2-5-3.3-5-6.3V3.8z"/><path d="M5.8 8.1l1.6 1.6 3-3.1"/></svg>
<svg class="i" width="12" height="12" viewBox="0 0 16 16" stroke-width="1.6"><path d="M2 4.5a1 1 0 0 1 1-1h3.2a1 1 0 0 1 .7.3l1 1a1 1 0 0 0 .7.3H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5Z"/></svg>
<svg class="i" width="12" height="12" viewBox="0 0 16 16" stroke-width="1.6"><path d="M6 3l5 5-5 5"/></svg>
<!-- Send plate glyphs, 14, viewBox 16: arrow (stroke 1.8), stop (filled) -->
<svg class="i when-send" width="14" height="14" viewBox="0 0 16 16" stroke-width="1.8"><path d="M8 13V3"/><path d="M3.5 7.5L8 3l4.5 4.5"/></svg>
<svg class="i fill when-stop" width="14" height="14" viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg>
<!-- Pane view cluster (Topbar.tsx, icons.tsx; 14, viewBox 16, stroke-width 1.6; faint): "+" text button, Overview (BranchesIcon), Map, Digest, Artifacts, then the ⋯ fold (lucide Ellipsis, 18, fill) -->
<span class="mk-head-icons"><span class="mk-hplus">+</span><svg class="i" width="14" height="14" viewBox="0 0 16 16" stroke-width="1.6"><path d="M4 3.5V12.5"/><path d="M7 4h5M7 8h4M7 12h5"/><circle cx="4" cy="4" r="1.2" fill="currentColor" stroke="none"/><circle cx="4" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.2" fill="currentColor" stroke="none"/></svg><svg class="i" width="14" height="14" viewBox="0 0 16 16" stroke-width="1.6"><circle cx="8" cy="3.4" r="1.5"/><circle cx="4" cy="12.6" r="1.5"/><circle cx="12" cy="12.6" r="1.5"/><path d="M8 4.9V7.4"/><path d="M8 7.4H4V11.1"/><path d="M8 7.4H12V11.1"/></svg><svg class="i" width="14" height="14" viewBox="0 0 16 16" stroke-width="1.6"><path d="M4 2.5h5.4l2.6 2.6v8.4H4z"/><path d="M9.4 2.5v2.6h2.6"/><path d="M6 8.2h4M6 10.4h2.6"/></svg><svg class="i" width="14" height="14" viewBox="0 0 16 16" stroke-width="1.6"><path d="M8 2l6 3-6 3-6-3 6-3z"/><path d="M2 8l6 3 6-3"/><path d="M2 11l6 3 6-3"/></svg><span class="mk-hmore"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg></span></span>
<!-- Composer branch action: BranchIcon at 16, before the send -->
<span class="mk-tbranch"><svg class="i i-r90" width="16" height="16" viewBox="0 0 24 24" stroke-width="2.4"><path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"/><path d="m15 9 6-6"/></svg></span>
```

---

## 5. Motion classes (31-kit-motion.css)

| Class | `.is-off` state | In / out |
|---|---|---|
| `.e` (fade) + `.e-up` | translate 0 4 | 180 out / 110 out (thought and tool rows) |
| `.e-up6` | translate 0 6 | user bubble |
| `.e-pop` | scale .96 | chips, popovers |
| `.e-slide` | translate 100 % 0 | 260 / 110 (edge bookmark) |
| `.e-lift` | translate 0 12 | 220 pane / 110 (Map bar) |
| `.e-rise` | translate 0 10 + scale .97 | 600 / 110 (Map cards) |
| `.e-soft` | (with any shape) | 100 / 80 (branch and footnote cards) |
| `.e-scene` | translate 16 0 | 180 in from +60; out 110 opacity only (`swap` op) |
| `.grow` (one child) | `grid-template-rows: 0fr` | 180 out / 160 pane |
| `.draw` (SVG path, `pathLength="1"`) | `stroke-dashoffset: 1` | `--d-ms` (600), `--d-ease`, `--d-delay` |
| `.strike` | `background-size: 0 1.5px` | 360 out |
| `.xf` (stack) | child `.is-off`: faded, out of flow | 100 `--ease` (`--xf-ms`) |
| `.press` (+ `.mk-send`, `.mk-bcomp-btn`, `.mk-mapbar-btn`) | `.is-pressed`: translate 0 1, brightness 1.08 (the white Map bar buttons .94) | 45 down / 110 up |
| `.w` / `.c` | not `.on` = `visibility:hidden` | `.w.rv` = .28 -> 1 over 360 (stream); `.c` appears at once (typing) |

Per element: `--e-in`, `--e-out`, `--e-ease`, `--e-ease-out`, `--g-in`. Offsets use the individual `translate`/`scale`
properties, so an element's own `transform` stays free for layout. Never put `will-change` on children of a scaled
canvas.

Wrappers: `.e` sets `transition-property`, so do not put it on a kit piece that has its own transitions
(`.mk-mcard`, `.mk-mslot`, `.mk-medge`, `.mk-composer`, `.mk-hl`, `.mk-anchor`, `.mk-send`); wrap the piece in a
`div.e.e-…` instead. Pieces without transitions (`.mk-user`, `.mk-label`, `.mk-thought`, `.mk-tool`, `.mk-group`,
`.mk-float`, `.mk-bcard`, `.mk-arrival`, `.mk-mapbar`, `.mk-msum`) take `.e` directly.

Live loops (only while a state class is on; nothing loops at a hold): `.mk-pane.is-streaming` (header dot),
`.mk-dot.is-live`, `.mk-srow-rail.is-live`, `.mk-arrival.is-working`, `.mk-tool-row.is-running`, `.mk-group.is-running`,
`.mk-bcard-typing.is-live`, `.mk-mlive.is-live` (its dot blinks), `.mk-medge.is-flow`,
`.i.spin`. The op that turns a loop on must turn it off by the hold (`loop`/`cls`). Branch status glyphs never loop (the app's are static). They are
phase-locked: the op that turns a loop on calls `M.lock(el)`, which writes `--ph1/--ph14/--ph24`; the CSS uses them as
`animation-delay`. If you add a looping class yourself, use the `loop` or `cls` op (both lock) or call `M.lock(el)`.

One-shot `fx` classes (add with the `fx` op, which removes them after their length and skips them under instant):
`fx-flash` 600 (pane-entrance-bg), `fx-pulse2` 1200 (bar-pulse-once ×2), `fx-breathe` 2400 (map-breathe-b ×1),
`fx-snap` 100, `fx-invite` 1200 (two 600 ms passes to the hover wash `#ede9f5` and back, from the phrase's own fill), `fx-blink3` 3150.

---

## 6. Fitting (`--k`)

`<div class="mk-fit" data-w="1280" data-h="620" data-k-min=".85" data-k-max="1" data-fit-vh="44">`: the engine sets
`--k = min(k-max, parentContentWidth / W)`; with `data-fit-vh` also `min(that, max(k-min, (100svh - top - vh) / H))`
(the hero rule of brief §5.3); `data-k-min` is a hard floor (it may overflow: only set it where the brief requires).
ResizeObserver on the parent, plus window resize. The parent must have a definite width (block or grid cell, not
shrink-to-fit). Your CSS gives the no-JS fallback `--k` per breakpoint (brief §7.4), and must keep
`W × k <= content width` at the breakpoint's narrowest viewport or the page scrolls sideways.
`M.k(el)` reads the current k; `M.refit()` refits after you change layout.

---

## 7. Follow the tail

Without the engine a `.mk-list[data-follow]` is bottom-anchored inside `.mk-view`, so tB needs no transform. Once the
engine boots (`html[data-motion]`) every follow list is top-anchored and only transforms move it, so nothing that
grows (a row at the tail, comments in the composer) moves text in layout (CLS 0). Two layers:

- `transform` is the follow move. During a take every reveal (`stream`, `type`, `show`, `row`, `tool`, `cls`, …)
  reports its element; at most once per 300 ms of take time the list moves (`translateY(d)`, `d <= 0`, 220 ms pane
  ease) so that the **lowest** element reported since its last move (and still shown) sits 16 px above the
  composer; during play it only moves up. So a class change on an earlier line (`cls` on a question while a bubble
  enters) never pulls the list back, and step order at one timestamp does not matter.
- `translate` is the anchor. A ResizeObserver on the list and its view applies it at once (no tween) so that the
  element the list last followed stays 16 px above the composer while the list or the view resizes (a composer that
  grows, a row that grows at the tail), exactly as bottom anchoring did. The next move folds the anchor into the
  transform first, from the computed (in-flight) value, so nothing jumps.

A word or character token ends at its line box (half its leading below the glyph box), so a fitted frame matches the
CSS bottom-anchored one. `reset()` fits each list to its tA tail (the lowest visible token or token-free block);
`finish()` lands at tB. Force it with the `follow` op or `M.fitTail(list)`. While a take is idle, `tk.fit()` refits
its lists at once (boot at tB, font load, resizes, breakpoint changes) and then calls `def.onFit(tk)`. A list placed
by hand (the hero's peek at rest) calls `M.unfollow(list)` first, so the anchor stops pulling it back to its tail.

Under an instant pass (`finish`, `settle`, reduced-motion cuts, `M.run` under reduced motion or `instant`) the list
jumps to the lowest element reported in that pass, even when that moves it down. That is the right tail as long as
every op that reveals something in the list reports it. An op that changes an element inside a `[data-follow]`
list without revealing it, and must not scroll the thread (the hero's underline on an earlier phrase), should be a
custom op that does not call `c.tail` (all of `show`, `cls`, `row`, `tool`, `group`, `stream`, `type`, `chip`
report).

---

## 8. Defining a take

```js
{
  M.take({
    name: 'verbs',                // = data-take; also the key for data-take-for / data-live-for
    root: '#how .how-fig',        // optional (default: [data-take="verbs"])
    seed: 11,                     // rng seed (jitter in type/stream is deterministic)
    steps: [                      // or (tk) => [...] to branch on M.bp() / composition
      [0, 'show', '.r1-scene'],
      [150, 'type', '.r1-in', { rate: 22, jitter: 6, space: 16 }],
      [1450, 'press', '.mk-send'],
      [1450, 'clear', '.r1-in'],
      [1450, 'show', '.r1-bubble'],
      [1700, 'group', '.r1-group', 'run'],
      [2100, 'group', '.r1-group', 'done'],
      [2200, 'stream', '.r1-lead', { rate: 45, until: 2650 }],
      [2750, 'row', '.r1-branches .grow', 'in', { stagger: 90 }],
      [2900, 'show', '.r1-bm', { stagger: 120 }],
      [14800, 'hold'],
    ],
    reset(tk, c) { /* tA work data-ta cannot express; c.instant is true */ },
    onStart(tk) {}, onHold(tk) {}, onFit(tk) {},
    // observe, autoplay:false, canAutoplay(tk), session, hero, scrollGuard(tk), cutMerge, catchUp, settle(tk, c)
  });
}
```

| Option | Use |
|---|---|
| `name` (required) | Unique. Planned names: `hero`, `why`, `inherit`, `verbs`, `map`, `recall`. |
| `steps` | `[atMs, op, ...args]`; `op` is a registered name or a function `(c, ...args)`. Times are take ms. A `[t, 'hold']` step marks the hold (later steps form a coda); without one the take holds after its last step. |
| `reset(tk, c)` / `settle(tk, c)` | Extra tA work after the engine's restore; custom instant tB (default: replay every step instantly). |
| `observe` | Selector/element for gating (default `[data-take-observe]` or the root). |
| `autoplay: false` | Starts at tB; Replay plays it. `canAutoplay(tk)` adds a condition. |
| `hero: true` | The boot hand-over of §3 (only the hero). `session: 'michi:hero'` sets that key when it starts. |
| `scrollGuard(tk)` | Return `{ px: 120, beforeMs: 2760 }` (wide/medium) or `null` (compact): a scroll of more than px before beforeMs finishes the take. |
| `catchUp` | Boot autoplay skips ahead by the time since first paint, capped at this many ms (hero: 600), so the take stays in step with CSS that started at first paint. |
| `cutMerge` | Reduced-motion cuts: steps closer than this (240) share a cut. |
| `onFit(tk)` | Runs after the engine refits an idle take's lists (boot at tB, fonts, resizes, breakpoints), for state the tail fit does not cover (the hero's peek at rest). |

Take object: `tk.play()`, `pause()`, `resume()`, `finish()`, `restart()`, `replay()` (steps under reduced motion),
`playSteps()`, `reset()`, `settle()`, `fit()` (idle lists to their tails, then `onFit`), `busy()`, `info()`, `q(sel)` (throws if missing), `qa(sel)`; fields `name`,
`root`, `state`, `mode`, `t`, `vis`, `holds`, `played`, `errors`. Global: `M.get(name)`, `M.replay(name)`,
`M.finish(name)`, `M.mostVisible()`, `M.list`, `M.reduced`, `M.bp()` (`desktop|laptop|tablet|phone`), `M.touch()`,
`M.mq(q)`, `M.on(evt, fn)` (`boot`, `start`, `hold`, `reduced`, `bp`), `M.onBoot(fn)`.

### 8.1 Built-in ops (05-ops.js)

`target` is a selector inside the take root, an element or a list. Options in `{}` are optional.

| Op | Args | Does |
|---|---|---|
| `show` / `enter` | `target, {ms, stagger}` | Remove `.is-off` (enter tween of its motion class). |
| `hide` / `exit` | `target, {ms, stagger}` | Add `.is-off` (exit tween). |
| `cls` | `target, '+a -b ~c', {stagger}` | Add / remove / toggle classes (adding locks the phase). |
| `loop` | `target, cls, on = true` | A live-state class (`is-streaming`, `is-live`, `is-working`), phase-locked. |
| `css` | `target, prop, value` | Inline property or custom property (`null` removes). Undone by reset. |
| `attr` | `target, name, value` | Attribute (`null` removes). Undone by reset. |
| `text` | `target, text, {ms: 100}` | Label text with a crossfade. Plain labels only. |
| `pick` | `stack, index` | In a stack of children (`.xf`), show child `index`, hide the rest. |
| `type` | `target, {rate 26, jitter 6, space 20, stop 90, comma 50, chip 220, for, until, caret, keepCaret}` | Reveal `.c` characters; caret follows (removed after typing unless `keepCaret`); chips snap in. `for`/`until` scale the timing to fit. |
| `clear` | `input, {caret}` | Empty an input (send). `{caret: false}` drops the caret too. |
| `stream` | `target, {rate 62, jitter 10, sentence 90, for, until}` | Reveal `.w` words, .28 -> 1 each. |
| `press` | `target, {down: 45}` | `.is-pressed` for `down` ms. |
| `tool` | `target, 'run'|'done'` | Tool card/row state (enters if off). |
| `group` | `target, 'run'|'done'` | Tool group state (enters if off). |
| `row` | `target, 'in'|'out', {stagger}` | Grow rows. |
| `chip` | `target` | A chip snaps in. |
| `strike` | `target` | Draw the strike. |
| `fx` | `target, cls, ms` | One-shot class. |
| `swap` | `out, in, {inAt: 60}` | Scene swap in a frame that never fades. |
| `follow` | `list, tail?` | Move a follow list to an element (or its tail) now. |
| `call` | `fn, ...args` | Run `fn(c, ...args)`. |
| `hold` | — | The hold point. |

### 8.2 Writing your own op

```js
{
  // [t, 'outline', '.mk-mslot.trr', true]
  M.op('outline', (c, target, on) => {
    for (const el of c.qa(target)) el.classList.toggle('is-picked', on !== false);
  });
}
```

`c` = `{ take, root, t (this step's time), instant, rng, q(sel), qa(sel), at(ms, fnOrOp, ...args),
after(ms, fnOrOp, ...args), op(name, ...args), tail(el) }`.
- Toggle classes and let CSS tween. Under `c.instant` (finish, reset, settle, reduced-motion cuts) apply the end
  state: skip one-shot effects, never schedule work that only matters visually.
- Schedule follow-ups with `c.at` / `c.after` (take time: they pause, finish and reset with the take). Never use
  `setTimeout` or your own rAF inside a take.
- Report revealed elements in a follow list with `c.tail(el)`.
- If you rewrite an element's markup, call `M.touchHTML(c.take, el)` first. Mark nodes you create with `data-rt`.
- Read layout sparingly (one measurement per step at most); `M.k(el)` converts screen px to design px.

### 8.3 Interactive sequences: `M.run`

For visitor branches, Map clicks and other user-triggered motion outside a take's own pass:
`const r = M.run(rootEl, steps, { seed, onHold, instant, exclusive })`. Same step format and ops, same clock, no
gating or controls; under reduced motion (or `instant`) it applies at once. `r.finish()` ends it; its take's `reset()`
cancels runs inside its root, and a run is finished when its figure drops below 25 % visible.

---

## 9. Debug API and smoke test

`window.__michi` (after boot): `list()` (every take: `name, state, mode, t, end, holds, starts, played, vis, errors`),
`state(name)`, `finishAll()`, `playAll(speed = 1, timeoutMs)` (plays every take once, one at a time, gating
suspended; resolves with `list()`), `reduced()`, `bp()`. Op exceptions are caught, logged with `console.error` and
recorded in `errors`, so a broken step never stalls a take.

`node landing/src/smoke.mjs [page]` (default `index.html`): serves `landing/` on 127.0.0.1 (ephemeral port), loads the
page at 1440×900, 1280×800, 1024×768, 768×1024, 375×812 and 320×640 (touch), plays every take at 4×, scrolls through every section,
finishes all, and asserts: no console errors or page errors, no failed or cross-origin requests, every `data-take` /
`data-take-for` names a registered take, every take held with no errors, no horizontal overflow (offenders listed).
Then once with reduced motion (every take tB, Play shown, steps reach hold) and with JavaScript disabled at 1440×900,
768×1024, 375×812 and 320×640 (every section heading and every replica visible, no controls, no overflow). Prints
JSON; exits 1 on failure; `--strict` also fails on console warnings. Overflow offenders skip `body` and `html` when
looking for a clipping ancestor (their `overflow-x: clip` goes to the viewport, which clips nothing in the page).

---

## 10. Naming rules

- Kit pieces: `.mk-*` (engine only). Engine states: `.is-off`, `.is-out`, `.is-pressed`, `.is-running`,
  `.is-streaming`, `.is-live`, `.is-working`, `.is-focused`, `.on`, `.rv`, `.at`, `.has-text`, `.has-caret`,
  `.instant`, `.is-paused`, `.e*`, `.grow`, `.draw`, `.strike`, `.xf`, `.press`, `.fx-*`, `.w`, `.c`. Do not reuse
  these names for anything else inside a take.
- Your own classes: a section prefix (`.hero-`, `.why-`, `.inh-`, `.how-`, `.map-`, `.rec-`, `.get-`, `.fn-`,
  `.keys-`). Your ops: plain verbs from brief §5.12 (`morph`, `fork`, `bookmark`, `card`, `edge`, `rise`, `lineage`,
  `outline`, `mapbar`, `merge`, …); register each name once (`M.op` overwrites).
- One file, one block, share only through `M`.

---

## 11. Worked example: a branch pane that answers

```html
<figure data-take="demo">
  <div class="mk-fit" data-w="500" data-h="440" data-take-observe>
    <div class="mk mk-canvas" aria-hidden="true">
      <div class="mk-window"><div class="mk-strip">
        <section class="mk-pane" style="--pane-w:500px">
          <div class="mk-head"><i class="mk-dot"></i><span class="mk-head-title">Task runner role</span></div>
          <div class="mk-view"><div class="mk-list" data-follow><div class="mk-col">
            <div class="mk-user"><span class="mk-over">You · 14:07</span>Who creates the task runner role?</div>
            <div class="mk-msg">
              <div class="mk-label e e-up" data-ta="off">&gt; michi</div>
              <div class="mk-thought e e-up" data-ta="off">…sparkle… <span class="mk-thought-label">Thought for 0.4s</span><span class="mk-chev">▸</span></div>
              <div class="mk-tool e e-up" data-ta="off"><div class="mk-tool-row">…</div></div>
              <div class="mk-prose demo-a" data-stream data-ta="hide"><p><b>The bootstrap stack creates it.</b> Tokyo applies the policy before bootstrap runs, so the role doesn’t exist yet when the policy checks it.</p></div>
            </div>
          </div></div></div>
          <div class="mk-composer">…</div>
        </section>
      </div></div>
    </div>
  </div>
  <p class="sr-only">Animated example. …</p>
  <div class="take-bar">…shell chrome…</div>
</figure>
```

```js
{
  M.take({
    name: 'demo',
    seed: 4,
    steps: [
      [0, 'loop', '.mk-pane', 'is-streaming'],
      [0, 'show', '.mk-label'], [0, 'show', '.mk-thought'],
      [250, 'tool', '.mk-tool', 'run'],
      [900, 'tool', '.mk-tool', 'done'],
      [1000, 'stream', '.demo-a', { rate: 62, until: 2700 }],
      [2700, 'loop', '.mk-pane', 'is-streaming', false],
      [2800, 'hold'],
    ],
  });
}
```

Without JS that figure is the finished answer. With JS, off screen at boot it resets to tA (label, thought, tool
hidden; answer words hidden), plays once at >= 50 %, follows its tail, and holds with Replay; under reduced motion it
stays finished and its Play button replays the steps as cuts.

---

## 12. Kit values: where the app source overrides the brief's table

The app source is ground truth for replica values. These differ from brief §5.2 and follow source:

| Piece | Brief | Source (used) |
|---|---|---|
| Pane header title | 14/600 everywhere; dot `#9ca3af` idle | 13 (`--fs-lg`); 600 fg focused, 400 mid unfocused; dot faint idle, violet focused, amber pulsing (`tpulse` .4↔1 + 6 px glow) while streaming (PaneCaption.tsx, primitives.tsx) |
| User bubble padding | 9 14 10 | 9 15 10 (`.terminal-message-user`) |
| Quote chip | caption 11, quote 13/1.5 | the `.t-pre-block` recipe: caption 10 (.08em, wraps like `.t-pre-block-cap`), body 12/1.4, `expand ▾` 10 (QuoteChip.tsx) |
| Thought row | padding 8 12, label 13 `#4b5563`, border `#e5e7eb` | padding 7 11, label 12/500 mid, border `--term-line` `#d1d5db`, chevron 9 faint (CardThoughtHeader) |
| Tool row | padding 8 12, title 13/600, mono 11; running = 6 px pulsing dot | card row: padding 6 11, gap 9, title 12/500 (11 in a group), mono 10, duration 10, check 10; running = violet 5 % wash, violet icon, 10 px spinner (CardToolRow) |
| Top row | breadcrumb `tokyo-rollout › Tokyo deployment` at x 296, `+ New chat` button at the right | pane captions beside open panes and the view cluster at the window's right edge; no breadcrumb or New chat (Topbar.tsx). The hero keeps its captions in the pane headers |
| Pane header icons | Plus, ListTree, Network, FileText, Layers (14, `#616876`, 22 apart) | `+` text button (mid) and BranchesIcon, Map, Digest, Artifacts (icons.tsx, viewBox 16, 1.6, faint), 26 px buttons 6 apart; `⋯` alone at 700 px and under (Topbar.tsx, ResponsiveToolbar.tsx) |
| Sidebar label | 11/500 `#7d8491` | 11/600, muted (sidebar.css `.sidebar-section-label`) |
| Assistant label | mono, faint, 6 below | `> michi` 10.5 in the message font, muted, 4 below (MessageBlock.tsx) |
| Tool group | `›_` text glyph 13, label 13; `running tools` while running | bash glyph 13 (viewBox 14), label 12/500, meta mono 10, chevron 9; the label never changes while running (collapsed `used N tools` mid, expanded `N tool calls` fg), only the glyph turns into the spinner (CardGroupHeader) |
| Working row | a `Working · 1s` row while tools run | none: the app shows no Working row while a tool runs (StreamActivityIndicator) |
| Composer | bg `#fefefe`; `›_` Geist Mono; input padding 10 12 4; toolbar 6 12 10, Geist 12; ≈ 96 tall | `#fefefe`, `#fff` focused; `›_` in Geist at message size; input min 1.5 rows; toolbar 4 10 8, chips 30 tall Geist 11/500 .04em; send 26 plate in a 30 square, empty = opacity .4 (= `#c5b7dc`); ≈ 92 tall; no context ring below 50 % usage (ContextRing.tsx); Branch action (BranchIcon 16) while the draft has text (PaneComposerActions.tsx); model chip .45 while streaming (ComposerShell.tsx, index.css) |
| Branch list | heading 14/500; name 15/500; meta 13 | heading 12/500 (count muted); container-variant rows (18 px glyph column, padding 14 12, gap 8 10); name 14, meta 12 at message size 15 (`--branch-ui-*`, BranchAnchorRow.tsx); `Running` LoaderCircle static, not spinning |
| Area rail | 32 square `#e5e7eb`, radius 4, icon `#111827`, 18 px icons at y 60/100/140 | 34 square `#d8dbe1`, radius 7, icon violet, 17 px icons stroke 1.5, gap 6 from 10 (rail.css) |
| Map ground | 22 px grid | 20 px (pages/Map.tsx) |
| Merge-source ring | ring only | ring as the brief (the app's extra 12 px glow is dropped: no glow on the page) |
| Edge bookmark dot | — | 6 px, pulsing with a 6 px glow while working (primitives.tsx Dot) |

Not in source and kept from the brief: the `YOU · hh:mm` overline (current MessageBlock shows no label; the launch
video did), the sidebar's colours and row geometry (the app's sidebar has several row styles), the top row's exact
x positions. Brief §12.1 lists these for the pre-launch check.
