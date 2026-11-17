# Tokens — Michi design details

> Scope: the tokens new Michi frontend code uses (colour roles and mix recipes, type, spacing, control and icon sizes, radius, borders, elevation, z-index, glass, opacity, and the motion token tables) and the implementation to copy. How motion uses its tokens is in motion.md; state behaviour, focus placement and hit targets are in states.md. This file holds the detail behind DESIGN.md's TK rules. Baseline: snapshot f578af740 (2026-11-13); code counts are marked "(census at f578af740)". The current-code majority wins unless it breaks a hard requirement (WCAG 2.2 Level A/AA); owner decisions win over both.
> Tags: [EK] Emil Kowalski · [RF] Rauno Freiberg · [WIG] Vercel Web Interface Guidelines · [HIG] Apple Human Interface Guidelines · [M3] Material Design 3 · [WCAG x.y.z] a WCAG 2.2 success criterion · [RUI] Refactoring UI · [LIN] Linear · [CODE] current-code majority (with its count) or a contract test or rule comment (with its file) · [OWNER] owner decision, cited by its Michi Memory ref (m:…, c:…) or the repository file that records it, with a verbatim quote and an English gloss; "recorded decision", "recorded outcome" and "recorded finding" mark a quote of the agent's record that the owner accepted, not the owner's own words. The owner's answers of 2026-11-14 to the open questions of the design docs are cited as "[OWNER] decision 2026-11-14 (XX-Qn): <English gloss of the chosen option>", where XX-Qn is the ID the asking doc gave the question; that doc's Decided questions table gives the option letter.

## Rules

Conventions. Paths are repository paths, written in full. Tests run with `npm test -w frontend -- <file>` from the repository root, with the file path relative to `frontend/`. Computed contrast figures use the palette hexes in `frontend/src/components/terminal/tokens.ts` `PALETTES` and the WCAG sRGB formula, unrounded, composited as the browser does (`color-mix(in srgb, …)` blends the encoded channels).

**Diff check `P`** means: on your branch, from the repository root, paste `P` between the heredoc markers and run the block. The first `rg` keeps only the lines your branch adds, so a top-level `|` in `P` cannot match removed lines or diff headers, and the quoted heredoc passes `'`, `"` and `$` through unchanged. It must print nothing, or only lines the rule allows.

```bash
dc() { git diff -U0 dev -- frontend/src ':!frontend/src/components/terminal/content/page/vendor-blocks' | rg -P '^\+(?!\+\+)' | rg -nP -e "$1"; }
P=$(cat <<'EOF'
<paste P here>
EOF
)
dc "$P"
```

### TK-01 Reference only tokens that exist

**Rule.**
- When you write `var(--x)`, `--x` must be defined: in `frontend/src/index.css` (`:root` and its `.terminal-shell` blocks), by `cssVarsFor()` in `frontend/src/components/terminal/tokens.ts`, by a prefs effect in `frontend/src/state/prefs.tsx` (`cornerRadiusVars`, the sidebar's `--term-sidebar-solid-alpha`, type sizes), or by the component that sets it.
- When a component offers an override hook (a custom property a caller may set), read it with a fallback and name the setter in a comment.
- When the name is a palette, type, motion or font token (the `--term-*` colours and shadows `cssVarsFor()` emits, `--ui-*`, `--fs-*`, `--ls-*`, `--t-*`, `--z-*`, `--sel-bar-*`, `--scrim-*`, `--focus-*`, `--font-*`, `--color-*`), write it bare. Never give it a literal fallback (`var(--term-danger, #a8261a)`, `var(--t-slow, 600ms)`): inside the shell the token always resolves, so the literal only hides a typo and paints a value nobody chose. The one token-to-token fallback new code writes is the hover recipe `var(--term-hover-bg, var(--term-alt))` (TK-07).
- Three kinds of name keep their fallbacks: the shell's layout hooks, which layouts set per mode (`--term-pane-*`, `--term-sidebar-*`, `--term-dashboard-*`, `--term-shell-*`, `--term-content-gap`, `--term-chrome-bg`, `--term-composer-radius`, `--term-message-radius`, `--term-topbar-zone-bg`); `:root` definitions that must work outside the shell (`--scrim-modal`); and the crash screen (`frontend/src/components/AppErrorBoundary.tsx` `CrashFallback`), which renders without the shell.
- When code sets a custom property at runtime: the system families (`--term-*`, `--ui-*`, `--fs-*`, `--ls-*`, `--t-*`, `--z-*`) change only at the shell root or `<html>`, when the palette or a pref changes. Component custom properties may be set inline from props or state, such as `--home-card-index` in `frontend/src/components/terminal/home/HomeCards.tsx` or the `--sb-*` density values that `frontend/src/components/terminal/Sidebar.tsx` computes, but never per streamed chunk or per animation frame.
- Don't build on these defined tokens, which nothing reads: `--term-topbar-bg`, `--term-topbar-border`, `--term-topbar-outline`, `--term-topbar-radius`, `--term-topbar-height`, `--term-status-bg`, `--term-status-fg`, `--term-status-radius`, `--term-rail-1`, `--term-rail-2`, `--term-rail-3` and `--term-sidebar-border`. Two names in the same family are in use: `--term-topbar-zone-bg` (read twice in `frontend/src/components/terminal/Topbar.tsx`) and `--term-topbar-paint` (written by `frontend/src/hooks/useThemeColorSync.ts`, read in `frontend/src/components/terminal/mobile.css`).

**Sources.** [LIN] "replace hardcoded visual values with shared variables for colors, typography, shadows, animation, cursors, and thin borders" · [M3] "Whenever possible, system tokens should point to reference tokens rather than static values." · [CODE] `frontend/src/components/terminal/content/captions.css.test.js`: "it is always defined, so a fallback only misleads" · [CODE] `frontend/src/components/terminal/agentBlockMotion.tsx`: "Every target here is a module constant keyed to a state (present, status kind, header mode), never to streamed content" · **Conflict:** the no-fallback rule against the hover recipe, which 52 of the 85 hover fills resolving to `alt` write with a fallback (census at f578af740). **Choice:** keep that one form. **Why:** it is the majority, and states.md ST-03/ST-06 prescribe it. Both names are palette tokens that resolve to the same `alt`, so the fallback cannot paint an unchosen colour.

**Michi today.** (census at f578af740)

| Name | References | Effect today | Defined name to use |
|---|---|---|---|
| `--term-hover` | 7 (Spaces settings, page components, native Markdown segments, meta-chat) | no fill is painted | `--term-hover-bg` |
| `--term-dim` | 1 (`frontend/src/components/terminal/content/page/pageViews.css`) | the colour inherits | `--term-faint` |
| `--term-accent-contrast` | 1 (`frontend/src/components/terminal/spaces/components/components.css`) | ink on an accent fill is inherited | `--on-accent` |
| `--mono-font` | 1 (the same file) | the whole `font` shorthand is invalid | `--font-mono` |
| `--ui-radius-md` | 1 (`frontend/src/components/RemoteAuthenticationDialog.css`) | always the 6px fallback | `--ui-radius` |
| Hooks nobody sets: `--composer-chip-weight`, `--composer-pre-blocks-max-h`, `--sb-row-meta-color`, `--term-scrollbar-border` | 1–2 each | the fallback always wins | keep only with a named setter |
| Literal fallbacks on palette, type, motion and font tokens | 75 in 17 files: 36 colours, shadows or borders, 27 font stacks (22 `ui-monospace` chains, TK-11), 11 motion values, 1 radius; 10 of them in the crash screen | they never apply inside the shell; `#e55`, `#ffd54f` and `#333` match no palette | the bare token |
| Custom properties set inline in TSX | about 120 sites | set from props or state at render | — |

Palette tokens are applied once per palette change: `cssVarsFor()` inline on `.terminal-shell`, mirrored onto `<html>` in `frontend/src/components/terminal/TerminalShell.tsx` so portals resolve them.

**Check.** In bash from the repository root. At f578af740 it prints exactly the nine names in the first six rows; any other name fails.

```bash
cd frontend/src
defined() {
  { rg -oN --no-filename -g '!**/vendor-blocks/**' -g '!*.test.*' '(--[\w-]+)\s*:' -r '$1' .
    rg -oN --no-filename -g '!**/vendor-blocks/**' -g '!*.test.*' "['\"\`](--[\w-]+)['\"\`]" -r '$1' .
  } | sort -u
}
rg -oN --no-filename -g '!**/vendor-blocks/**' -g '!*.test.*' 'var\(\s*(--[\w-]+)' -r '$1' . | sort -u \
  | comm -23 - <(defined) \
  | grep -vE '^--(tw|mantine|shiki)-|^--(width|offset-top|mobile-offset-top|michi-boot-bg|term-)$'
```

The filter drops library-owned variables (Tailwind, Mantine, Shiki, Sonner's `--width` and offsets), the boot colour set in `frontend/index.html`, and a `var(--term-*` comment in `frontend/src/components/terminal/TerminalShell.tsx`. Diff check `var\(\s*--(?!term-(pane|sidebar|dashboard|shell|content|chrome|composer-radius|message-radius|topbar-zone-bg)\b)(term|ui|fs|ls|t|z|sel-bar|scrim|focus|font|color)-[\w-]+\s*+,\s*+(?!var\()` prints nothing: each hit is a literal fallback on a token (the possessive `\s*+` stops the lookahead from passing a token fallback such as `, var(--term-alt)`).

### TK-02 Colour through `--term-*`; Tailwind only from a safe list

**Rule.**
- When you colour something in CSS or an inline style, reference a role: `var(--term-*)`, `var(--sel-bar-*)` on dark floating bars, or a named role from TK-03 to TK-09.
- When you colour with Tailwind, use only `bg-app`, `bg-surface`, `text-fg`, `text-fg-muted` (= `--term-mid`), `text-fg-subtle` (= `--term-muted`), `border-line`, or an arbitrary-variable class such as `text-(--term-mid)`.
- Never use `text-muted`, `text-secondary` or `text-sidebar` (they resolve to the `--term-alt` fill), `text-card`, `text-popover` or `text-background` (the surface), `text-primary` (accent-coloured words: write `text-(--term-accent-text)`, TK-06), or `text-danger` for words (TK-05).
- Add no new uses of the legacy aliases (`--fg*`, `--surface*`, `--line*`, `--accent*`, `--danger`, `--ok`, `--app-bg*`) or of the `@theme` names `var(--color-*)`, and no hex or rgb literal outside palette definitions.
- Fixed palettes outside the token system are standing exceptions, and you add no new one: the workspace badge palette (`frontend/src/components/terminal/workspaceAccent.ts`, the AGENTS.md exception), brand glyphs, the QR code, alpha-only masks, and the landing page's `--landing-*` set (`frontend/src/components/LandingPage.css`). That set is not fixed today: it maps onto legacy aliases of `--term-*`, and the landing page renders before TerminalShell mirrors the palette onto `<html>`, so every `--landing-*` colour resolves to nothing; give `.landing-root` the default palette through `cssVarsFor()`, not literals. Text drawn in a fixed palette still meets WCAG 1.4.3. The file-type badges leave the fixed palettes and take palette hues (TK-35). One case stays below 4.5:1 on purpose: the workspace badge's white initial on amber (3.18:1, computed) is decorative, because the workspace name sits beside it, so it keeps its look and is marked `aria-hidden` [OWNER] decision 2026-11-14 (TK-Q13): the initial is decoration, hidden from screen readers, look unchanged.

**Sources.** [CODE] `AGENTS.md`: "Use theme tokens from frontend/src/index.css and Tailwind's @theme mapping (bg-app, bg-surface, text-fg, border-line, etc.), not hardcoded surface/text hex colors." · [HIG] "don’t use the separator color as a text color, or secondary text label color as a background color." · [LIN] "the core variables and the operations we apply to them to generate our aliases for surfaces, texts, icons, and controls" · [WCAG 1.4.3] "The visual presentation of text and images of text has a contrast ratio of at least 4.5:1" · [OWNER] decision 2026-11-14 (TK-Q7): the file-type labels switch to the palette's colours and follow the palette (TK-35) · [OWNER] decision 2026-11-14 (TK-Q1): add an accent text colour that mixes a little toward the foreground until it reaches 4.5:1

**Michi today.** (census at f578af740)

| Layer | Use |
|---|---|
| `var(--term-*)` in CSS and inline styles | the system: for example `--term-muted` 982 references, `--term-line` 568; 1,581 of 2,136 colour-bearing inline style values are token-based |
| Legacy aliases (`--fg`, `--line`, `--accent` …) | 245 references: `frontend/src/components/terminal/pages/Profile.tsx` 139; `frontend/src/index.css` 83 (the `@theme` map 31, `.prose` 8, code-block and table chrome); `frontend/src/components/LandingPage.css` 11; no other file above 3 |
| `var(--color-*)` | 42 references: `frontend/src/components/terminal/spaces/pageChanges.css` 33, `frontend/src/index.css` 8, `frontend/src/components/terminal/spaces/components/components.css` 1 |
| Tailwind theme / arbitrary-variable classes | 22 / 40 uses |
| Fixed palettes | workspace badges 8 hexes plus 4 `#fff` initials; file-type badges 34 literals in 7 hexes (`frontend/src/components/terminal/manage/tokens.ts` `FILETYPE_COLOR`, whose comment says they "DO NOT enter the global token system"; they move to palette hues, TK-35); landing 7 hexes plus 5 in its art |

Copy the role names from `cssVarsFor()`. Exceptions: `text-muted` ×4 (`frontend/src/components/ExportPanel.tsx`, `frontend/src/components/SelectionActions.tsx`, `frontend/src/components/terminal/PaneMessageList.tsx`, `frontend/src/components/terminal/CrewIntegrationStatus.tsx`; 1.17–1.24:1 on surface, computed) and `text-danger` ×1 (`frontend/src/components/terminal/WorkspaceSyncNotice.tsx`); 9 component-level hex or rgba bypasses, the Lightbox media backdrop among them (documented).

**Check.** `rg -nP -g '*.tsx' -g '!*.test.*' '(?<![\w-])text-(muted|secondary|sidebar|card|popover|background|primary|danger)(?![\w-])' frontend/src` prints the five known lines and nothing else. Diff check `var\(\s*--(fg|fg-muted|fg-subtle|surface|surface-muted|surface-hover|surface-alt|line|line-strong|accent|accent-fg|accent-soft|danger|ok|app-bg|app-bg-muted)(?![\w-])|var\(\s*--color-|#[0-9a-fA-F]{3,8}\b|rgba?\(` prints nothing outside palette and token definitions. `npm run lint -w frontend` shows no new "Use a palette token" warning.

### TK-03 Surface roles

**Rule.** When you paint a background, pick its role:

| When the element is… | Use |
|---|---|
| the page canvas | `--term-bg` |
| a pane, card, popover, menu or dialog | `--term-surface` (`--term-pane-bg` on pane shells) |
| a raised surface over reading text: the branch hover card; pane arrival tabs, which are pane chrome with no shadow | `--term-float-bg` |
| a hover, pressed or selected fill | TK-07 |
| a disabled primary button (states.md ST-11); the neutral file-type badge (TK-35) | `--term-alt2` |
| the recessed payload well of the agent line chrome | `--term-bg-deep` (its stated purpose; no other use) |
| code outside the Markdown layer: kbd hints, inline code in chrome, a payload or log `<pre>` in a card | `--term-alt` |
| code inside messages and other Markdown | reuse `MarkdownContent` and `.michi-code-block` (`frontend/src/index.css`); inline code takes TK-08's one chip fill, `color-mix(in srgb, currentColor 12%, transparent)`, in messages, the composer and Export too |
| a dark floating bar (the selection bar and its composer, batch bars) | `--sel-bar-bg`, with `--sel-bar-fg`, `-mid`, `-muted`, `-line`, `-hover`; its primary action `--sel-bar-action-bg` with `--sel-bar-action-fg`; quoted text inside it `--sel-bar-quote-bg` |
| the user bubble | `--term-user-bubble-bg` |
| the composer | `--term-composer-bg` / `--term-composer-bg-focus` |
| the sidebar | `--term-sidebar-bg` |
| the docked frame, where titlebar and sidebar form one surface (`.terminal-shell[data-sidebar-layout='docked']`) | `--term-chrome-bg`; inside it `--term-topbar-zone-bg` and `--term-sidebar-body-bg` are transparent |
| a card or list inside a glass panel | `--term-surface-glass` (TK-25) |
| a scrollbar thumb | the `.term-scrollbar` class, which reads `--term-scrollbar-thumb` and `--term-scrollbar-thumb-hover` |

When a dark palette needs a raised surface, it is lighter than the page, as `--term-float-bg` and `--sel-bar-bg` are; never darker.

**Sources.** [HIG] "the elevated colors are brighter, making foreground interfaces appear to advance." · [RUI] "Giving adjacent elements slightly different background colors is usually all you need to create distinction between them." · [CODE] `frontend/src/components/terminal/tokens.ts` `cssVarsFor`: "Surface of a floating card over reading text (the branch hover card), worn with --term-float-shadow" · [CODE] `frontend/src/components/terminal/paneArrivals.css`: "Pane chrome, not a floating card: square, hairline, no shadow" · [OWNER] decision 2026-11-14 (TK-Q8): every inline code chip uses the prose chip's fill, currentColor 12%

**Michi today.** `var()` references (census at f578af740):

| Token | Refs | Token | Refs |
|---|---|---|---|
| `--term-bg` (+ `--term-page-bg`) | 124 (+12) | `--term-bg-deep` | 1 |
| `--term-surface` (+ `--term-pane-bg`) | 231 (+18) | `--term-float-bg` | 3 |
| `--term-alt` (+ `--term-hover-bg`) | 240 (+79) | `--sel-bar-bg` / `--sel-bar-fg` | 8 / 22 |
| `--term-alt2` | 15 | `--sel-bar-action-bg` / `-fg` / `--sel-bar-quote-bg` | 2 / 2 / 1 |
| `--term-user-bubble-bg` | 2 | `--term-chrome-bg` / `--term-sidebar-body-bg` / `--term-topbar-zone-bg` | 2 / 3 / 2 |
| `--term-surface-glass` | 4 | `--term-scrollbar-thumb` / `-thumb-hover` | 3 / 1 |

Code fills outside the Markdown layer: `--term-alt` 6 of 15 (`.michi-doc-code`, `.michi-doc-kbd`, `.meta-set__install code`, and the `<pre>`/`<code>` of `frontend/src/components/terminal/backgroundWork/WorkflowWorkCard.tsx`, `frontend/src/components/terminal/subagents/SubagentDetail.tsx`, `frontend/src/components/terminal/workflows/WorkflowRunPane.tsx`), `--term-bg` 2, seven other values once each. Copy `PALETTES` and `cssVarsFor()` in `frontend/src/components/terminal/tokens.ts`; `LIGHT_FLOATING_COLORS` gives Slate a cool and Bone a warm dark bar. Exceptions: the Appearance preview's user bubble in `frontend/src/components/terminal/pages/Settings.css` paints `--term-alt` instead of the bubble token; `frontend/src/components/terminal/pages/Profile.tsx` redefines `--app-bg-muted` locally.

**Check.** `npm test -w frontend -- src/components/terminal/tokens.test.ts` ("gives Slate a cool floating surface and Bone a warm one"). Devtools: switch Settings › Appearance › Palette through all four palettes; in Monokai and Gruvbox a new raised surface reads lighter than `--term-bg`.

### TK-04 Text roles and their contrast floors

**Rule.** This rule owns the text tiers; states.md ST-24 points here.
- Primary text → `--term-fg`.
- Secondary text that must stay easy to read → `--term-mid`.
- Quiet text that still carries information: captions, timestamps, counts, hints, metadata and **placeholders** → `--term-muted`.
- Marks that carry no information: disabled labels, decorative glyphs (· › ▸), idle icon affordances → `--term-faint`. Never placeholders.
- On dark floating bars → `--sel-bar-fg`, `--sel-bar-mid`, `--sel-bar-muted`.
- On accent or digest fills → `--on-accent`; the `.ui-btn--primary` / Send primitive keeps its tested `--term-surface` ink.
- Danger-filled buttons (`.ui-btn--primary[data-danger='true']`, ConfirmDialog's confirm) use the primitive, `<Button variant="primary" danger>`, never a local danger fill. On Bone and Slate the primitive is the solid `--term-danger` fill with `--on-accent` ink, hovering to danger 88% → `--term-fg` (TK-08): 6.98 / 5.88:1 at rest, 7.97 / 6.87:1 on hover. On Monokai and Gruvbox, where that ink measures 3.93 / 4.29:1, it is the soft `--term-danger-f` fill with `--term-danger-text` words, 5.47 / 5.16:1, hovering to `color-mix(in srgb, var(--term-danger) 14%, var(--term-surface))`, 5.23 / 4.88:1 (computed). `cssVarsFor()` emits the fill (border too), the ink and the hover fill per palette as `--term-danger-btn-bg`, `--term-danger-btn-fg` and `--term-danger-btn-hover`, written as references to those tokens, and the primitive reads only them. Its disabled look is unchanged (states.md ST-11).
- On a status fill (`--term-*-f`), words are `--term-fg` or the hue's text form (TK-05), never `--term-muted`, which measures 4.13–4.43:1 on Bone's accent, digest, mauve and run fills (computed).
- When you introduce any other text-on-ground pair, it measures ≥4.5:1 in sRGB, unrounded. An icon or state mark that carries information measures ≥3:1.

**Sources.** [WCAG 1.4.3] "The visual presentation of text and images of text has a contrast ratio of at least 4.5:1" · [WCAG 1.4.3] (Understanding) "This success criterion applies to text in the page, including placeholder text" · [WCAG 1.4.3] (Understanding) "the computed values should not be rounded (e.g., 4.499:1 would not meet the 4.5:1 threshold)" · [WCAG 1.4.11] (Understanding) "Status icons on an application's dashboard (without associated text) have a 3:1 minimum contrast ratio." · [RUI] "Try and stick to two or three colors" · [HIG] "For custom foreground and background colors, strive for a contrast ratio of 7:1, especially in small text." · [CODE] `frontend/src/index.css` (the `--on-accent` comment): "on danger the dark palettes sit at ~4:1" · [OWNER] decision 2026-11-14 (TK-Q5): on the dark palettes the danger button switches to a light red fill with red words (5.47 / 5.16:1) · **Conflict 1:** the `TerminalTokens` doc in `frontend/src/components/terminal/tokens.ts` lists placeholders under `faint` (≥3:1), and the `.ui-input` primitive paints them faint. **Choice:** placeholders use `--term-muted`. **Why:** WCAG 1.4.3 counts placeholder text as text, and the muted tier already leads by rule count (7 of 13 placeholder rules, counting the selection bar's `--sel-bar-muted`; faint 6). The `.ui-input` primitive is the main gap. `--term-faint` measures 3.56–3.76:1 on surface in the four palettes (computed); `--term-muted` measures 5.31–5.60:1. **Conflict 2:** RUI uses two or three text colours; Michi has four. **Choice:** four. **Why:** `--term-faint` carries no information, so it is not a reading tier, and `frontend/src/components/terminal/tokens.test.ts` pins four levels, each more than 1.2× the next. Apple's 7:1 is a target, not a floor here; `fg` already clears 7:1 by test.

**Michi today.** (census at f578af740)

| Role | Token | Refs | Floor in `frontend/src/components/terminal/tokens.test.ts` (on bg, surface, alt) |
|---|---|---|---|
| primary | `--term-fg` | 708 | ≥7:1 |
| secondary | `--term-mid` | 378 | ≥4.5:1 |
| quiet information | `--term-muted` | 982 | ≥4.5:1 |
| no information | `--term-faint` | 160 | ≥3:1; each level >1.2× the next |

Placeholders: muted in `.ui-search`, `.michi-menu-search`, `.trash-search`, `.ws-phone__search`, `.layout-preferences-editor__input` and the phone `.mention-editor-placeholder`, plus `--sel-bar-muted` in the selection bar's field; faint in `.ui-input::placeholder` (`frontend/src/index.css`), `.settings-window__search`, `.ask-card-opt-other`, `.michi-ask__input`, `.michi-doc-editor__field` and `.t-pane-find-input` (`frontend/src/components/terminal/PaneFind.tsx`). Danger fills: `.ui-btn--primary[data-danger='true']` paints `--on-accent` on `--term-danger` in every palette, 3.93:1 (Monokai) and 4.29:1 (Gruvbox), and 4.29:1 on Monokai's hover fill (computed); no `--term-danger-btn-*` token exists yet, and `frontend/src/components/terminal/tokens.test.ts` reads `--on-accent` only on accent and digest fills. Copy `PALETTES` (test: "keeps every text level readable on every ground").

**Check.** `npm test -w frontend -- src/components/terminal/tokens.test.ts`, with a case that reads `--term-danger-btn-fg` on `--term-danger-btn-bg` and on `--term-danger-btn-hover` at ≥4.5:1 in all four palettes. `rg -nUP -g '*.css' -g '*.tsx' -g '!*.test.*' '::placeholder\s*\{[^}]*var\(--term-faint\)' frontend/src` lists only the six faint rules above. Devtools contrast for any new pair, and for ConfirmDialog's confirm at rest and hovered in Monokai and Gruvbox.

### TK-05 Status hues and their text variants

**Rule.**
- Running → `--term-run` (fill `--term-run-f`); never the accent.
- Waiting on the person, pinned, or a warning → the select hue: marks and fills `--term-waiting` / `--term-waiting-f` (equal to `--term-select` / `--term-select-f`); words `--term-waiting-text`. Checked and multi-selected rows in chrome lists take the select hue too: `--term-select-f` with a 2px `--term-select` bar (states.md ST-18).
- Error or destructive → glyphs, borders and fills `--term-danger` (soft fill `--term-danger-f`); words `--term-danger-text`.
- Success, ok and digests → `--term-digest` / `--term-digest-f`: Sonner's success toast, the legacy `--ok`, the ok dots.
- A finished run (workflow, agent, subagent and multi-model runs) is marked in `--term-digest` wherever it is drawn, in the transcript as on the work surfaces (Background work, Home, agent runs, Scheduled, the rail), and so are the nodes and progress segments drawn for it. The done glyph is `StateGlyph`'s `--term-digest` ✓ (`frontend/src/components/terminal/backgroundWork/workCardParts.tsx`); a segment is `SEGMENT_COLOR.completed`, `color-mix(in srgb, var(--term-digest) 82%, transparent)`; the status chip is `WORKFLOW_CHIP.completed` (`--term-digest` on `--term-digest-f`); a done word is `--term-digest`. Steps inside a turn (tool calls, thinking, plan items, line-chrome steps) keep the quiet `.term-dot-i` dot, and a done thread the `--term-digest` of `THREAD_STATE_TONE` (states.md ST-19).
- Tool calls, merges and synthesis → `--term-mauve` / `--term-mauve-f`.
- Focus, links, brand marks and the current item → `--term-accent` / `--term-accent-f` (accent words: TK-06).
- Run and mauve words sit on `--term-bg`, `--term-surface` or their own fill, never on `--term-alt`. On an alt-filled row, write the words in `--term-fg` and put the hue on the glyph: run on Gruvbox's alt measures 4.31:1, mauve on Monokai's and Gruvbox's alt 4.11:1 and 4.23:1 (computed).
- Words on a status fill (`--term-digest-f`, `--term-mauve-f`, `--term-run-f`, `--term-waiting-f`) are `--term-fg` or the hue's text form (TK-04). When you add a hue-on-its-fill pair that no test pins, add a `frontend/src/components/terminal/tokens.test.ts` case. Digest on its fill and mauve on its fill pass today at 4.91–10.58:1 (computed), but nothing tests them.
- "Not running" is a warning, not an error: no danger colour.

**Sources.** [RUI] "You’ll want multiple shades for these colors too, even though they should be used pretty sparingly throughout the UI." · [RF] "If every element made repetitive use of a strong accent color, the color would no longer feel as significant." · [WCAG 1.4.3] "The visual presentation of text and images of text has a contrast ratio of at least 4.5:1" · [CODE] `frontend/src/motion/runningIndicators.test.js`: "colours running with --term-run, not the accent a user may pick red" · [CODE] `frontend/src/dangerText.css.test.js`: "colours no new text with --term-danger, and lists no glyph that is gone" · [CODE] `frontend/src/components/terminal/tokens.test.ts`: "Running labels sit on the page and on cards; on alt it marks dots and bars." · [CODE] `frontend/src/components/terminal/backgroundWork/workCardParts.tsx` (`SEGMENT_COLOR`): "Finished work is green, the Done chip's colour" · [OWNER] decision 2026-11-14 (TK-Q6): every finished-run mark is green (`--term-digest`) · **Conflict:** the current majority writes waiting and warning words in `--term-select` (54 `color:` declarations, some on glyphs), which measures 3.18:1 on Bone and Slate surfaces (computed). **Choice:** words take `--term-waiting-text`. **Why:** WCAG 1.4.3 AA overrides the majority here (owner rule 2); `waitingTextFor()` exists for exactly this and is tested ≥4.5:1 on bg, surface, alt and its own fill.

**Michi today.** (census at f578af740)

| Hue | Marks and fills | Words | Pinned by `frontend/src/components/terminal/tokens.test.ts` |
|---|---|---|---|
| running | `--term-run` 65, `--term-run-f` 2 | `--term-run` | ≥4.5:1 on bg, surface and its fill; ≥3:1 on alt; >60 RGB units from select, digest, danger, mauve |
| waiting / select | `--term-select` 120 (54 of them `color:` declarations, some on glyphs), `--term-waiting` 9 | `--term-waiting-text` 3 | waiting text ≥4.5:1 on bg, surface, alt and its fill |
| danger | `--term-danger` 106 (16 glyph uses in 12 files, the ratchet's `KNOWN`) | `--term-danger-text` on 146 words (158 `var()` references in all) | danger text ≥4.5:1 |
| digest | `--term-digest` 109, `-f` 13 | `--term-digest` | `--on-accent` ≥4.5:1 on the digest fill; nothing on `--term-digest-f` |
| mauve | `--term-mauve` 54, `-f` 3 | `--term-mauve` | accent >60 RGB units away; nothing as text |
| accent | `--term-accent` 448, `-f` 48 | TK-06 | accent text on `accentF` ≥4.0:1 |

Copy `dangerTextFor()` and `waitingTextFor()` (`frontend/src/components/terminal/tokens.ts`) and `WORKFLOW_CHIP` in `frontend/src/components/terminal/workflows/workflowPresentation.ts` for status words on their fills. Exceptions: the Map shows streaming in the accent (`frontend/src/components/terminal/map/MapCard.tsx`, `frontend/src/components/terminal/map/MapTimeline.tsx`). Words slip past the ratchet through `var(--danger…)`, `text-danger`, `.ui-menu-item[data-danger]`, Sonner's `--error-text` (`var(--term-danger)`) and `--warning-text` (`var(--term-select)`, 3.18:1 on the light palettes), and ModalShell's `accent` prop (`frontend/src/components/ui/ConfirmDialog.tsx` passes `var(--term-danger)` for the title, TK-15).

Finished runs: the Background work drawer's `StateGlyph` and `SEGMENT_COLOR`, `WORKFLOW_CHIP`, `WORKFLOW_STATUS_COLOR`, the agent-run status maps and the multi-model card's `.n.ok` steps already draw done in `--term-digest`. Still quiet (gap): `NODE_STATUS_COLOR.completed` (`--term-muted`, `frontend/src/components/terminal/workflows/workflowPresentation.ts`), which colours the node word in `frontend/src/components/terminal/workflows/WorkflowRunPane.tsx` and the segments in `frontend/src/components/terminal/workflows/WorkflowRunCard.tsx`; `SUBAGENT_TONE_COLOR.completed` (`--term-muted`, `frontend/src/components/terminal/subagents/subagentPresentation.ts`); and the plain `.term-dot-i` done glyph of `NodeGlyph` (`frontend/src/components/terminal/workflows/WorkflowRunPane.tsx`) and `SubagentStatusGlyph` (`frontend/src/components/terminal/subagents/SubagentRoster.tsx`), so one finished node is a faint dot in the chat card and a green ✓ in the drawer. Done words in `--term-digest` measure ≥4.91:1 on bg, surface, alt, `--term-digest-f` and the run cards' grounds, and digest segments ≥4.0:1 against those cards (computed).

**Check.** `npm test -w frontend -- src/dangerText.css.test.js src/motion/runningIndicators.test.js src/components/terminal/waitingTone.css.test.js src/components/terminal/tokens.test.ts`. Diff check `(?<![-\w])color:\s*'?var\(--(term-)?(select|waiting|danger)\)|accent=\{?[^}>]*var\(--term-(danger|select)\)`: every hit colours a glyph, icon or border, not words. `rg -nP -g '!*.test.*' "completed:\s*'var\(--term-(muted|faint)\)'" frontend/src` prints nothing (at f578af740 it prints `NODE_STATUS_COLOR` and `SUBAGENT_TONE_COLOR`). Devtools: a finished workflow shows the same `--term-digest` ✓ in its chat card and in Background work.

### TK-06 Accent-coloured words

**Rule.**
- When words take the accent, colour them `var(--term-accent-text)`, on every ground and with every picked hue: links, the active label, `@` and `michi://` chips, the default ModalShell title (TK-15) and the accent file badges (TK-35). Never `var(--term-accent)` for words, and never a local accent-text mix.
- `cssVarsFor()` derives `--term-accent-text` from the resolved accent with `accentTextFor(palette, accent)` in `frontend/src/components/terminal/tokens.ts`, the way `dangerTextFor()` derives `--term-danger-text`. It is the accent itself when that already clears 4.5:1 on every ground accent words sit on: `--term-bg`, `--term-surface`, `--term-alt`, `--term-accent-f`, and the chip tint, accent 12% and 18% over bg and over surface. Otherwise it is the smallest 5% step toward `--term-fg` that clears all of them, `color-mix(in srgb, <accent> N%, <fg>)`. Like every palette token it changes only when the palette or the accent pref changes (TK-01).
- With the default accents that gives Bone N = 90% (`#a8411e`), Slate and Monokai the accent unchanged, and Gruvbox N = 70% (`#a2b5a0`). Picked hues need N down to 40% on Bone, 45% on Slate and Monokai and 35% on Gruvbox (computed), so every hue in `ACCENT_HUES` stays on offer. `--focus-ring` is derived by the same 5% steps of N, to 3:1 against bg, surface and alt (states.md ST-07, TK-28).
- The accent's marks keep `--term-accent`: fills, tints, borders, bars, rings and glyphs. The `@` and `michi://` chip keeps its owner-approved fill, accent 12% and 18% on hover (TK-08); only its words take the text token.

**Sources.** [WCAG 1.4.3] "The visual presentation of text and images of text has a contrast ratio of at least 4.5:1" · [OWNER m:49v1] (in Chinese, translated: michi:// chips take the accent colour; @ chips move from violet to the accent) · [OWNER] decision 2026-11-14 (TK-Q1): add an accent text colour that, where the accent falls short, mixes a little toward the foreground until it reaches 4.5:1, the way the red `--term-danger-text` works; the chips stay accent-coloured and every hue stays selectable · [CODE] `frontend/src/components/terminal/tokens.ts` `dangerTextFor`: "so there it mixes 55:45 toward the foreground (4.8:1 or better)" · [CODE] `frontend/src/components/terminal/tokens.test.ts`: "Floor is 4.0, not AA's 4.5: Bone's rust on its chip fill sits at 4.1:1." · [OWNER] decision 2026-11-14 (ST-Q1): mix the accent toward the foreground step by step until it reaches 3:1 on all three grounds · **Conflict:** that test admits accent text at 4.0:1 on `--term-accent-f`. **Choice:** 4.5:1 on every accent-word ground. **Why:** WCAG 1.4.3 AA overrides it (owner rule 2), and the token the owner chose reaches it: Bone's rust measures 4.65:1 on its fill as `--term-accent-text`.

**Michi today.** The default accents as words (computed):

| Palette | on surface | on alt | on `--term-accent-f` | `@` chip at rest (12% tint) | `@` chip hover (18%) |
|---|---|---|---|---|---|
| Bone | 5.37 | 4.55 | 4.09 ✗ | 4.53 | 4.15 ✗ |
| Slate | 8.39 | 6.78 | 6.88 | 6.93 | 6.24 |
| Monokai | 8.31 | 7.09 | 9.21 | 6.30 | 5.47 |
| Gruvbox | 5.04 | 4.31 ✗ | 5.63 | 4.15 ✗ | 3.75 ✗ |

Picked hues as text on surface today (computed). On Bone and Slate, 6 of 11 fail: amber 3.2, mint 2.1, green 3.2, clay 4.2, cyan 1.7, pink 3.5. On Monokai and Gruvbox, 9 of 11 fail: rust 2.5, ink 1.6, moss 2.2, violet 2.1, red 1.9, clay 3.2, amber 4.3, green 4.2–4.3, pink 3.9–4.0; only mint and cyan pass. No test covers a picked hue as text. `--tw-prose-links` in `cssVarsFor()` uses the palette's default accent, not the picked one (TK-34). With `--term-accent-text`, the lowest ground is the hover chip in every palette: Bone 4.63:1 (over bg), Slate 5.71:1 (over bg), Monokai 5.48:1 and Gruvbox 4.63:1 (over surface) (computed). No `--term-accent-text` exists yet: accent words read `var(--term-accent)` (`.mention-chip`; the prose helpers' links, TK-34), among 94 CSS and 28 TS `color: var(--term-accent)` declarations that colour words and glyphs alike (census at f578af740). Copy `.mention-chip` (`frontend/src/index.css`) for the owner's chip look and `dangerTextFor()` for the derivation.

**Check.** `npm test -w frontend -- src/components/terminal/tokens.test.ts`, with a case over `PALETTES` × `ACCENT_HUES` and each default accent: `--term-accent-text` ≥4.5:1 on bg, surface, alt, `accentF` and the 12% and 18% chip tints over bg and surface. It replaces the 4.0 floor of "reads accent text on its pale accent fill". Diff check `(?<![-\w])color:\s*'?var\(--term-accent\)|text-\(--term-accent\)`: every hit colours a glyph, icon or border, not words. Diff check `--tw-prose-links'?:\s*'?var\(--term-accent\)|(?<![-\w])color:\s*'?color-mix\(in srgb, var\(--term-accent\)` prints nothing: the first is a link colour, the second a local accent-text mix (fills, such as TK-08's button hover, are not `color:`). Devtools contrast in all four palettes with a light and a dark hue picked.

### TK-07 State fills

**Rule.** When a state changes a fill, use the row for its ground:

| State | Opaque surface | Glass (sidebar card modes, Settings window) | Dark floating bar |
|---|---|---|---|
| hover on rows, menu items, buttons and chips | `var(--term-hover-bg, var(--term-alt))` (the palette `alt`) | `var(--sb-card-hover)`: fg 6%, 4% under macOS vibrancy | `var(--sel-bar-hover)` |
| hover on a clickable card | border `--term-line-s` plus `--term-composer-shadow-muted` (TK-24 level 1, states.md ST-03) | — | — |
| pressed (`:active`) | the hover fill, for rows, tabs and chips too; a ghost control (a button with no border and no resting fill: the ghost `Button`, `.t-icon-btn` with `TopbarIconButton`, an unbordered `.t-text-btn`, the ⋯ action buttons) one step darker, `color-mix(in srgb, var(--term-hover-bg, var(--term-alt)) 90%, var(--term-fg))` with `--term-fg` ink; a card whose hover is a border fills with `color-mix(in srgb, var(--term-alt) 70%, <its fill>)`; never a press scale or offset (states.md ST-06) | the hover fill | the hover fill |
| hover on fg-alpha rows (agent lines), and their press | `color-mix(in srgb, var(--term-fg) 6%, transparent)` (`--agent-line-hover`); the row presses with it, and the 10% `--agent-line-press` step goes (states.md ST-06) | same | — |
| toggled on (an icon button held in) | `color-mix(in srgb, var(--term-fg) 8%, transparent)`, hover 12% (`.t-icon-btn.is-on`) | same | — |
| selected, current and checked | states.md ST-18: current `--term-alt` with a 2px `--term-accent` bar in chrome lists, `--term-accent-f` in content views; checked `--term-select-f` with a 2px `--term-select` bar (content views `--term-accent-f`); the checked option of `Segmented`: `color-mix(in srgb, var(--term-fg) 10%, transparent)` (states.md ST-29); a selected pill tab: `--term-alt` with `--term-fg` ink and no border (states.md ST-18) | current `var(--sb-card-fill)`, checked `var(--sb-card-fill-select)` (ST-18) | — |

On rows, menu items, buttons and chips, hover changes only the fill: no shadow, no scale, no weight. Exception: the owner's `.mention-chip` adds `box-shadow: 0 0 3px` (accent 30%) on hover. Where hover paints (the pointer gate) and what it does to text: states.md ST-02 and ST-03.

**Sources.** [HIG] "consider using a hover effect that includes tint, but not scale and shadow." · [HIG] "drawing unfocused items using the standard text color and a gray background highlight" · [M3] "Hover +8% opacity / Focus +10% opacity / Press +10% opacity / Drag +16% opacity" · [RF] (Devouring Details source, ≈4.7% and ≈7% grey) "hover:bg-gray-a3 active:bg-gray-a4" · [CODE] `frontend/src/components/terminal/artifacts/ArtifactsDrawer.css`: "--term-alt is the hover and press fill, as everywhere." · [OWNER m:49v1] (in Chinese, translated: the owner found the existing @ chip look good, kept with its hover) · [OWNER] decision 2026-11-14 (ST-Q2): only ghost buttons, the borderless ones, press one step darker, mixing 10% toward `--term-fg` · [OWNER] decision 2026-11-14 (ST-Q4): the selected pill tab takes the light grey `--term-alt` fill · **Conflict:** M3 and Devouring Details make pressed a stronger step than hover, and M3 keeps selected apart from hover. **Choice:** pressed reuses the hover fill, and only ghost controls press one step darker; selection fills follow states.md ST-18, the selected pill tab included. **Why:** 10 of 15 `:active` fills equal their control's hover fill (the count states.md ST-06 uses; census at f578af740), no hard requirement applies, on touch `:active` already shows on its own, and the owner chose the ghost step and the pill tab's fill (ST-Q2, ST-Q4).

**Michi today.** Evidence (census at f578af740):

| Purpose | Majority | Other recipes |
|---|---|---|
| hover (178 declarations) | 85 resolve to `alt`: 52 as `var(--term-hover-bg, var(--term-alt))`, 27 as `var(--term-alt)`, 4 as bare `var(--term-hover-bg)` | fg 4–12% ×13, accent tints ×6, undefined `--term-hover` ×5, `--sel-bar-hover` ×7, `--sb-card-hover` ×3, about 15 more |
| selected (the split states.md ST-18 follows) | tie: `--term-alt` 15 (chrome lists) and `--term-accent-f` 15 (content views) | accent 14% ×2 (manage lists), `--sb-card-fill` |
| multi-selected (states.md ST-18) | `--term-select-f` (`frontend/src/components/terminal/ThreadRow.tsx`, `frontend/src/components/terminal/BranchRow.tsx`), `--sb-card-fill-select` (select 22%) | — |
| pressed (15 `:active` fills) | the hover fill ×10 | one step darker ×3 (`.t-icon-btn`, `.t-text-btn`, `button.agent-line`), others ×2 |

Copy the values of `.ui-btn:hover`, `.t-icon-btn` and `.ui-menu-item` (`frontend/src/index.css`); for a gated selector, copy `.t-toolbar-chip`. Exceptions: `.t-icon-btn:active` mixes 80% with 10% fg (they sum to 90%, leaving the fill 10% transparent); `--trash-hover` (fg 4%) is defined twice, in `frontend/src/components/terminal/pages/Trash.css` and `frontend/src/components/terminal/pages/Scheduled.css`; database rows hover at half strength.

**Check.** Diff check `background(-color)?:[^;]*(color-mix\(in srgb, var\(--term-(fg|alt|hover-bg|accent)\b|var\(--term-hover\))`: every hit is a row of the table (the hover-recipe base is caught too), and `var(--term-hover)` never appears.

### TK-08 Tints and mixes: one recipe per purpose

**Rule.**
- When you need a tint, use the named role first; when none fits, use the recipe in the table, written `color-mix(in srgb, A N%, B)`. When the same mix is needed in a second file, define it once as a role in `frontend/src/index.css` `:root` (or in `cssVarsFor()` if it differs per palette) instead of copying it.
- When a filled button hovers, mix its fill 88% with `--term-fg`: `color-mix(in srgb, var(--term-accent) 88%, var(--term-fg))` for accent, `color-mix(in srgb, var(--term-danger) 88%, var(--term-fg))` for danger on Bone and Slate. On Monokai and Gruvbox the danger button is a soft fill, and it hovers to `color-mix(in srgb, var(--term-danger) 14%, var(--term-surface))` (TK-04). Never `filter: brightness()`. The accent recipe overrides the primitive's black mix, because WCAG 1.4.3 requires it (owner rule 2). Gap: `.ui-btn--primary:hover` and `.t-action-btn.is-primary:hover` (`frontend/src/index.css`) still mix black.
- Shadow ink is black alpha or a `--term-fg` mix, never a palette-specific literal (TK-24).

| Purpose | Recipe for new code | Census (at f578af740) |
|---|---|---|
| accent soft fill on an opaque ground | `var(--term-accent-f)` | 48 references against about 27 ad-hoc accent mixes |
| translucent accent tint (`@` and `michi://` chips, tints on glass) | `color-mix(in srgb, var(--term-accent) 12%, transparent)`, hover 18% | 12% is the commonest accent-tint step (5 of 17) and the owner's chip |
| danger soft fill | `var(--term-danger-f)` (danger 9% → surface) | 7 references; ad-hoc mixes split 5–14% |
| status fills | `--term-select-f` / `--term-waiting-f`, `--term-digest-f`, `--term-mauve-f`, `--term-run-f` | palette fields |
| neutral resting band or raise in the flow (no shadow) | `color-mix(in srgb, var(--term-fg) 4%, transparent)`; the user bubble's `--term-user-bubble-bg` is the same 4% into the pane | 4% ×3 (`.workflow-phase-band`, `.t-pre-block-steer`, the bubble), 6% ×2, 3% ×2 on glass |
| skeleton bars | `color-mix(in srgb, var(--term-fg) 6%, transparent)` | 3 of 3 skeleton loaders (Home, Scheduled, Trash) |
| status-tinted border | `color-mix(in srgb, var(--term-<hue>) 35%, var(--term-line))` | 35% ×6 of 19 hue-into-line borders, Sonner's four status borders among them; 40% ×4; six other steps |
| softer hairline (over glass, docked frames) | `color-mix(in srgb, var(--term-line) 50%, transparent)` | 10 of 28 line mixes; 8 different alphas in use |
| user bubble | `var(--term-user-bubble-bg)` (fg 4% → pane) | — |
| text selection | `color-mix(in srgb, var(--term-accent) 26%, transparent)` (the `::selection` rule in `frontend/src/index.css`) | 1 |
| filled-button hover | accent 88% → `--term-fg`; danger 88% → `--term-fg` on Bone and Slate, danger 14% → `--term-surface` on the dark palettes' soft danger button (TK-04) | accent → fg ×5 (80–86%) plus the danger primitive, against accent → black ×1 (the primitive) and `brightness()` ×2 |
| inline code chip | `color-mix(in srgb, currentColor 12%, transparent)`, the `.prose :not(pre) > code` fill, on every surface | 12% in `.prose`, 8% in the message scope, a `--term-composer-bg` 88% → fg mix in the composer, `--term-alt` in Export |

**Sources.** [RUI] "Instead, define a fixed set of shades up front that you can choose from as you work." · [WIG] "Hue consistency. On non-neutral backgrounds, tint borders/shadows/text toward the same hue." · [WCAG 1.4.3] (Understanding) "text that is shown when a pointer is hovering over an object or when an object has keyboard focus" · [OWNER m:49v1] (in Chinese, translated: chips in the accent) · [CODE] `frontend/src/index.css` `.ui-btn--primary`: "ONE recipe for every solid accent button: the text Button and the composer's Send" · [CODE] `frontend/src/components/terminal/backgroundWork/WorkflowWorkCard.css`: "a faint foreground tint, rather than --term-alt, which marks hover and selection." · [CODE] `frontend/src/index.css` (`.prose :not(pre) > code`): "Tinted off currentColor so it works across terminal palettes." · [OWNER] decision 2026-11-14 (TK-Q8): every inline code chip uses the prose chip's fill, currentColor 12% · [OWNER] decision 2026-11-14 (TK-Q12): the paper cards drop their shadows and keep only the 1px edge · [OWNER] decision 2026-11-14 (TK-Q5): on the dark palettes the danger button switches to a light red fill with red words (5.47 / 5.16:1) · **Conflict 1:** RUI fixes the shades up front; Michi mixes at the call site (375 written mixes). **Choice:** keep palette-relative mixes, but only the recipes above, and name any mix used twice. **Why:** a mix follows all four palettes without per-theme rules. The drift RUI warns about (8 line alphas, 9 accent alphas) is what one recipe per purpose removes, and no majority value changes. **Conflict 2:** the primitive's filled-button hover, accent 88% → black, is the canonical recipe, but under its `--term-surface` ink it drops Gruvbox to 3.97:1 (5.04:1 at rest), and WCAG counts text shown on hover. **Choice:** 88% → `--term-fg`. **Why:** it measures 6.28 (Bone), 9.30 (Slate), 8.71 (Monokai) and 5.50 (Gruvbox) with the default accents (computed). It is also the shape of the danger recipe and of the written alternatives (accent → fg ×5), and it keeps the primitive's 88% step. **Conflict 3:** WIG tints shadows toward the ground's hue; most of Michi's shadow ink is neutral. **Choice:** black alpha (31 of 53 shadow inks), or a `--term-fg` mix where a card needs the ground's hue; never a hard-coded palette hex. **Why:** the 14 `--term-fg` mixes follow the palette and already meet WIG. The one palette ink hard-coded into every palette, Bone's `rgba(26,25,22,…)` on the Digest and Workspaces paper cards, goes with those shadows (TK-24); the landing page's `rgba(28,25,23,…)` is the case left.

**Michi today.** 391 mixes (373 `in srgb`, 2 `in oklab`, 16 Mantine `mix()` calls). By purpose: dividers 86, tints 59, neutral fills 57, hover 57, shadows 40, Desk scale steps 25, selected 14 (census at f578af740). Reuse the named mixes: `--term-user-bubble-bg`, `--sb-card-*`, `--term-danger-f`, `--term-scrim`, `--term-float-bg`, `--term-surface-glass`. Exceptions: primary hover in four recipes (`frontend/src/index.css` black 12%; `frontend/src/components/terminal/content/db/db.css` fg 14% and the Mantine theme fg 15%; `brightness()` in `frontend/src/components/SelectionActions.tsx` `.sel-actions-term-submit` and `frontend/src/components/terminal/spaces/pageChanges.css`); the Bone-ink shadows of the paper cards in `frontend/src/components/terminal/pages/Digest.tsx`, `frontend/src/components/terminal/pages/Workspaces.tsx` and `frontend/src/components/terminal/pages/workspaceList.tsx`, which TK-24 removes. Inline code chips take four fills (census at f578af740): currentColor 12% in `.prose :not(pre) > code`; 8% in the message scope's `:is(.terminal-message-assistant, .terminal-message-user) .prose :not(pre) > code`; `color-mix(in srgb, var(--term-composer-bg, var(--term-bg)) 88%, var(--term-fg))` in `.mention-editor-host .ProseMirror code`, which paints the same colour as 12% fg on the composer; and `[&_code]:bg-(--term-alt)` in `PANEL_PROSE` (`frontend/src/components/ExportPanel.tsx`). The message scope's `background` and Export's `[&_code]:bg-(--term-alt)` go, so both inherit the `.prose` fill, and the composer writes the recipe itself; the chips' sizes and padding stay per surface. `--term-fg` code on the 12% chip measures ≥6.23:1 (Gruvbox, over alt) (computed).

**Check.** Diff check `color-mix\(in (?!srgb)|filter:\s*brightness|rgba?\(\s*2[68],\s*25|var\(--term-(accent|danger)\)\s*\d+%,\s*black\)`. Each new `color-mix(` line matches a row of the table. `rg -nUP -g '!*.test.*' '(?::not\(pre\) > code|\.ProseMirror code) \{[^}]*?\bbackground:\s*+(?!color-mix\(in srgb, currentColor 12%, transparent\))|\[&_code\]:bg-' frontend/src` prints nothing (at f578af740 it prints the message-scope rule, the composer rule and Export's class).

### TK-09 Scrims

**Rule.** When a surface dims what is behind it (modal, drawer, bottom sheet, narrow-window sidebar), use `--scrim-modal` or `--scrim-drawer`. Both resolve to `--term-scrim`: the palette's `fg` at 20% on light palettes, black at 42% on dark ones (outside the shell the fallback is `--term-bg` at 68%). The scrim is a sibling of a glass panel, never its ancestor. The other dims are the phone context menu's own scrim (part of its lift, transitions.md TR-09 and TR-11), a dim with no blur (motion.md MO-16), and the Lightbox's media backdrop (black 88%, documented in `frontend/src/components/terminal/Lightbox.tsx`).

**Sources.** [M3] "Scrims use the scrim color role at an opacity of 32%." · [HIG] "If the underlying content is bright, consider adding a dark dimming layer of 35% opacity." · [OWNER c:14y] (in Chinese, translated: go with the dense frost; the recorded outcome also raised the scrim fallback from 46% to 68%) · [CODE] `frontend/src/index.css` (the `--scrim-modal` comment): "is 68% so the room behind a dialog recedes" · [CODE] `frontend/src/components/terminal/tokens.test.ts`: "dims with the palette’s ink on light palettes and with black on dark ones" · [OWNER] decision 2026-11-14 (MO-Q12): make the moving phone surfaces opaque, as on the desktop, with no frosted glass · **Conflict:** M3's scrim is 32%; Apple's only published dim (35%) is for clear glass over bright content. Michi uses fg 20% on light palettes, black 42% on dark ones, and a 68% fallback. **Choice:** keep Michi's values. **Why:** the values are pinned by `frontend/src/components/terminal/tokens.test.ts` and no AA criterion applies. The owner's dense-frost choice (c:14y) set the 68% fallback and the intent that the room behind a dialog recedes.

**Michi today.** (census at f578af740)

| Dim | Value | Sites |
|---|---|---|
| `--scrim-modal` | `--term-scrim` (fallback `--term-bg` 68%) | 3 references: `.ui-scrim--modal`, ModalShell's frozen glass; BottomSheet reuses `.ui-scrim--modal` |
| `--scrim-drawer` | `= --scrim-modal` | 1: `.ui-scrim--drawer` |
| narrow-window sidebar | `rgba(0,0,0,0.32)` | `NarrowSidebarOverlay` in `frontend/src/components/terminal/Sidebar.tsx` (gap) |
| phone context menu | `--term-bg` 36% with a 9px blur | `.phone-menu-scrim` in `frontend/src/components/ui/PhoneContextMenu.css` (the dim is sanctioned; the blur goes, motion.md MO-16) |
| Lightbox media backdrop | black 88% | `frontend/src/components/terminal/Lightbox.tsx` (deliberate) |

Copy `.ui-scrim--modal` / `.ui-scrim--drawer` in `frontend/src/index.css`.

**Check.** Diff check `background(-color)?:\s*(rgba?\(0,\s*0,\s*0|color-mix\(in srgb, (black|var\(--term-bg\)))`. `npm test -w frontend -- src/components/terminal/tokens.test.ts`.

### TK-10 Type scale and the step per role

**Rule.** When you size chrome text, use only `--fs-*`: no px, no half pixels. Text inside a message scales from `--message-body-size` (with `em` steps inside `.prose`); the composer from `--composer-body-size`. Pick the step by role:

| Step | Role in new code | Census basis (at f578af740) |
|---|---|---|
| `--fs-2xs` 9px | micro captions and kind tags only (DIGEST and scope badges, PaneChooser section labels) | 50 sites; the token's stated role ("micro captions, kind tags"), which breaks the kind badges' 2/2 tie with `--fs-xs` |
| `--fs-xs` 10px | metadata, durations, timestamps, kbd hints, caps captions and eyebrows, tool payload code | 342 sites; metadata and timestamps tie 11/11 with `--fs-sm`, broken by the token's stated role; kbd 7 of 14; payload code 22 of 55 |
| `--fs-sm` 11px | field labels, chips, `Button size="sm"`, `.t-text-btn`, composer chips, overlay titles, menu secondary text, Settings group headings and key labels | 508 sites; field labels 16 of 40; chips 25 of 64 |
| `--fs-md` 12px | `.ui-btn`, `.ui-input` / `.ui-select`, descriptions and body chrome, popover heads, the answer meta line | 413 sites; 107 field call sites |
| `--fs-lg` 13px | pane caption and top-bar titles, list titles, shared menu rows (`--m-fontSize`), dialog body, Settings setting names | 191 sites; dialog body 5 of 7; pane titles 3 of 8 |
| `--fs-xl` 14px | sidebar row titles (`--sb-fs`), palette-style prompt fields (⌘K, Move thread, New workspace), Home card titles, the Home greeting's detail line and the Pages next step | 75 sites |
| `--fs-2xl` 16px | panel and section headings (Manage panel, Spaces home sections, the Pages h2), row and field text in phone sheets and menus | 25 sites |
| `--fs-3xl` 18px | empty-state, gate and sheet headlines, at 600 (TK-12); the empty-state glyph above them is a 30px line icon, not text (states.md ST-15, TK-19) | 16 sites; empty-state headlines 3 of 8, the commonest size, and the token's stated role ("empty-state and dialog headlines") |
| `--fs-4xl` 22px | page headings (Scheduled, Trash, Settings, Branches, Profile) and detail headings, Pages level-1 headings and the Spaces home lead | 11 of 24 page headings; detail headings 2 of 3 (`frontend/src/components/terminal/pages/Scheduled.css`, `frontend/src/components/terminal/pages/Trash.css`) |
| `--fs-5xl` 28px | the Home headline and the other display titles: the Pages title, the Home greeting, metric values, the area-settings title | 7 sites |
| `--fs-6xl` 36px | hero titles (Agents, Manage) | 3 sites |

When a design calls for a size between two steps, take the step for its role, normally the nearest; never a literal, and add no step to the scale. 26 and 32px display titles → `--fs-5xl` (`.michi-doc-title`, `.home-greeting__text`, `[data-native-page] .michi-doc-metric__value`, `.area-settings__title`); 20px level-1 headings and leads → `--fs-4xl` (`.michi-doc-h2[data-level='1']`, the Spaces home lead); 16.5px → `--fs-2xl` (`.michi-doc-h2`); 15px text and glyphs → `--fs-xl` (`.home-greeting__detail`, `.home-card__title`, `.michi-doc-next__text`, `.workflow-run-card__open`, `.workflow-fold__open`); 10.5px caps labels → `--fs-xs` (TK-15); 8.5px glyphs → `--fs-2xs`. Message text stays on `--message-body-size` (the stacked Settings drawer's history message), and the comfortable density's `--msg-label-size` takes `--fs-sm`, which keeps its 9/10/11px ladder. When you edit `frontend/src/index.css` `:root`, update the `--fs-*` role comments to match this table; the `--fs-5xl` comment's "empty-state glyphs" goes, because those glyphs are icons now (states.md ST-15). On phones, `html[data-phone-text]` re-maps `--fs-*` and phone drawers add a step; which phone sizes come from `--pt-*` instead is TK-33. Text fields on touch devices are ≥16px (the `@media (hover: none) and (pointer: coarse)` guard in `frontend/src/index.css`).

**Sources.** [CODE] `frontend/src/index.css` `:root`: "Every chrome font-size resolves to one of these — no half pixels." · [OWNER c:fi] (in Chinese, translated: phone small / medium / large changes the whole interface, independent of the desktop sizes) · [OWNER c:dy] (in Chinese, translated: unify Settings, small text included; the result: page title 22/600, setting name 13/500, descriptions 12, group headings 11) · [HIG] `| macOS | 13 pt | 10 pt |` (default and minimum text size) · [M3] "Material Design uses the Major Second type scale with 14 as its key base size." · [WIG] "`<input>` font size is ≥ 16px on mobile to prevent iOS Safari auto-zoom/pan on focus." · [OWNER] decision 2026-11-14 (TK-Q10): round the in-between Pages and Home sizes to the nearest step by role, 26 and 32px to 28px, 20 to 22, 16.5 to 16 and 15 to 14, instead of adding document steps · [OWNER] decision 2026-11-14 (ST-Q6): a 30 px line icon in the faint tone, as Scheduled and Trash draw it · **Conflict 1:** Apple's macOS minimum is 10pt; `--fs-2xs` is 9px. **Choice:** keep 9px, limited to its stated role. **Why:** 50 sites use it, and no AA criterion sets a minimum size; Apple's floor is platform guidance, not a hard requirement. **Conflict 2:** the `:root` comments put pane titles at `--fs-2xl`, dialog body at `--fs-xl` and menu rows at `--fs-md`; the code uses `--fs-lg` for all three. **Choice:** the code majority, as tabled, and the comments are updated. **Why:** the census in the table puts dialog body (5 of 7) and pane titles (3 of 8) at `--fs-lg`, and every shared menu row reads `--m-fontSize`, which is `--fs-lg` (`frontend/src/components/ui/Menu.css`); no hard requirement is involved. **Conflict 3:** metadata and timestamps tie 11/11 between `--fs-xs` and `--fs-sm`. **Choice:** `--fs-xs`. **Why:** the `:root` comment gives `--fs-xs` exactly this role ("metadata, durations, kbd hints"), and its other roles (kbd, payload code) are majorities at xs.

**Michi today.** 1,997 font-size sites: tokens 1,645 (82%), keyword resets 167, literal px 87 (8 of them half pixels: 8.5, 10.5 and 16.5px), component variables 63 (census at f578af740). Twenty of the literals sit between steps or on half pixels, several with a comment that the scale has none there (`.home-greeting__text`: "No --fs token sits between 22 and 28"): 26px ×3, 32px ×1, 20px ×2, 15px ×6, 10.5px ×5 (the comfortable `--msg-label-size` and four caps labels), 16.5px ×1 and 8.5px ×2 (the multi-model glyphs). They sit in `frontend/src/components/terminal/home/homeCards.css`, `frontend/src/components/terminal/content/page/michiPage.css`, `frontend/src/components/terminal/spaces/nativeBlocks.css`, `frontend/src/components/terminal/spaces/home/home.css`, `frontend/src/components/terminal/spaces/spaces.css`, `frontend/src/components/terminal/rail/rail.css`, `frontend/src/components/terminal/workflows/WorkflowRunCard.css`, `frontend/src/components/terminal/pages/settings/history.css`, `frontend/src/components/terminal/multiModel/MultiModelRunCard.css` and `frontend/src/index.css`, and skip the phone text-size presets, which re-map only `--fs-*` (TK-33). Copy the `--fs-*` block in `frontend/src/index.css` `:root` and `--m-fontSize` in `frontend/src/components/ui/Menu.css`. Exceptions: literal-heavy `frontend/src/components/terminal/spaces/pageChanges.css`, `frontend/src/components/terminal/spaces/components/components.css` and `frontend/src/components/terminal/content/page/michiPage.css`; Tailwind `text-xs` / `text-sm` ×6, which resolve to Tailwind's own 12/14px; the settings history detail heading at `--fs-3xl`.

**Check.** `npm run lint -w frontend` (an inline `fontSize` number warns). Diff check `(?<![-\w])font(-size)?:[^;{]*\b\d+(\.\d+)?px` (the `max(16px, …)` touch guard excepted). `rg -nP -g '*.css' -g '!**/vendor-blocks/**' -g '!*.test.*' -e '(?<![-\w])(font-size|font):[^;{]*?(?<![\d.])(26|32|20|16\.5|15|10\.5|8\.5)px(?!\))' -e '--msg-label-size:\s*10\.5px' frontend/src` prints nothing (at f578af740 it prints those 20 sites). `npm run test:e2e -- e2e/specs/phone-drawer-type.spec.ts`.

### TK-11 Font families

**Rule.**
- When you set a family on chrome, use `var(--ui-font)` or inherit it. For code, IDs, paths, commands and aligned numbers, use `var(--font-mono)`. Inside messages, the body uses `var(--message-latin-font), var(--message-cjk-font)` and code uses `var(--message-code-font)`.
- Never write a literal stack or a `ui-monospace` fallback chain, never `--mono-font` (undefined), and don't introduce serif chrome (`--font-serif` has no use).
- When you use the `font` shorthand, state weight, size, line-height and family together (`font: 400 var(--fs-xs)/1 var(--font-mono)`), or set the longhands. Never the two-value form `font: var(--fs-sm) var(--ui-font)`: it resets `font-weight` to 400 and `line-height` to `normal` unless both are restated. `font: inherit` is fine.

**Sources.** [CODE] `frontend/src/state/prefs.tsx` (the `uiFont` effect): "Mono is used by code blocks, tool calls, tabular numbers — Geist pairs with Geist Mono; the others fall back to IBM Plex Mono." · [CODE] census: `var(--font-mono)` at 237 sites, a stack of its own (census at f578af740) · [WIG] "Tabular numbers for comparisons. Use `font-variant-numeric: tabular-nums` or a monospace like Geist Mono."

**Michi today.** (census at f578af740)

| Family | Sites |
|---|---|
| `var(--ui-font)` | 386 |
| `var(--font-mono)` | 237 |
| `inherit` | 172 |
| `var(--message-code-font)` | 33 (+3 with a `monospace` fallback) |
| `var(--font-mono, ui-monospace, monospace)` | 22 (`frontend/src/components/terminal/pages/Digest.tsx` 15, `frontend/src/components/terminal/pages/Workspaces.tsx` 6) |
| message fonts | 19 |
| `--landing-ui` / `--landing-serif` | 12 / 3, landing page only |
| two-value `font` shorthands (size and family only) | 18, 7 of them in `frontend/src/components/terminal/MessageBlock.tsx` |

The Interface font pref (Geist, IBM Plex Sans, Inter) writes `--ui-font` and `--font-mono` (Geist → Geist Mono, the others → IBM Plex Mono); the Message font pref (Geist, Source Serif 4) writes the message variables (`frontend/src/state/prefs.tsx`). The two-font comment in `frontend/src/index.css`, which says Tailwind's `--font-mono` inherits from `--ui-font`, is stale and should be updated. Exceptions: the xterm stack in `frontend/src/components/RemoteAuthenticationTerminal.tsx` (xterm needs a literal) and the phone Home serif in `frontend/src/components/terminal/mobile.css`.

**Check.** Diff check `font-family:\s*+(?!var\(|inherit)|fontFamily:\s*'(?!var\(|inherit)|--mono-font|ui-monospace|(?<![-\w])font:\s*+'?+(?:var\(--fs-[\w-]+\)|\d+(?:\.\d+)?px)\s+(?:var\(|'|")` (`@font-face` descriptors and the xterm stack aside). The possessive `\s*+` keeps the lookahead from backtracking, so `font-family: var(…)` lines don't match.

### TK-12 Font weights

**Rule.**
- 400: body text, descriptions, metadata.
- 500: emphasized chrome: menu rows, caps labels, field labels, setting names, chips.
- 600: titles and headings (gate and in-dialog headings included), the primary button, `strong` in messages.
- 700: kind badges only (DIGEST, scope and LIVE badges).
- New code uses no other value. Mono faces stop at 600 (Geist Mono and IBM Plex Mono ship 400–600).
- The deliberate in-between weights stay where they are and are reused by name: `UNREAD_TITLE_WEIGHT` (520, `frontend/src/components/terminal/UnreadDot.tsx`) with the 450 read weight of thread and branch rows (`frontend/src/components/terminal/ThreadRow.tsx`, `frontend/src/components/terminal/BranchRow.tsx`); the sidebar's `--sb-workspace-weight` (500 or 450) and `--sb-nav-weight` (500 or 400), set in `frontend/src/components/terminal/Sidebar.tsx`; message headings at 580 (for the variable Source Serif 4).
- Whether a weight may change with hover, focus or selection is states.md ST-23.

**Sources.** [RUI] "two font weights is usually enough for UI work" · [RF] "Font weights below 400 should not be used" · [HIG] "avoid Ultralight, Thin, and Light font weights, which can be difficult to see, especially when text is small." · [CODE] `frontend/src/components/terminal/UnreadDot.tsx` `UNREAD_TITLE_WEIGHT`: "Replaces the old 900, which CJK titles could not show: PingFang tops out at Semibold" · **Conflict 1:** RUI says two weights are usually enough; Michi uses three, plus 700 for kind badges. **Choice:** three, and 700 for one role. **Why:** majority (500 ×179, 600 ×172, 400 ×70 sites). Kind badges are a component role of their own: 3 of 4 use 700, and the `Tag` primitive's `strong` variant is 700. **Conflict 2:** in-dialog and gate headings use 700 in 3 of 4 (`frontend/src/components/ApiKeyGate.tsx` ×2, `frontend/src/components/FirstRunSetup.tsx`). **Choice:** new ones take 600. **Why:** a gate heading is a heading, and headings use 600 (page headings 10 of 24, empty-state headlines 3 of 8, popover heads 4 of 4). The three 700s have no primitive behind them and stay as exceptions.

**Michi today.** (census at f578af740)

| Weight | Sites | Renders as (Geist / Geist Mono) |
|---|---|---|
| 400 | 70 | 400 / 400 |
| 420, 450 | 2, 7 | 500 / 500 |
| 500 | 179 | 500 / 500 |
| 520 (`UNREAD_TITLE_WEIGHT`), 550, 580 | a constant, 2, 1 | 600 / 600 |
| 600 | 172 | 600 / 600 |
| 650 | 3 | 700 / 600 |
| 700 | 38 | 700 / 600 |
| `inherit` | 156 | — |

Small groups: kind badges 700 in 3 of 4 (the DIGEST badge in `frontend/src/components/terminal/PaneCaption.tsx`, the DIGEST label in `frontend/src/components/terminal/DigestPane.tsx`, LIVE in `frontend/src/components/terminal/pages/Workspaces.tsx`; `ScopeBadge` in `frontend/src/components/terminal/agents/AgentLibraryPage.tsx` sets none). Gate and in-dialog headings 700 in 3 of 4 (600 in `frontend/src/components/terminal/agents/AgentDefinitionForm.tsx`). Shipped faces (`frontend/src/fonts.css`): Geist, Inter and IBM Plex Sans 400–700; Geist Mono and IBM Plex Mono 400–600; Source Serif 4 variable 200–900; the CJK alias bands make 450–549 one Medium face. Exceptions: 650 in `frontend/src/components/terminal/spaces/home/home.css` and `frontend/src/components/terminal/temporaryChat.css`; 420 in `frontend/src/components/terminal/pages/Branches.tsx` and `frontend/src/components/terminal/spaces/spaces.css`; 700 headings in `frontend/src/components/ApiKeyGate.tsx`, `frontend/src/components/FirstRunSetup.tsx`, `frontend/src/components/terminal/pages/Digest.tsx`, `frontend/src/components/terminal/pages/Workspaces.tsx` and `frontend/src/components/terminal/content/page/michiPage.css`.

**Check.** Diff check `font-?[wW]eight:?\s*'?(?!400|500|600|inherit|normal|var\()\d{3}`: each hit is a kind badge at 700 or one of the named in-between weights.

### TK-13 Line height per role

**Rule.**

| When the text is… | line-height |
|---|---|
| one line in a box whose height the component sets (badges, chips, kbd, `.t-text-btn`, icon labels) | 1 |
| a button label (`.ui-btn`) | 1.2 |
| a menu row or a metadata line | 1.4 (`--m-lineHeight` in menus) |
| multi-line chrome at 11–14px: descriptions, dialog body, notices, inputs, tool payloads | 1.5 |
| a heading at 16–22px | 1.3 |
| display text ≥28px | 1.15 |
| message prose | `--message-body-leading` (1.5; 1.65 in the transcript); Pages text keeps `MESSAGE_PROSE_STYLE` (`frontend/src/components/markdownProse.ts`, 1.68) |

A row that can wrap text sets `min-height`, not `height`, so a user's 1.5× line-height override fits.

**Sources.** [RUI] "narrow content can use a shorter line-height like 1.5" · [RUI] "for large headline text you might not need any extra line spacing, and a line-height of 1 is perfectly fine." · [M3] "For smaller body copy using styles like body and label, we recommend a line height ratio around 1.5 times the type size." · [WCAG 1.4.12] "Line height (line spacing) to at least 1.5 times the font size" · [HIG] `| Body | Regular | 13 | 16 | Semibold |` (macOS Body, 13/16) · [OWNER c:fi] (in Chinese, translated: the phone text sizes change the whole interface) · **Conflict 1:** macOS text styles run about 1.23–1.3 at 10–13pt; Michi's multi-line chrome majority is 1.5. **Choice:** 1.5 for multi-line chrome, 1.4 for single-line rows. **Why:** Apple's macOS styles are native text metrics. Michi's web chrome majority is 1.5 at every step from 11 to 13px (table below), which matches M3's ratio of about 1.5 for body and label and the value WCAG 1.4.12 has users override to. **Conflict 2:** badges' own majority is a 14px line-height (×5). **Choice:** 1. **Why:** a px line-height doesn't follow the owner's phone text sizes, which re-map every `--fs-*` step (TK-33), while a unitless value scales with the text. 1 is also the commonest explicit value at `--fs-xs` (×20).

**Michi today.** 669 line-height sites, 23 unitless and 7 px values, no tokens. Explicit values by step (census at f578af740):

| Step | Most common | Next |
|---|---|---|
| `--fs-xs` | 1 ×20 | 1.5 ×10 |
| `--fs-sm` | 1.5 ×28 | 1.45 ×13 |
| `--fs-md` | 1.5 ×30 | 1.55 ×15 |
| `--fs-lg` | 1.5 ×20 | 1.55 ×11 |
| `--fs-3xl` / `--fs-4xl` | 1.3 ×4 / 1.3 ×2 | 1.35, 1.4 |
| `--fs-5xl`, `--fs-6xl` | 1.15 ×3 | 1.1 ×2 |

Copy `.ui-btn` (1.2) and `.terminal-message` (`--message-body-leading`) in `frontend/src/index.css`, and `.michi-menu` (`--m-lineHeight`) in `frontend/src/components/ui/Menu.css`. Exceptions: 1.55 and 1.6 on some reading surfaces (row drawer notes 1.6, workflow results 1.55); px line-heights on badges (14px ×5).

**Check.** Diff check `(line-height|lineHeight):\s*'?(\d+px|1\.(?!(15|2|3|4|5)\b)\d+)` (the prose leadings 1.65 and 1.68 excepted).

### TK-14 Letter-spacing

**Rule.** When text is uppercase, use `--ls-caps-wide` (TK-15). When a display heading is `--fs-4xl` or larger, or is the top-bar or phone pane-switcher title, use `--ls-tight` (−0.01em). All other mixed-case text keeps 0; the composer chips keep their `--composer-chip-tracking` hook (`--ls-wide`). Never write an `em` or px tracking literal; `--ls-caps` and `--ls-wide` are not for new uppercase text.

**Sources.** [RUI] "When using all-caps, increase the letter-spacing a bit to improve legibility." · [EK] "Loosen letter-spacing on uppercase labels; tight uppercase reads cramped." · [CODE] `frontend/src/index.css` `:root`: "Tracking: tight for display text, the rest for uppercase captions." · **Conflict:** the sources' uppercase examples run 0.05em (RUI) to about 0.1em (RUI's Laravel.io heading); Michi's majority is 0.14em. **Choice:** keep `--ls-caps-wide` (0.14em). **Why:** 52 of 97 caps labels use it, the dialog title the owner likes among them; no AA criterion caps tracking (1.4.12 only requires surviving a user's override).

**Michi today.** 193 letter-spacing sites, 73% tokens (census at f578af740):

| Value | Sites |
|---|---|
| `--ls-caps-wide` (0.14em) | 55 |
| `--ls-wide` (0.04em) | 36 |
| `0` | 36 |
| `--ls-caps` (0.08em) | 30 |
| `--ls-tight` (−0.01em) | 19 |
| `em` literals (.14, −.01, −.015, −.025, −.045, .07, .06, .03) | 9 |
| `normal` / `inherit` | 3 / 2 |

Exceptions: literals on `.area-settings__kicker` and `.area-settings__title` (`frontend/src/components/terminal/rail/rail.css`), the phone Home and Settings headings (`frontend/src/components/terminal/mobile.css`, `frontend/src/components/terminal/pages/Settings.css`) and `.page-pane-tag` (`frontend/src/components/terminal/spaces/spaces.css`).

**Check.** `npm test -w frontend -- src/components/terminal/content/captions.css.test.js`; `npm run lint -w frontend` (an inline `letterSpacing` in em warns); diff check `(letter-spacing|letterSpacing):\s*'?-?\d*\.?\d+(em|px)`.

### TK-15 Caps labels: content labels and overlay titles

**Rule.**
- When a label in a content surface is uppercase (MichiSectionLabel, a section caption, an eyebrow, a group heading), write `text-transform: uppercase; letter-spacing: var(--ls-caps-wide); font-weight: 500; color: var(--term-muted)` in the UI font at `--fs-xs`; Settings group headings use `--fs-sm`. Reuse `MichiSectionLabel` (`frontend/src/components/terminal/content/MichiSectionLabel.tsx`) in content.
- When an overlay has a title, use `.ui-overlay-title` unchanged: `--fs-sm`, `--ls-caps-wide`, uppercase, inherited weight. `ModalShell` colours it with its `accent` prop: the uppercase coloured title the owner likes. The title is words, so its default colour is the accent's text form, `var(--term-accent-text)` (TK-06; today `var(--term-accent)`). Pass the colour through that prop, not a local style. `DrawerShell` keeps `--term-muted`.
- When the dialog confirms a destructive action, its title takes `--term-danger-text`, not `--term-danger`, which measures 3.62–3.95:1 on the dark palettes' surfaces (computed). Gap: `frontend/src/components/ui/ConfirmDialog.tsx` passes `var(--term-danger)`.
- Kind tags (DIGEST, scope, LIVE) use `--fs-2xs` (TK-10) at 700 (TK-12), coloured with their tone's text token (TK-05).
- A label that names a state takes that state's text token (`--term-danger-text`, `--term-waiting-text`).
- Uppercase comes from CSS, not from capitals typed into a string or a prop.

**Sources.** [RUI] "Let’s switch the font weight from regular to bold, capitalize the text, and also add a little bit of letter spacing" · [OWNER c:h2] (in Chinese, translated: the owner called the ModalShell dialog beautiful) · [OWNER c:h3] (in Chinese, translated: the owner meant the style and effect, whose the uppercase coloured title label, the record lists) · [WCAG 1.4.3] "The visual presentation of text and images of text has a contrast ratio of at least 4.5:1" · [CODE] `frontend/src/components/terminal/content/captions.css.test.js`: "sizes and spaces Michi’s caps captions with the type tokens, so a rescale of them reaches every caption" · [OWNER] decision 2026-11-14 (TK-Q1): add an accent text colour that mixes a little toward the foreground until it reaches 4.5:1; the default title takes it (TK-06) · **Conflict 1:** RUI's group headings are bold; Michi's content caps labels are 500. **Choice:** 500. **Why:** 28 of the 46 caps labels with an explicit weight use 500 (600 ×10, 700 ×6), and section captions 20 of 30. The overlay title keeps its inherited weight because that is the owner-approved look. The separate iOS mock's "no uppercase captions" rule is scoped to that mock, not the web app. **Conflict 2:** the owner likes the coloured title, and ConfirmDialog colours a destructive one `--term-danger`. **Choice:** `--term-danger-text` for that title. **Why:** WCAG 1.4.3 AA (owner rule 2). The title stays coloured, just with the readable danger tone.

**Michi today.** 97 caps labels: 80 by `text-transform`, 17 typed as capitals (census at f578af740).

| Property | Values |
|---|---|
| size | `--fs-xs` 61, `--fs-sm` 14, `--fs-2xs` 13, 10.5px 4 |
| tracking | `--ls-caps-wide` 52, `--ls-caps` 27, `--ls-wide` 12, none or literal 6 |
| weight | inherited 51, 500 28, 600 10, 700 6, 400 2 |
| family | UI (inherited or `--ui-font`) 63, mono 27, landing 2 |
| overlay title colour (ModalShell `accent`) | default `--term-accent`; ConfirmDialog `--term-danger` (or the accent when `danger: false`); MoveThreadDialog `var(--term-mauve, var(--term-accent))`; DigestPromptDialog `var(--term-digest, var(--term-accent))` |

Copy `.michi-section-label__text` (`frontend/src/components/terminal/content/michi.css`) and `.ui-overlay-title` (`frontend/src/index.css`). Exceptions: `--ls-caps` in agent forms and workflow status tags; mono caps in the Workspaces table heads and Digest; typed capitals in `frontend/src/components/terminal/manage/ChatTreeList.tsx` (`text="PINNED"`, `text="RECENT"`) and the "THREAD DIGEST" / "DIGEST" text in `frontend/src/components/terminal/pages/Digest.tsx`, `frontend/src/components/terminal/DigestPane.tsx` and `frontend/src/components/terminal/manage/DigestList.tsx`.

**Check.** `npm test -w frontend -- src/components/terminal/content/captions.css.test.js`. Diff check `text-transform:\s*uppercase|textTransform:\s*'uppercase'`: each hit uses the recipe. Diff check `>[A-Z]{3,}( [A-Z]{3,})*<|[=:]\s*['"][A-Z]{3,}( [A-Z]{3,})*['"]|^\+\s*[A-Z]{3,}( [A-Z]{3,})*\s*$` (capitals in JSX text, in a prop, or alone on a JSX line): each hit is an identifier, such as an enum value, a key name or an HTTP method, never label text. The danger title: TK-05's diff check.

### TK-16 Tabular numbers

**Rule.** When a number changes while it is visible (elapsed timers, token counts, costs, progress, unread and queue counts, rolling counters) or sits in a column or table, set `font-variant-numeric: tabular-nums` (or use `--font-mono`), and right-align numbers in columns. Numbers in prose keep proportional digits. Clocks tick in whole seconds and their digits don't animate.

**Sources.** [RF] "particularly in tables or when layout shifts are undesirable, like in timers" · [M3] "Use tabular numbers to prevent layout shifting when values change" · [WIG] "Tabular numbers for comparisons. Use `font-variant-numeric: tabular-nums` or a monospace like Geist Mono." · [HIG] "Using fixed-width digits allows you to easily align numbers of the same size in a table-like arrangement." · [CODE] `frontend/src/components/terminal/AgentLineBlocks.tsx`: "Ticks never animate: whole seconds, tabular."

**Michi today.** (census at f578af740)

| Form | Sites |
|---|---|
| `font-variant-numeric: tabular-nums` in CSS | 58 |
| the same in TS / TSX styles | 14 |
| Tailwind `tabular-nums` | 0 |

Copy the rolling digits in `frontend/src/components/terminal/agentBlockMotion.tsx` ("Tabular figures keep every place one width.") and the counts in `.settings-window__item em` (`frontend/src/components/terminal/pages/Settings.css`).

**Check.** For each changed component that renders a live or column number (`formatTokenCount`, a `useNow` clock, a count badge), devtools Computed › `font-variant-numeric` is `tabular-nums`; while the number changes, nothing beside it moves.

### TK-17 Spacing scale

**Rule.**
- When you set padding, margin, gap or inset, use a value on the scale: every even px from 2 to 24 (2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24), then multiples of 4 (28, 32, 36, 40, 44, 48, 56, 64 …). The commonest steps are 8, 6, 10, 4 and 12.
- When a density variable covers the spot, use it instead of a literal:

| Area | Variables | Defined in |
|---|---|---|
| chat pane | `--pane-pad-top`, `--pane-gutter`, `--msg-gap`, `--msg-label-gap`, `--msg-assistant-pad`, `--composer-inset`, `--user-turn-gap`, `--answer-lead` | `frontend/src/index.css` (`[data-density]`) |
| sidebar | `--sb-row-py`, `--sb-ws-gap`, `--sb-nav-py`, `--sb-inset` | `frontend/src/components/terminal/Sidebar.tsx` |
| menus | `--m-padding`, `--m-rowX`, `--m-rowY`, `--m-gap` | `frontend/src/components/ui/Menu.css` |
| Settings | `--settings-inset` | `frontend/src/components/terminal/pages/Settings.css` |
| composer | `--composer-input-padding`, `--composer-att-row-padding`, `--composer-toolbar-padding` | `frontend/src/index.css`, `frontend/src/components/terminal/mobile.css` |

- Odd px only (a) to compensate a 1px border so the outer box lands on the scale, written as `calc(<value> - 1px)` or commented; (b) as a commented ±1px optical nudge; or (c) in the two named recipes below: badges and chips.
- A row that holds wrapping text sets `min-height`, not `height`.
- Recipes the code already shares: menu rows, 6px vertical by 10px horizontal; cards, 10px by 12px; dialog bodies, 16px under the shared overlay header (10px vertical, 14px horizontal); section gaps, 18px; badges, 0–2px vertical by 5px horizontal; chips, 1px vertical by 6px horizontal (`.mention-chip`).

**Sources.** [RUI] (slide) "Use a consistent spacing scale" · [M3] "The spacing system is measured on an 8dp scale, where space100 = 8dp" · [WIG] "Optical alignment. Adjust ±1px when perception beats geometry." · [WCAG 1.4.12] "Line height (line spacing) to at least 1.5 times the font size" · [OWNER m:49v1] (in Chinese, translated: the owner found the existing `@` chip look good) · **Conflict:** M3 builds on an 8dp base with 2/4/6/10dp sub-units, RUI hand-picks 6, 12, 16, 20, 30 and 48px, and Michi uses a 2px grid. **Choice:** Michi's 2px grid up to 24px and 4px steps above, with the badge and chip recipes as named odd values. **Why:** it is what the code uses (84.6% of non-zero values sit on 2px; from 24px up, 185 of 229 occurrences are multiples of 4), and the sources agree only that the set is small and fixed. The badges' 5px horizontal padding is their majority (15 sites), and the chip's 1px by 6px is the owner's chip.

**Michi today.** 3,912 non-zero padding, margin and gap values (census at f578af740): 92.2% of CSS and 90.0% of inline spacing is literal; no spacing scale exists, and Tailwind's 4px unit appears 65 times.

| px | 8 | 6 | 10 | 4 | 12 | 2 | 14 | 16 | 18 | 20 | 24 | odd (1–23) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| uses | 650 | 486 | 420 | 392 | 352 | 232 | 222 | 148 | 88 | 63 | 51 | 600 (15.3%) |

Copy the density blocks above. Exceptions: the pane density defaults `--msg-label-gap: 3px` and `--msg-assistant-pad: 5px`; the workspace rows' 5px top fallback (`frontend/src/components/terminal/WorkspaceRow.tsx`, `frontend/src/components/terminal/WorkspaceTree.tsx`); Trash at 21px between groups.

**Check.** Diff check `(padding|margin|gap|inset)[^;]*\b(1|3|5|7|9|11|13|15|17|19|21|23)px` and, for JSX numbers, `(padding|margin|gap)\w*:\s*(1|3|5|7|9|11|13|15|17|19|21|23)\b(?![.\w])`: each hit is commented as border compensation or an optical nudge, or is one of the two named recipes. Diff check `(padding|margin|gap|inset)[^;]*\b(26|30|34|38|42|46|50)px` prints nothing.

### TK-18 Control and bar sizes

**Rule.** When you add a control, take its size from the primitive:

| Control | Size | Notes |
|---|---|---|
| text button | `<Button>` (`.ui-btn`): ≈28px from 6px 12px padding, `--fs-md`, line-height 1.2, 1px border | the default |
| small text button | `<Button size="sm">` (`.ui-btn--sm`): ≈19px from 2px 8px, `--fs-sm` | under 24px, so it keeps the clear space of states.md ST-21: 5px between two of them, 2.4px to a target of 24px or more |
| link-like text button | `.t-text-btn`: min 26px | — |
| composer controls | `.t-toolbar-chip`, `.t-action-btn`: `--composer-chip-height` 30px hit area; Send and Stop paint a 26px plate | phones: 40px hit area, 32px plate (owner-set) |
| icon-only button | TK-19 | — |
| fields | `.ui-input` / `.ui-select` ≈26px; page search `.ui-search` 36px, `.ui-search--compact` 29px; menu search `--m-searchHeight` 34px | declare no other field height |
| menu rows | the shared menu: `--m-minHeight` 38px (actions menu 32px, palette 34px) | — |
| switch | `.ui-switch` 28×16 (Settings draws 36×20) | — |
| bars | top bar `TOPBAR_HEIGHT` 44px (`frontend/src/components/terminal/Topbar.tsx`); pane caption 28px; pane tab 30px; in-pane toolbar 36px; terminal header 32px | `--term-topbar-height` (40px) has no reader; don't use it |

Hit areas are states.md ST-21, the single hit-target rule: the 24px fine-pointer minimum, touch minimums and dead gaps. On touch, the sizes this table names are the composer's owner-set 40px and the message actions' 40px (`.t-msg-actions .t-icon-btn`); every other touch target follows ST-21.

**Sources.** [WCAG 2.5.8] "The size of the target for pointer inputs is at least 24 by 24 CSS pixels, except when:" · [WCAG 2.5.8] "if a 24 CSS pixel diameter circle is centered on the bounding box of each, the circles do not intersect another target" · [WIG] "Exception: if the visual target is < 24px, expand its hit target to ≥ 24px. On mobile, the minimum size is 44px." · [HIG] `| macOS | 28x28 pt | 20x20 pt |` (default and minimum control size) · [OWNER c:5w] (recorded decision) (in Chinese, translated: the composer toolbar mock built on the owner's "C + solid plate" choice) · [OWNER c:5z] (in Chinese, translated: the owner's go-ahead; recorded outcome, in Chinese, translated: "hit areas unchanged (phone 40, desktop 30); the visible plate shrinks to 32 / 26") · [CODE] `frontend/src/index.css`: "Message actions (copy, retry, edit, branch) are 26px for a mouse; a finger needs 40." · [CODE] `frontend/src/index.css` (Send plate): "26 of 30 on desktop, 32 of 40 on a phone (mobile.css sets the inset)." · **Conflict:** `Button size="sm"` is 19.2px, under WCAG's 24 and Apple's 20pt macOS minimum. **Choice:** allowed only with states.md ST-21's clear space. **Why:** 2.5.8's spacing exception is part of AA, and that clear space keeps each 24px circle off its neighbours; 132 call sites use it, and Apple's minimum is platform guidance, not a hard requirement. Touch sizes are argued in states.md ST-21.

**Michi today.** Declared heights of 299 interactive sites (census at f578af740):

| Height | 22 | 24 | 26 | 28 | 30 | 32 | 34 | 36 | 40 | 44 | 48 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| sites | 33 | 38 | 65 | 35 | 29 | 17 | 10 | 8 | 6 | 6 | 8 |

Computed primitives: `<Button>` ≈28.4px (121 call sites), `<Button size="sm">` ≈19.2px (132), `.ui-input` ≈26px. Copy `frontend/src/components/ui/controls.tsx` (`Button`, `Switch`) and the `.ui-btn` and `.ui-input` blocks in `frontend/src/index.css`. Exceptions: 44 component targets declare a size under 24px and have not been checked against the spacing exception, among them `InfoTip` (15px), author-drawn 12–15px checkboxes and radios, and the 18px chip clears.

**Check.** Devtools on a new control: its box is ≥24×24px, or a 24px circle centred on it touches no other target. Touch: states.md ST-21's checks.

### TK-19 Icon buttons and icon sizes

**Rule.**
- When you add an icon-only button, use `.t-icon-btn` (min 26×26, `--ui-radius`) or `TopbarIconButton` in bars.
- Inside a bar or row 28px tall or less (pane caption, overlay header, sidebar rows), use the 22px control (`CONTROL_SIZE` in `frontend/src/components/terminal/PaneCaption.tsx`, `.ui-overlay-close`, `.ws-action-btn`) with `--ui-radius-sm`, on a pitch of at least 24px (a gap of 2px or more). Add no third size: the 24px boxes in database toolbars and Companion cards stay as they are, and a new icon button outside a tight bar takes 26.
- Icons are 14px (`size={14}`, the default of the local icons in `frontend/src/components/terminal/icons.tsx`, `--m-iconSize`), one size per control group. Named exceptions: the composer toolbar uses `composerIconSize()` (16px on desktop, 18px on phones) with `COMPOSER_ICON_STROKE` (1.6px) (`frontend/src/components/terminal/PaneComposerToolbarLeft.tsx`); sidebar rows use `--sb-icon-size` (15px, `WORKSPACE_ICON_SIZE`); message actions on touch use 16px; an empty state's decorative icon is 30px at stroke 1.3 (states.md ST-15).
- Top-bar icons are solid (filled) glyphs; the phone top bar's four icons (sidebar, +, ghost, Companion) share one size, `--pt-icon` (TK-33).
- Round shapes are never buttons (TK-20).

**Sources.** [OWNER c:10e] "Okay do it with 22 and commit to dev" (pane caption controls at 22px with `--ui-radius-sm`) · [OWNER m:6yv1] (in Chinese, translated: top-bar icons solid, not outline) · [OWNER m:6yv1] (in Chinese, translated: the phone top bar's four icons stay the same size) · [OWNER c:5z] (recorded outcome) (in Chinese, translated: composer icons) · [OWNER] decision 2026-11-14 (ST-Q6): a 30 px line icon in the faint tone, as Scheduled and Trash draw it · [CODE] `frontend/src/index.css` `.t-icon-btn`: "26×26 matches the Topbar toggle size." · [RF] "Icons are designed at 16×16 with a 1.5pt stroke" · [WCAG 2.5.8] "if a 24 CSS pixel diameter circle is centered on the bounding box of each, the circles do not intersect another target" · **Conflict 1:** Devouring Details draws 16px icons; Michi's majority is 14px. **Choice:** 14px, with the composer's owner-set 16/18px as a named exception. **Why:** 143 of 445 sized icon sites use 14, far ahead of 13px (81) and 12px (68). **Conflict 2:** 24×24 boxes (24 sites) outnumber 22×22 (19 sites). **Choice:** 22 inside bars 28px tall or less, 26 elsewhere. **Why:** every icon control in such a bar is 22 today: the owner chose 22 for the pane caption (c:10e), and the `.ui-overlay-close` and `.ws-action-btn` primitives already use it. The 24px boxes sit only in database toolbars and Companion cards, outside tight bars, where 26 is the majority (36 sites).

**Michi today.** (census at f578af740)

| Icon size | 11 | 12 | 13 | 14 | 15 | 16 | 18 |
|---|---|---|---|---|---|---|---|
| sites | 26 | 68 | 81 | 143 | 42 | 36 | 12 |

Icon-button boxes: 26×26 at 36 element sites, 24×24 at 24, 22×22 at 19, 20×20 at 3, 18×18 at 4; 13 sizes are in use. Copy `frontend/src/components/terminal/TopbarIconButton.tsx` and `frontend/src/components/terminal/PaneCaption.tsx` (`CONTROL_SIZE`). Exceptions: `.companion-icon-btn` and `.michi-db-icon-btn` at 24px; `.receipt-row__toggle` and `.area-side__section-btn` at 20px; `.ws-action-btn` rounds with `--ui-radius`, not `--ui-radius-sm`.

**Check.** Diff check `\bsize=\{(?!14\})\d+\}`: each hit is one of the named exceptions (`composerIconSize()` is not a literal and doesn't match). Devtools on 22px controls: neighbouring centres are ≥24px apart.

### TK-20 Corner radius tokens and roles

**Rule.** When you round a corner, take it from the Corner radius pref (Settings › Appearance › Advanced › Corner radius: 0–12px, default 4):

| Token | Value | Use |
|---|---|---|
| `--ui-radius` | r | floating surfaces (menus, modals, popovers, toasts), every button and composer control, tab pills (`.michi-db-tab`, `.area-tabs__btn`), page search fields (`.ui-search`), the docked content corner, in-flow cards and boxes (TK-22) |
| `--ui-radius-sm` | round(r / 2) | rows and controls nested in a surface (menu rows via `--m-itemRadius`), tooltips (`--ui-tooltip-radius`), inputs and selects (the `.ui-input` / `.ui-select` primitive), badges, tags, kbd, `@` chips, 22px bar controls |
| `--ui-radius-lg` | 2r | hover cards (the branch hover card, `.t-branch-card`), the raised active pane tab (`frontend/src/components/terminal/PaneTabStrip.tsx`), bottom-sheet top corners; never an in-flow card (TK-22) |
| `--ui-radius-pill` | 999px; never follows the pref | dots, rings, avatars, radios, step markers, counts, scrollbar thumbs, capsule chips; never a button |
| 0 | — | panes, bars, edge-docked drawers, the `.ui-switch` track, the "paper" cards (Map, Digest, Workspaces) |
| `--term-composer-radius` | 0 on desktop; `calc(var(--ui-radius) * 2)` on phones (`* 3` for the phone Home composer) | the composer family only: composer, workflow, multi-model and background cards, the finished-runs fold, the user bubble (its left corners), the shell notice and its tab (`.shell-notice`, `.shell-notice-tab`), the branch anchors list (`.t-branch-anchors-list`) and the interrupted-task list (`.interrupted-notice-list`) |

No literal px radius, no `50%` or `999px` literal, no Tailwind `rounded*`. Only the family rule in `frontend/src/components/terminal/mobile.css`, which `frontend/src/components/terminal/mobile.css.test.js` pins, sets `--term-composer-radius` on phones; an element that reads it outside a family element gets 0 there too, so a new member of the family joins the rule and the test.

| r (pref) | 0 | 2 | 4 (default) | 6 | 8 | 10 | 12 |
|---|---|---|---|---|---|---|---|
| `--ui-radius-sm` | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
| `--ui-radius-lg` | 0 | 4 | 8 | 12 | 16 | 20 | 24 |

**Sources.** [OWNER c:e6] (in Chinese, translated: composer, workflow cards and the user bubble: 0px on desktop, 8px on phones) · [OWNER c:2g] (in Chinese, translated: keep the composer's original, squarer design; its + and Send went back from round to 4px) · [OWNER c:108] "Should this button be more square than round?" (the round exit-zoom control became square) · [OWNER c:3y] (in Chinese, translated: the capsule Create with agent button took the Pages button's 4px corners) · [OWNER] decision 2026-11-14 (TK-Q3): in-flow cards take `--ui-radius` (4px by default), the most used card radius (TK-22) · [OWNER] decision 2026-11-14 (TK-Q4): on phones the shell notices, the branch anchors list and the interrupted-task list round together with the composer (8px by default) · [CODE] `frontend/src/index.css` `:root`: "Panes, bars and edge-docked drawers stay square — they have no free corner to round." · [CODE] `frontend/src/components/terminal/mobile.css.test.js`: "rounds every workflow card like the composer on the phone, the in-chat multi-model card included" · [CODE] `frontend/eslint.config.mjs`: "Use a radius token: 'var(--ui-radius-sm)', 'var(--ui-radius)', 'var(--ui-radius-lg)' or 'var(--ui-radius-pill)'." · [RUI] (slide) "Use a consistent corner radius" · [HIG] "in dense desktop environments, they’re best used for standout actions." (capsules) · [M3] "Be careful not to apply large or full corners to information-dense components, such as cards" · **Conflict 1:** the `50%` literal (48 sites) outnumbers `--ui-radius-pill` (41). **Choice:** the token. **Why:** on the square boxes these sites round (dots, rings, avatars) the token draws the same circle, while `50%` turns a non-square box into an ellipse; the ESLint message already names `--ui-radius-pill`. **Conflict 2:** field rules favour `--ui-radius` (11 of 24), while the `.ui-input` / `.ui-select` primitive uses `--ui-radius-sm` at 107 call sites. **Choice:** the primitive, by call site; page search fields (`.ui-search`) keep `--ui-radius`. **Why:** most fields render through the primitive (107 call sites against 24 local field rules), so following it changes the fewest shapes; the local rules are the drift. **Conflict 3:** the `:root` comment gives tab pills `-lg`, but the rounded pill-tab strips use `--ui-radius` (`.michi-db-tab`, `.area-tabs__btn`), with `-lg` only on the raised active tab of `frontend/src/components/terminal/PaneTabStrip.tsx` (the Map's tabs are square paper). **Choice:** `--ui-radius`. **Why:** it is the plurality, 2 of the 3 rounded strips, and the shape states.md ST-01 gives the canonical pill tab; update the comment when you edit `:root`.

**Michi today.** 522 radius rows (census at f578af740): 314 follow the pref (`--ui-radius` 144, `--ui-radius-sm` 137, `--ui-radius-lg` 20, derived 13), 95 pill or circle (`--ui-radius-pill` 41, `50%` 48, `999px` 5), 46 literal px (31 of them in Pages and Spaces), 21 in the composer family, 24 zero. Buttons: `--ui-radius` 35 of 68 rules, including `.ui-btn`, `.t-icon-btn`, `.t-text-btn` and the composer chips. Badges: `--ui-radius-sm` 12 of 27. Copy `cornerRadiusVars()` (`frontend/src/state/prefs.tsx`). Exceptions: the companion header menu at 6px (`frontend/src/components/terminal/companion/companion.css`), rail buttons at 7px (`frontend/src/components/terminal/rail/rail.css`), page-change cards at 6, 8 and 10px (`frontend/src/components/terminal/spaces/pageChanges.css`), `--ui-radius-md` (undefined). The family rule names `.terminal-composer`, `.workflow-run-card`, `.mm-card`, `.workflow-fold`, `.background-workflow-card`, `.background-subagent-card` and `.terminal-message-user`; `.shell-notice` and `.shell-notice-tab` (whose phone rule in `frontend/src/components/terminal/mobile.css` reads the variable for all four corners), `.t-branch-anchors-list` and `.interrupted-notice-list` (`frontend/src/index.css`) read it from outside, so they stay square on phones too (gap). Two more outside readers, which no decision names, also get 0: the Appearance preview's composer (`.appearance-preview__composer`, `frontend/src/components/terminal/pages/Settings.css`) and the phone's docked selection bar, portaled over the composer (`.sel-actions-term-bar.is-dock`, `frontend/src/components/SelectionActions.tsx`).

**Check.** `npm run test:e2e -- e2e/specs/menu-appearance.spec.ts` ("the corner radius preference reshapes menus, modals, rows and controls together"). `npm test -w frontend -- src/components/terminal/mobile.css.test.js src/components/terminal/buttonStates.css.test.js`; the family test's list also holds `.shell-notice`, `.shell-notice-tab`, `.t-branch-anchors-list` and `.interrupted-notice-list`. `npm run lint -w frontend` (an inline `borderRadius` number warns). Diff check `(border-radius|borderRadius):\s*+'?+(?!0(?![.\d])|var\(|calc\(var\(--ui-radius|inherit)` and `\brounded(-[a-z]+)?\b`; the possessive `\s*+'?+` keeps lines that already read a token from matching. Run over the whole snapshot, the first pattern finds only literal radii (`50%`, `3px`, `999px` …) and a few JS constants.

### TK-21 Nested radius

**Rule.** When a shape sits inside a rounded surface, step one token down: a `--ui-radius` surface holds `--ui-radius-sm` rows and controls; a `--ui-radius-lg` hover card or sheet holds `--ui-radius` controls. Never reuse the outer token inside, and never compute "outer minus padding". When a control paints a plate inset inside its hit box (Send, Stop), grow the box's radius by the inset, `calc(var(--ui-radius) + var(--composer-send-inset, 2px))`, so the painted plate keeps `--ui-radius`.

**Sources.** [M3] "Outer radius - padding = inner radius" · [HIG] "concentric shapes calculate their radius by subtracting padding from the parent’s." · [RF] (Devouring Details dialog source: 16px outer, 4px padding, 12px inner) "p-1 … rounded-[16px] … rounded-12 p-3" · [WIG] "Nested radii. Child radius ≤ parent radius & concentric so curves align." · [CODE] `frontend/src/state/prefs.tsx` `cornerRadiusVars`: "Inner shapes use half the outer radius so rows and buttons stay visibly nested inside their surface at any setting" · [OWNER] decision 2026-11-14 (TK-Q3): in-flow cards take `--ui-radius` (4px by default), the most used card radius · **Conflict:** M3, Apple and Devouring Details subtract the padding; Michi halves. **Choice:** halve. **Why:** the e2e test pins it (at radius 10, surfaces 10px and rows 5px), it keeps Vercel's child ≤ parent, and subtracting a menu's 6px padding from its 4px radius would square every row at the default.

**Michi today.** (census at f578af740)

| Outer | Inner | Where |
|---|---|---|
| menu `--m-radius` (= `--ui-radius`) | rows `--m-itemRadius` (= `--ui-radius-sm`), 5 uses | `frontend/src/components/ui/Menu.css` |
| popovers and modals (`--ui-radius`) | tooltips, inputs, badges at `--ui-radius-sm` | `frontend/src/index.css` |
| Send / Stop hit box, `calc(var(--ui-radius) + var(--composer-send-inset, 2px))` | the painted plate at `--ui-radius` | `.t-action-btn.is-primary, .t-action-btn.is-queue` in `frontend/src/index.css` |
| exceptions | `calc(var(--ui-radius) - 1px)` on `.michi-doc-toolbar__btn` (`frontend/src/components/terminal/content/page/michiPage.css`); the `min(6px, …)` inner cap in `frontend/src/components/terminal/backgroundWork/workCardParts.tsx` | — |

**Check.** `npm run test:e2e -- e2e/specs/menu-appearance.spec.ts`. Devtools at Corner radius 10: surfaces 10px, their rows 5px.

### TK-22 In-flow card radius

**Rule.**
- When a card frames chat content (workflow, multi-model and background cards, the finished-runs fold), it belongs to the composer family (TK-20).
- When it is a "paper" card (Map, Digest, Workspaces), it is square.
- Every other in-flow card or box takes `--ui-radius`: home cards and their loading skeletons, thread and task cards, the ask card, Companion cards and receipts, catalog and component cards, page-change cards, and the notes, previews, alerts and empty-state frames in pages, panels and Settings. A card with a status bar down its left edge rounds only its right corners, `0 var(--ui-radius) var(--ui-radius) 0` (`.space-live-card`). Never `--ui-radius-lg`, `--ui-radius-sm` or a literal on an in-flow card; shapes inside it follow TK-21.
- A card that floats is not in-flow: the branch hover card (`.t-branch-card`) keeps `--ui-radius-lg` (TK-20).

**Sources.** [OWNER] decision 2026-11-14 (TK-Q3): in-flow cards that are neither chat frames nor paper take `--ui-radius` (4px by default), the radius most used today (5 of 21 card rules) · [OWNER] decision 2026-11-14 (TK-Q11): the eleven in-flow cards and boxes that write literal radii all take `--ui-radius` · [CODE] `frontend/src/index.css` `:root`: "-lg is double, for cards, tables and tab pills." · [CODE] `frontend/src/components/terminal/map/MapCard.tsx`: "Sharp corners everywhere — this is paper, not a chip." · [OWNER c:kk] (in Chinese, translated: on desktop, shouldn't the drawer's workflow card be square?) · [M3] "Be careful not to apply large or full corners to information-dense components, such as cards" · **Conflict:** the `:root` comment gives cards `-lg`, as 4 card rules do. **Choice:** `--ui-radius`. **Why:** the owner's decision; it is also the commonest card token (5 of 21) and the tighter corner M3 asks for on dense cards. Update the comment when you edit `:root`.

**Michi today.** 21 card rules, no majority (census at f578af740): `--ui-radius` 5 (`.michi-card`, `.ask-card`, `.app-toast-card` …), `--ui-radius-lg` 4 (`.home-card`, `.t-branch-card`, `.component-catalog__card`, the meta-chat receipt card), 0 ×3, `--ui-radius-sm` 2 (`.companion-card`, `.companion-brief-card`), literals 4, composer family 2, and `.space-live-card` at `0 var(--ui-radius-lg) var(--ui-radius-lg) 0`. The census counts `.t-branch-card`, but it is the branch hover card, a floating surface (TK-03, TK-24 level 2), and stays. The 0 ×3 do not move either: `.spaces-home-space-card` is a row with only a bottom rule, and two Sonner rules square a toast's window-edge corners.

Moving to `--ui-radius`:
- `--ui-radius-lg`: `.home-card` with `.home-card-skeleton` and `.home-work` (`frontend/src/components/terminal/home/homeCards.css`), so Home's loading and loaded layouts still match (TK-31); `.component-catalog__card` (`frontend/src/components/terminal/spaces/components/components.css`); `.meta-chat-card.assistant-receipt` with the two rules that repeat its corners (`frontend/src/components/terminal/spaces/metaChat/metaChat.css`); `.space-live-card`'s right corners (`frontend/src/components/terminal/spaces/conversation/conversation.css`); and two in-flow boxes outside the census, `.spaces-home-status__list` (`frontend/src/components/terminal/spaces/home/home.css`) and `.meta-set__alert` (`frontend/src/components/terminal/settings/metaAgent/metaAgentSettings.css`).
- `--ui-radius-sm`: `.companion-card` and `.companion-brief-card` (`frontend/src/components/terminal/companion/companion.css`).
- Tailwind classes: `rounded` in `frontend/src/components/terminal/ChatCommandResult.tsx` and `rounded-lg` in `frontend/src/components/terminal/CrewIntegrationStatus.tsx`.
- The eleven literals: `.page-changes-history` 8px and `.page-change-batch` 10px (`frontend/src/components/terminal/spaces/pageChanges.css`); `.page-component-preview` 8px, `.page-component-host` 7px and `.page-component-error` / `.page-component-fallback` 6px (`frontend/src/components/terminal/spaces/components/components.css`); `.companion-receipt` and `.companion-upgrade-note` 6px (`frontend/src/components/terminal/companion/companion.css`); `.settings-backup__preview` 6px (`frontend/src/components/terminal/pages/Settings.css`); the inline `borderRadius: 5` boxes of `frontend/src/components/terminal/spaces/MaintenanceStatus.tsx` and `frontend/src/components/terminal/spaces/MaintenanceWatches.tsx`; and `.spaces-empty-icon` 12px (`frontend/src/components/terminal/spaces/spaces.css`, which no component renders today), the frame round the Spaces empty-state glyph, whose glyph follows states.md ST-15.

**Check.** Devtools at Corner radius 10: every in-flow card and box draws 10px corners, the branch hover card 20px, paper cards 0, and composer-family cards 0 on desktop. Diff check `(border-radius|borderRadius):\s*+'?+var\(--ui-radius-(lg|sm)\)`: no hit is an in-flow card or box. TK-20's checks catch the literals and Tailwind classes.

### TK-23 Borders and lines

**Rule.**
- Hairlines are 1px `--term-line`: dividers, containers, and the edges of menus, popovers, tooltips, drawers and sheets.
- Strong lines are `--term-line-s`: control borders (`.ui-switch`), header underlines, SVG strokes, quote and callout rules.
- A softer hairline over glass or on a docked frame is `color-mix(in srgb, var(--term-line) 50%, transparent)`; a status-tinted border is the hue at 35% into `--term-line` (TK-08).
- Widths: 1px by default. 2px for the current item's left bar (`--term-accent`), for a checked row's bar (`--term-select`, states.md ST-18), for tab underlines and for quote and callout rules. 1.5px for radio, checkbox and spinner rings. 2px dashed `--term-accent` for drop zones. Dashed lines only mark drop zones and placeholders. No 0.5px border.
- Pane dividers come from `--term-pane-divider` (the Chrome rules pref).
- Where two in-flow regions already differ in tone, add no border; floating surfaces keep a hairline plus their shadow (TK-24), except modals: over their scrim the border is transparent (TK-24 level 5).

**Sources.** [RUI] "If you’re already using different background colors in addition to a border, try removing the border; you might not need it." · [WIG] "Crisp borders. Combine borders & shadows; semi-transparent borders improve edge clarity." · [HIG] "The thin divider measures one point in width" · [M3] "Use full-width dividers sparingly." · [LIN] "By rounding out their edges and softening the contrast, the polished interface gives users structure on the page without cluttering their view." · **Conflict:** Vercel adds borders to shadows; RUI drops borders where tones already differ. **Choice:** both, by context. **Why:** they answer different cases: a floating surface over varied content needs a crisp edge, and adjacent in-flow regions need only one cue.

**Michi today.** 1,023 border-width rows: 1px 617, none or 0 325, 2px 46, 1.5px 7, 3px 6 (census at f578af740). Colours: `--term-line` 432 of 857 border declarations, `--term-line-s` 84, line mixes 28 in 8 alphas (50% ×10), hue-into-line borders 19. Selected left bars: 2px ×14, 3px ×5. Copy `--ui-popover-border` (`frontend/src/index.css`), the 2px rail in `frontend/src/components/terminal/ThreadRow.tsx`, and `.terminal-settings-category` (`frontend/src/components/terminal/pages/Settings.css`). Exceptions: `.ui-modal-panel` and the Settings window's side panel (`.settings-window__aside`) keep a 1px border but make it transparent, so forced-colors mode still draws one; 3px bars in `frontend/src/components/terminal/DigestPane.tsx` and `.space-live-card`; the 1.5px sidebar tab underline; the phone menu's 0.5px ring, drawn as a box-shadow.

**Check.** Diff check `(border(?![a-z-]*radius)(-[a-z-]+)?|border(?![A-Za-z]*Radius)[A-Z]\w*):\s*'?[^;]*?(?<![\d.])(0?\.5|3|4)px` (CSS longhands and camelCase JSX such as `borderLeft: '3px solid …'`, and `.5px` with or without the zero).

### TK-24 Elevation and shadows

**Rule.** When something rises, choose its level and use that level's token; write no new shadow literal:

| Level | Surfaces | Token |
|---|---|---|
| 0, in flow | panes, rows, cards at rest (the Digest and Workspaces paper cards included), pane chrome | no shadow; a 1px `--term-line` or a tone step |
| 1, a clickable in-flow card, on hover | `.home-card`, `.workflow-run-card--opens` | `--term-line-s` border plus `--term-composer-shadow-muted` (light palettes; none on dark) |
| 2, floating inside a pane or over reading text | doc block toolbar, terminal banner, floating meta-chat, scrubber grip, bottom sheet, branch hover card | `--term-float-shadow` on `--term-surface`; `--term-float-bg` only for a card over reading text (the branch hover card, TK-03) |
| 3, popovers, menus, tooltips | plain popovers and the right-click menu; tooltips; glass menus and popovers | `--ui-popover-shadow`; `--ui-tooltip-shadow`; `.term-glass` |
| 4, dark floating bars | the selection bar and its composer, batch bars | `--sel-bar-shadow`, on `--sel-bar-bg` |
| 5, modals and drawers | ModalShell, DrawerShell | `.term-glass` over a scrim (TK-09): modals take only `--term-overlay-cast`, with a transparent border; drawers add `--term-overlay-highlight` |
| toasts and corner notices | Sonner, `.app-toast-card`, `.shell-notice` | `0 4px 12px rgba(0, 0, 0, 0.1)`: reuse these classes rather than copy the value |
| the composer | `.terminal-composer` | `--term-composer-shadow` (focus) and `--term-composer-shadow-muted` (rest); the dark focus shadow is an inset well |

Floating overlays always cast an outer shadow, never an inset one. Rings that mark selection or the current item are not elevation: `0 0 0 1px var(--term-accent)` for the current card, `inset 2px 0 0 var(--term-accent)` for the current list row. Shadow ink is black alpha or a `--term-fg` mix (TK-08).

**Sources.** [M3] "When it comes to applying shadows, less is more." · [WIG] "Layered shadows. Mimic ambient + direct light with at least two layers." · [RUI] "Instead of using large blur and spread values to make box shadows more noticeable, add a vertical offset." · [EK] (Sonner, the toast value Michi shares) "box-shadow: 0px 4px 12px rgba(0, 0, 0, 0.1);" · [CODE] `frontend/src/components/terminal/tokens.ts` `cssVarsFor`: "always an OUTER drop, never inset" · [CODE] `frontend/src/components/terminal/paneArrivals.css`: "Pane chrome, not a floating card: square, hairline, no shadow" · [OWNER] decision 2026-11-14 (TK-Q12): the paper cards drop their resting shadows and keep only the 1px edge · [OWNER] decision 2026-11-16: modals drop the drawn edge and the 1px top highlight; over the scrim the cast is enough, the same with live, frozen or solid glass · **Conflict:** Vercel asks for at least two layers; `--ui-popover-shadow`, `--ui-tooltip-shadow` and the toast value have one. **Choice:** keep them. **Why:** each is its level's majority and no hard requirement applies; the larger levels (float, overlay cast, selection bar) already have two layers.

**Michi today.** 135 shadow rows (census at f578af740): 41 literal drops, 23 tokens, 31 rings. Majority per level: level 1 `--term-composer-shadow-muted` 2 of 4; level 2 `--term-float-shadow` 5 of 10, on `--term-surface` in 5 of its 6 surfaces; level 3 `--ui-popover-shadow` by site count; level 4 `--sel-bar-shadow` 5 of 8; level 5 `.term-glass` 2 of 6; toasts and notices `0 4px 12px rgba(0,0,0,.1)` 3 of 3 live surfaces. Ink: black alpha 31, `--term-fg` mixes 14, Bone ink 8 (+5 on the landing page). Copy the tokens in `cssVarsFor()` and the `--ui-popover-*` block and `.term-glass` in `frontend/src/index.css`. Exceptions: `.t-pane-find` (`frontend/src/components/terminal/PaneFind.tsx`: `0 4px 12px rgba(0,0,0,.15)`, square), the multi-model picker (`0 12px 32px rgba(0,0,0,.32)`), the Map's own two-layer recipe, the phone sidebar overlay (`4px 0 24px rgba(0,0,0,.18)`). The Digest and Workspaces paper cards rest on eight shadows in Bone's ink, `rgba(26,25,22,…)`: six `boxShadow` strings in `frontend/src/components/terminal/pages/Digest.tsx`, one in `frontend/src/components/terminal/pages/Workspaces.tsx` and one in `EmptyState` (`frontend/src/components/terminal/pages/workspaceList.tsx`). They go; each card already has the `1px solid var(--term-line)` border it keeps.

**Check.** Diff check `(box-shadow|boxShadow):[^;]*\d+px[^;]*(rgba?\(|color-mix)` (token definitions excepted). `rg -n 'rgba\(26,\s*25,\s*22' frontend/src` prints nothing (at f578af740 it prints the eight paper-card shadows).

### TK-25 Glass and blur

**Rule.**
- When a floating surface sits over reading content (modals, glass menus and popovers), add `.term-glass`: the surface at 88%, a 48px blur, 110% saturation, an 8% white top highlight and the overlay cast.
- Desktop (Electron) renders these opaque: menus through `.ui-overlay-surface[data-glass='solid']`, modals through the frozen capture (`useFrozenGlass`). Under `prefers-reduced-transparency`, `.term-glass`, the sidebar and menus turn solid; the four surfaces listed under Exceptions don't yet (gap). Never write your own `backdrop-filter`.
- Drawers, the right-click menu and toasts stay solid, and so does every phone surface that moves over the transcript, with no `backdrop-filter` (motion.md MO-16): the sidebar drawer of the phone layout paints `var(--term-surface)`, the long-press menu `var(--term-float-bg, var(--term-surface))`, and the long-press scrim keeps only its dim (TK-09).
- Add no thin glass. Its one use was the sidebar of the overlay layout (the docked sidebar draws no `backdrop-filter`). With that drawer opaque, the two settings that tuned its blur, Settings › Appearance › Advanced › Glass blur and Glass saturation, are removed with everything that only served them (TK-Q14): the `glassBlur` and `glassSaturate` prefs in `frontend/src/state/prefs.tsx` (their `Prefs` fields, `DEFAULT_PREFS` values, `PREF_STORAGE` scopes, `normalizePrefs` checks and the `PrefsProvider` effect that writes the two variables); the tokens `--term-glass-blur` and `--term-glass-saturate` and the `.terminal-sidebar` `backdrop-filter` that reads them (`frontend/src/index.css`); their two rows and `ADVANCED_SETTINGS` names in `frontend/src/components/terminal/pages/settings/AppearancePane.tsx`; and their entries in `settingsSearchIndex` (`frontend/src/components/terminal/rail/settingsSearch.ts`). Sidebar glass (`sidebarTranslucency`) stays, because `--term-sidebar-solid-alpha` still tints the docked frame (`--term-chrome-bg`) and, under macOS vibrancy, `--term-vibrancy-tint`. Sidebar material is gone (2026-11-16): macOS always uses the `under-window` material. Glass defaults (`GLASS_PREFS`) then resets only Sidebar glass, and Window glass stays as set.
- Cards inside a glass panel use `--term-surface-glass`; fills on glass use the `--sb-card-*` overlays (TK-07).
- No glass in the content layer (panes, transcript, in-flow cards), and no new blur radius.

**Sources.** [OWNER c:14y] (in Chinese, translated: go with the dense frost) · [OWNER m:2uv1] (recorded decision) (in Chinese, translated: 88% solid, 48px blur, 110% saturation, an 8% white top highlight) · [CODE] `frontend/src/components/ui/OverlaySurface.css`: "Desktop overlays must not sample a repainting transcript." · [HIG] "Don’t use Liquid Glass in the content layer." · [HIG] "Reduced Transparency, makes Liquid Glass frostier and obscures more of the content behind it." · [LIN] "a preference to turn off translucent interface components in case they have a negative performance in older devices" · [RF] "Large `blur()` values for `filter` and `backdrop-filter` may be slow" · [OWNER] decision 2026-11-14 (MO-Q12): make the moving phone surfaces opaque, as on the desktop, with no frosted glass · [OWNER] decision 2026-11-14 (TK-Q14): remove the Glass blur and Glass saturation settings, with their prefs, the two tokens and their Settings search entries; Sidebar glass stays · **Conflict:** Rauno warns that large blurs are slow; the owner chose 48px. **Choice:** 48px. **Why:** owner decisions bind. Desktop never runs a live blur over the streaming transcript, because it is frozen or opaque. The web and phone builds do keep a live 48px blur on glass menus and popovers over the transcript, a cost the owner accepted with the dense frost, which named the menus and popovers.

**Michi today.** (census at f578af740)

| Material | Blur | Saturation | Solidity | Where |
|---|---|---|---|---|
| overlay frost `.term-glass` | 48px (`--term-overlay-blur`) | 110% | 0.88 | modals, glass menus and popovers |
| sidebar | pref 10px (CSS fallback 26px), `--term-glass-blur`: removed (TK-Q14) | pref 130% (fallback 160%), `--term-glass-saturate`: removed (TK-Q14) | pref 0.4 (fallback 0.72), `--term-sidebar-solid-alpha` | `.terminal-sidebar`, narrow overlay only |
| phone context menu | 24px; scrim 9px | 180%; 110% | 82% | `frontend/src/components/ui/PhoneContextMenu.css` |
| Map chrome / Branches outline / top-bar caption | 12px / 10px / 12px | — | 82% / 82% / — | `frontend/src/components/terminal/pages/Map.tsx`, `frontend/src/components/terminal/pages/docLayout.ts`, `frontend/src/components/terminal/Topbar.tsx` |

Copy `.term-glass` (`frontend/src/index.css`) and `frontend/src/components/ui/OverlaySurface.css`. Exceptions: the last two rows (the phone context menu, the Map chrome, the Branches outline and the top-bar caption), whose blurs ignore `prefers-reduced-transparency`; the sidebar's CSS fallbacks differ from the pref defaults at first paint (once TK-Q14 lands, only its solidity does: 0.72 against 0.4). The overlay sidebar's blur and the phone context menu's two blurs go with MO-16's opaque phone surfaces, and the sidebar's blur and saturation settings and tokens go with them (TK-Q14).

**Check.** Diff check `backdrop-filter|backdropFilter|blur\(`. On a 390px viewport the open sidebar drawer's computed `backdrop-filter` is `none` (motion.md MO-16). `npm run test:e2e -- e2e/specs/menu-appearance.spec.ts e2e/specs/overlay-streaming-stability.spec.ts` ("glass menus keep the overlay frost whatever the sidebar glass, honour reduced transparency; right-click stays solid"). TK-Q14: `rg -n 'term-glass-(blur|saturate)|glass(Blur|Saturate)|Glass (blur|saturation)' frontend/src e2e` prints nothing (at f578af740 it prints 42 lines in 7 files: `frontend/src/index.css`, `frontend/src/state/prefs.tsx`, `frontend/src/components/terminal/pages/settings/AppearancePane.tsx` and its test, `frontend/src/components/terminal/rail/settingsSearch.ts` and its test, and `e2e/specs/menu-appearance.spec.ts`, whose glass test then sets only `--term-sidebar-solid-alpha`). `npm test -w frontend -- src/components/terminal/pages/settings/AppearancePane.test.tsx src/components/terminal/rail/settingsSearch.test.tsx`: Advanced lists neither setting, and Reset under Glass defaults sets only `sidebarTranslucency` and `sidebarVibrancy`.

### TK-26 z-index ladder

**Rule.**
- When something floats, use a rung from the ladder in `frontend/src/index.css` `:root`; plain values 1–6 only order siblings inside one component.
- Right-click and long-press menus → `--z-context-menu`; menus opened from a button, popovers and autocompletes → `--z-popover`; tooltips → `--z-tooltip`. A tooltip (1050) therefore draws over a button-opened menu (1000) and under a right-click menu (1100). The trigger's own tip hides on press (`HoverTip`'s `onPointerDown`), but a neighbouring control's tip can cover an open button menu. `ActionMenu`, `MichiMenu` and `LayoutRulesPopover` sit at 1000 already; `ContextMenu`'s button-opened pickers and `DbPopover` move from 1100 to 1000 when you touch them.
- When a modal hosts menus, popovers or tooltips of its own (Settings; a page view presented as a modal), open it on the window layer: `ModalShell` `layer="window"` (`--z-window` 51, `frontend/src/components/ui/ModalShell.css`). Its floating surfaces (1000–1100) then draw above it, and a confirm dialog (`--z-modal`) above those. Every other modal keeps the default layer. Gap: `frontend/src/components/terminal/content/page/PageViewContext.tsx` presents page blocks in a default-layer `ModalShell`, so their menus open beneath it.
- If no rung fits, add one to the ladder with a comment naming what sits above and below it; never write a literal of 7 or more.

| In the shell | Value | | Page level | Value |
|---|---|---|---|---|
| `--z-pane-recede` | -1 | | `--z-drawer-scrim` / `--z-drawer` | 40 / 41 |
| `--z-raised` | 1 | | `--z-window-scrim` / `--z-window` (in `frontend/src/components/ui/ModalShell.css`) | 50 / 51 |
| `--z-sticky` | 10 | | `--z-popover` | 1000 |
| `--z-pane-overlay` | 20 | | `--z-tooltip` | 1050 |
| `--z-shell-notice` | 30 | | `--z-context-menu` | 1100 |
| `--z-sidebar-scrim` | 34 | | `--z-modal-scrim` / `--z-modal` | 1200 / 1201 |
| `--z-sidebar-overlay` | 35 | | `--z-lightbox` | 1300 |
| `--z-drag` | 36 | | `--z-selection` | 1350 |
| | | | `--z-toast` | 1400 |

**Sources.** [CODE] `frontend/src/index.css` `:root`: "Everything floating now references a rung." · [CODE] `frontend/eslint.config.mjs`: "1–6 order siblings inside one component; anything that layers over a pane or the page takes a rung" · [CODE] `frontend/src/components/ui/ModalShell.tsx` (`layer`): "'window' for a modal that hosts menus and popovers of its own (Settings): it sits below them instead of above." · [CODE] `frontend/src/components/ContextMenu.tsx`: "Right-click menus historically sit above every other popover" · No external source sets a z-index scale.

**Michi today.** 93 z-index rows (census at f578af740):

| Kind | Rows |
|---|---|
| `--z-*` tokens | 34 (+4 in `calc()`) |
| local literals 0–6 | 38 |
| negative, behind-content layers | 4 |
| literals off the ladder | `frontend/src/components/ContextMenu.tsx` 1100 and 1101; `frontend/src/components/ui/PhoneContextMenu.css` 1100; `frontend/src/components/MentionEditor.tsx` 60 (the `@` and `/` autocompletes, ×2); `.native-page-drop` (`frontend/src/components/terminal/spaces/nativeBlocks.css`) 2000; the multi-model picker 10; the companion header menu 5 |
| window layer | `layer="window"` on Settings only (`frontend/src/components/terminal/TerminalShell.tsx`); its rungs live in `frontend/src/components/ui/ModalShell.css`, outside the ladder |

**Check.** `npm run lint -w frontend` (an inline `zIndex` of 7 or more warns). `rg -nP -g '*.css' -g '!**/vendor-blocks/**' '(?<![-\w])z-index:\s*([7-9]|[1-9]\d+)\b' frontend/src` prints only the three known CSS lines. Devtools: open a menu from inside a new modal; it draws above the panel.

### TK-27 Opacity levels

**Rule.** This rule fixes the opacity levels; which disabled treatment a control takes is states.md ST-11.
- A disabled control that fades takes `opacity: 0.5`, as `.ui-btn:disabled` and `.ui-switch:disabled` do. Which controls fade, which recolour instead (menu rows, toolbar chips, sheet actions, links) and the disabled primary's look (opacity 1 on a `--term-alt2` fill) are states.md ST-11.
- When something hides until hover, use `.t-reveal` / `.t-reveal-host` (0 to 1, with its touch path).
- A drag source is 0.45.
- When text needs less emphasis, use a text token (TK-04), not opacity.
- An unfocused pane's surface recedes toward `--term-recede-fill` under its own content, never with opacity or a filter on the pane, and never over the text it holds; an unfocused caption cell in the top bar recedes the same way, under its title, at the same strength (motion.md MO-16).
- Messages that edit mode dims take 0.38 (`DIMMED_FRAME_STYLE` in `frontend/src/components/terminal/PaneMessageList.tsx`), opacity only, with no `saturate()` (motion.md MO-16).

**Sources.** [M3] "DisabledLabelTextOpacity = 0.38f" · [WCAG 1.4.3] (Understanding) "User Interface Components that are not available for user interaction (e.g., a disabled control in HTML) are not required to meet contrast requirements." · [RF] (Devouring Details disabled button) "background:var(--color-gray5);color:var(--color-gray10);box-shadow:unset;border-color:transparent;cursor:not-allowed" · [RUI] "If you’re considering using a lighter weight to de-emphasize some text, use a lighter color or smaller font size instead." · [CODE] `frontend/src/hooks/usePaneShellStyle.test.ts`: "sinks an unfocused pane with its recede element, not a filter, opacity or property on the pane" · [CODE] `frontend/src/components/terminal/buttonStates.css.test.js`: "shows a disabled database primary (Creating…) as nothing to do yet, the way a disabled primary Button does" · [OWNER] decision 2026-11-14 (MO-Q13): a separate veil layer: the caption cell dims together with the top bar's background, like the cells below, and edit mode only lowers opacity, keeping the colours · **Conflict:** M3 fades disabled content to 38%; Devouring Details recolours with grey tokens; Michi fades the control to 50%. **Choice:** 0.5. **Why:** it is the plurality (16 of 61 disabled opacities) and the value of both primitives; WCAG exempts disabled controls from contrast.

**Michi today.** Disabled opacities, 61 sites (census at f578af740):

| Opacity | 0.28–0.35 | 0.4 | 0.45 | 0.5 | 0.55 | 0.6 | 0.62–0.65 | 1 (primary) |
|---|---|---|---|---|---|---|---|---|
| sites | 3 | 9 | 12 | 16 | 8 | 9 | 2 | 2 |

Another 22 rules recolour to faint or muted instead. Copy `.ui-btn:disabled`, `.ui-btn--primary:disabled` and `.t-reveal` (`frontend/src/index.css`). Exceptions: `.ui-menu-item[data-disabled='true']` dims twice (faint and 0.6); `frontend/src/components/terminal/WorkspaceRow.tsx` drags at 0.5; Lightbox captions are dimmed by opacity; edit mode adds `filter: saturate(0.5)` to its 0.38, and the top-bar caption cell dims with an inline `filter: brightness()` (`frontend/src/components/terminal/Topbar.tsx`), both until they take MO-16's forms.

**Check.** `npm test -w frontend -- src/components/terminal/buttonStates.css.test.js src/hooks/usePaneShellStyle.test.ts src/hoverReveal.css.test.js`. Diff check `opacity:\s*0?\.(?!5\b|45\b)\d+`: each hit is a motion keyframe or one of the levels above.

### TK-28 Focus ring token

**Rule.** `--focus-ring` is the only keyboard focus ring: write `outline: var(--focus-ring)`, never a literal accent outline and never a thinner ring. Its colour is derived per palette and accent (states.md ST-07): `cssVarsFor()` emits `2px solid <accent>` when the accent reaches 3:1 against `--term-bg`, `--term-surface` and `--term-alt`, as every default accent does, and otherwise `2px solid color-mix(in srgb, <accent> N%, <fg>)` with N stepping down from 95% by 5% until the ring reaches 3:1 on all three, the stepping `--term-accent-text` uses to reach 4.5:1 (TK-06). `frontend/src/index.css` `:root` keeps `2px solid var(--term-accent)` only as the fallback outside the shell. Today's value, `2px solid color-mix(in srgb, var(--term-accent) 62%, transparent)`, misses 3:1 in some palettes (below); keep using the token, so the fix lands everywhere at once. The 1px accent rings move to the token (states.md ST-07). Placement, offsets, `outline: none` and the forced-colours replacement are states.md ST-07 and ST-08.

**Sources.** [WCAG 1.4.11] (Understanding) "the visual focus indicator for a component must have sufficient contrast against the adjacent background when the component is focused" · [WCAG 2.4.7] "Any keyboard operable user interface has a mode of operation where the keyboard focus indicator is visible." · [CODE] `frontend/src/focusRing.css.test.js`: "uses var(--focus-ring) for every 2px accent focus ring" · [OWNER] decision 2026-11-14 (ST-Q1): mix the accent toward the foreground step by step until it reaches 3:1 on all three grounds · [OWNER] decision 2026-11-14 (ST-Q3): the 1 px rings are not deliberate; replace them all with the 2 px `--focus-ring`, placed as ST-07 says

**Michi today.** 84 of 195 CSS focus rules use the token (the count states.md ST-07 uses); 26 draw `1px solid var(--term-accent)` (27 with `frontend/src/components/terminal/pages/docLayout.ts`), which the ratchet exempts and which move to the token (census at f578af740). `cssVarsFor()` emits no ring yet. Today's ring composited over its own ground, default accents (computed):

| Palette | on surface | on bg | on alt |
|---|---|---|---|
| Bone | 2.71 ✗ | 2.69 ✗ | 2.50 ✗ |
| Slate | 3.26 | 3.13 | 2.97 ✗ |
| Monokai | 4.15 | 4.38 | 3.73 |
| Gruvbox | 2.87 ✗ | 3.01 | 2.59 ✗ |

A picked accent changes these. The derived ring draws every default accent plain, at 4.31:1 or more (Gruvbox on alt); the 22 of 44 palette × picked-hue pairs that miss 3:1 take N from 95% down to 60% and land at 3.01–3.36:1 (computed, states.md ST-07). Copy the baseline `:where(button, [role='button'], a[href], input, select, textarea):focus-visible` rule in `frontend/src/index.css`.

**Check.** `npm test -w frontend -- src/focusRing.css.test.js src/components/terminal/tokens.test.ts`, with the `tokens.test.ts` case over `PALETTES` × `ACCENT_HUES` that states.md ST-07 describes. Devtools: Tab to the control in all four palettes and measure the ring against the surface around it.

### TK-29 Duration tokens

**Rule.** When CSS times a transition or a one-shot animation, use one of the eleven one-shot tokens; when it loops, one of the three loop tokens. JS (motion) uses `DUR` in `frontend/src/motion/tokens.ts`, in seconds: it mirrors the eleven and adds one motion-only step, `DUR.expand`. Which element takes which token is motion.md's MO-04 to MO-06. `--t-decay` and `--t-slow` are only for effects nobody waits on (MO-05). Loops live in CSS classes and animate only opacity or transform, so panes that stream don't repaint per frame. Five of the one-shot tokens come from the owner's decision of 2026-11-14 and are not in the code yet (MO-04): `--t-brief`, `--t-dismiss` and `--t-move` with their `DUR` twins, and `--t-collapse` and `--t-scrim-exit`, the CSS twins of `DUR.collapse` and `DUR.scrimExit`.

| CSS | JS | Value | Role | Uses, CSS / TS strings / JS (census at f578af740) |
|---|---|---|---|---|
| `--t-quick` | `DUR.quick` | 60ms | hover and colour changes | 101 / 33 / 0 |
| `--t-soft` | `DUR.soft` | 100ms | state changes: carets, fades, borders; fade-only menus and tooltips popping in (growing menus take `--t-brief`) | 91 / 33 / 8 |
| `--t-brief` | `DUR.brief` | 120ms | menus and popovers growing in, the selection popup's entrance, status words, labels and digits leaving, status cross-fades and short content fades (MO-04) | new: it replaces the 120ms literals and constants (TK-32) |
| `--t-dismiss` | `DUR.dismiss` | 80ms | menus, popovers and the selection popup fading out, and inline content fading as it leaves (MO-04, MO-06) | new: it replaces the 80ms literals |
| `--t-enter` | `DUR.enter` | 180ms | drawers, modals, scrims and overlays arriving | 36 / 16 / 14 |
| `--t-exit` | `DUR.exit` | 110ms | modals, toasts, notices and list items leaving (MO-06) | 6 / 0 / 4 |
| `--t-move` | `DUR.move` | 220ms | on-screen layout moves and settles (re-sort, FLIP followers, held-room release, the change-list settle, the thought finish, the ask card's collapse), pane tracks opening and the canvas camera (MO-04) | new: it replaces the 220ms literals and constants |
| `--t-collapse` | `DUR.collapse` | 160ms | disclosures, drawers, sheets and panels closing (MO-06, transitions.md TR-08) | JS 4; the CSS twin is new |
| `--t-scrim-exit` | `DUR.scrimExit` | 140ms | the scrim of a drawer or sheet, clearing just before its 160ms panel (TR-09); a ModalShell scrim leaves with its panel's 110ms | JS 3; the CSS twin is new |
| `--t-decay` | `DUR.decay` | 360ms | slow fades nobody waits on | 12 / 3 / 1 |
| `--t-slow` | `DUR.slow` | 600ms | highlights that linger: find and message flash, new-pane glow | 10 / 3 / 3 |
| — | `DUR.expand` | 260ms | disclosure bodies opening | JS 3 |
| `--t-loop-fast` | — | 1s | spinners, cursor blink, the Map's feeding edge (MO-13) | 7 / 1 |
| `--t-loop` | — | 1.4s | pulses, breathing dots, skeletons | 17 / 0 |
| `--t-loop-slow` | — | 2.4s | ambient breathing: live labels and the Map's glows (MO-13) | 3 / 0 |

Invariants (tested): `DUR.exit` < `DUR.enter`, `DUR.dismiss` < `DUR.brief`, `DUR.collapse` < `DUR.expand`, `DUR.scrimExit` < `DUR.collapse`, and every `DUR` value with a CSS twin equals it; the `DUR.dismiss` pair and the five new twins join `frontend/src/motion/tokens.test.ts` and `frontend/src/motion/tokens.css.test.js` with the tokens. The `frontend/src/index.css` comment still names "the first six", gives `--t-exit` "the same surfaces leaving", `--t-loop-fast` "flowing edges" and `--t-loop-slow` "shimmer"; rewrite it from this table when you add the tokens, since MO-06 and TR-08 move drawers and sheets to `--t-collapse` / `DUR.collapse` and MO-13 replaces the flowing edge and the shimmer.

**Sources.** [CODE] `frontend/src/index.css` `:root`: "Every transition and one-shot animation uses one of the first six; every looping animation one of the three loop rhythms." · [CODE] `frontend/src/motion/tokens.css.test.js`: "mirrors the CSS motion tokens in motion/tokens.ts" · [CODE] `frontend/src/motion/tokens.test.ts`: "keep exits shorter than entrances, like pane motion" · [CODE] `frontend/src/motion/runningIndicators.test.js`: "loops running indicators through classes, which the reduced-motion rules can stop" · [M3] "const val DurationShort1 = 50.0" (M3's 16-step scale) · [M3] "Though rare, some transitions use durations above 600ms. These are usually used for ambient transitions that don't involve user input." · [EK] "As a rule of thumb, UI animations should generally stay under `300ms`." · [WCAG 2.2.2] "there is a mechanism for the user to pause, stop, or hide it" (loops that run longer than five seconds; motion.md MO-13) · [OWNER] decision 2026-11-14 (MO-Q1): add tokens in both CSS and JS, and give 160 ms and 140 ms a CSS version too · [OWNER] decision 2026-11-14 (MO-Q4): replace them all: the labels breathe as a whole, and the Map's glows become a layer that only changes opacity · **Conflict 1:** M3 names 16 steps by size class; Michi names its one-shot steps by purpose (six at f578af740, eleven with the tokens of 2026-11-14). **Choice:** Michi's purpose names. **Why:** they carry 289 of 308 CSS motion items (census), and M3 itself chooses the scheme at product level. **Conflict 2:** Emil keeps UI animations under 300ms; `--t-decay` (360ms) and `--t-slow` (600ms) exceed it. **Choice:** keep both. **Why:** they are only for effects nobody waits on (MO-05), the kind M3 also lets run long; everything the user waits on stays within `--t-enter` and `DUR.expand`.

**Michi today.** Copy the block in `frontend/src/index.css` `:root` and `DUR` in `frontend/src/motion/tokens.ts`. Exceptions: 19 literal CSS timing items (`120ms` ×7, `100ms` ×4, the `ui-menu-blink 160ms` and `--m-clickDelay` pair, `frontend/src/components/terminal/backendTerminal.css` loops at 1.4s and 0.8s, the 2.4s Settings search hit); 56 of 137 explicit JS durations are literals. `DUR.quick` has no JS use. None of the five decided tokens exists yet: `:root` holds the six one-shot tokens, `DUR` mirrors them and adds `expand`, `collapse` and `scrimExit`, and `frontend/src/motion/tokens.css.test.js` mirrors the six.

**Check.** `npm test -w frontend -- src/motion/tokens.css.test.js src/motion/tokens.test.ts src/motion/runningIndicators.test.js`. `npm run lint -w frontend` (a ms or s literal in an inline `transition` or `animation` warns; the lint message omits `--t-exit`, which is valid, and gains the five new tokens with them). Diff check `(transition|animation)(-duration|-delay)?:[^;]*\b\d+(\.\d+)?m?s\b`.

### TK-30 Easing and spring tokens

**Rule.** When you need a curve or spring, use the token; which element takes which is motion.md's MO-07 and MO-08.

| Token | Value | Purpose (`frontend/src/motion/tokens.ts`) | Uses (census at f578af740) |
|---|---|---|---|
| `--t-ease` / `EASE.term` | `cubic-bezier(.2, 0, .6, 1)` | the CSS curve for state, colour and opacity changes | CSS 140 items (+16 in TS strings); JS 1 |
| `EASE.out` | `[0.23, 1, 0.32, 1]` | entrances and exits ("the default for entrances") | 46 in 27 files |
| `EASE.drawer` | `[0.32, 0.72, 0, 1]` (= `PANE_EASE`) | panels, disclosures, layout settles | 18 in 12 files |
| `EASE.inOut` | `[0.77, 0, 0.175, 1]` | things travelling across the screen | 0 (`frontend/src/components/terminal/branchMotion.ts` `FLIGHT_EASE` repeats it) |
| `SPRING.snappy` | spring, visualDuration 0.22, bounce 0 | small things settling with no overshoot | 7 in 6 files |
| `SPRING.soft` | 0.3, bounce 0.12 | shared-element flights and layout moves | 1 |
| `SPRING.pop` | 0.4, bounce 0.3 | rare, high-emotion moments only | 1 |
| `TRANSITION.enter` / `.exit` | `{DUR.enter, EASE.out}` / `{DUR.exit, EASE.out}` | ready-made entrance and exit (`TRANSITION.enter` is `MotionRoot`'s default) | 6 / 7 |
| `TRANSITION.expand` / `.collapse` | height `{DUR.expand, EASE.drawer}` with opacity 0.16s after 0.04s linear / `{DUR.collapse, EASE.drawer}` | disclosure bodies | 2 / 2 |
| `linear` | — | constant loops and progress | CSS 9 items |

- Import the curve; never retype its numbers. `PANE_EASE`, `RELEASE_EASE`, `ROW_SETTLE`, the phone menu's `SETTLE` and `FLIGHT_EASE` are copies of `EASE` values.
- CSS has no mirror of `EASE.out` or `EASE.drawer`; write the exact value (`cubic-bezier(0.23, 1, 0.32, 1)`, as `frontend/src/components/ui/DrawerShell.css` does), per MO-07.
- No overshooting bezier outside `SPRING`; colour, opacity, hover and a mark that appears many times a day never overshoot (motion.md MO-08). The literal overshoot curves already in the code are listed in MO-08: the phone long-press lift (transitions.md TR-11) and the two once-per-arrival marks, `.map-card--in` and the caption dot's `pane-entrance-dot`, are sanctioned where they are; the map-card hover lift is a deviation, and the sidebar unread dot, which pops on every reply, drops its overshoot and settles on `EASE.out`.

**Sources.** [EK] "If you are animating something that is entering or exiting the screen, use `ease-out`." · [EK] "No bounce should be your default." · [M3] "Effects spring tokens are used to animate properties such as color and opacity animations, where there shouldn’t be any overshoot." · [HIG] "you should be cautious about using values higher than around 0.4, since they may feel too exaggerated for a UI element." · [CODE] `frontend/src/motion/tokens.test.ts`: "share the pane curve" · [CODE] `frontend/src/motion/tokens.ts` `SPRING.pop`: "Rare, high-emotion moments only (task done, first run)." · [OWNER] decision 2026-11-14 (MO-Q3): drop the overshoot from the frequent unread dot, and keep it on the two arrivals that play only once · **Conflict:** Emil shapes entrances and exits with ease-out, but `--t-ease`, the only CSS curve, is an in-out shape. **Choice:** `--t-ease` stays the CSS curve for state changes; entrance curves come from `EASE`. **Why:** 140 CSS items use it; changing the token's value would retime every CSS transition, a redesign.

**Michi today.** CSS easing items: `--t-ease` 140, `ease` 55 (+11 unset), `ease-out` 41, `ease-in-out` 19, `linear` 9, literal beziers 19 (9 of them `ASK_EASE` in `frontend/src/components/terminal/UserInputBanner.css`), `ease-in` 1 (census at f578af740). Copy `EASE`, `SPRING` and `TRANSITION` in `frontend/src/motion/tokens.ts`. Exceptions: ModalShell's `PANEL_IN` curve (owner-set, TK-31); the overshoot curves on the unread dot, map cards, the new-pane dot and the phone menu (MO-08 says which stay).

**Check.** `npm test -w frontend -- src/motion/tokens.test.ts src/motion/tokens.css.test.js`. Diff check `cubic-bezier\(|ease:\s*\[`: each hit imports `EASE` or `SPRING`, writes the exact `EASE.out` value in CSS, or is a TK-31 constant.

### TK-31 Owner-decided component timings

**Rule.** When you touch one of these surfaces, keep its named constants. The values and usage rules live in motion.md (MO-20 to MO-23) and transitions.md, and this table only says where each constant lives, so the two docs can't drift. A new owner-set timing lives as a named constant next to its one user, or in `frontend/src/motion/tokens.ts` when more than one module uses it.

| Surface | Named constants (where) | Values and usage | Owner |
|---|---|---|---|
| phone send with the on-screen keyboard up: keyboard dismissal, composer collapse, thread scroll compensation | `KEYBOARD_MOVE` (`frontend/src/motion/tokens.ts`); without the keyboard, `SEND_GLIDE` (`frontend/src/components/terminal/sendScroll.ts`) and the composer's `--t-enter` settle | MO-22 | c:kx, c:lf |
| ⌘K palette (`ModalShell` `motion="enter"`) | `SCRIM_IN`, `PANEL_IN` (`frontend/src/components/ui/ModalShell.tsx`); `frontend/src/components/terminal/CommandPalette.tsx` | MO-20, TR-07 | c:9m |
| Settings and other standard modals | `PANEL_VARIANTS` (`frontend/src/components/ui/ModalShell.tsx`), `TRANSITION.exit` | MO-20, TR-06 | c:9m |
| Home first load | `--home-card-index` and `.home-page[data-arriving]` (`frontend/src/components/terminal/home/homeCards.css`); `HOME_ARRIVAL_MS` (`frontend/src/components/terminal/pages/Home.tsx`) | MO-23, TR-30 | m:65v1, c:1fy |
| sidebar row chevron | the same › rotated 90° in `frontend/src/components/terminal/ThreadRow.tsx` and `frontend/src/components/terminal/BranchRow.tsx` | MO-05 (chevron row), TR-19 | c:14q |
| ⌘J panel | none yet: `AssistantPanel` was deleted, and ⌘J toggles the Companion panel with no open or close motion (`frontend/src/components/terminal/companion/CompanionPanel.tsx`, `frontend/src/components/terminal/companion/companion.css`) | MO-21, TR-25 | c:9o |

**Sources.** [OWNER c:lf] (in Chinese, translated: go with option A (the owner's first option): keyboard, composer and scroll on one 350ms curve; recorded: desktop sends, and phone sends with the keyboard down, are unchanged) · [OWNER c:9m] (recorded decision: the agent's description of the behaviour the owner kept) (in Chinese, translated: ⌘K closes with no animation) · [OWNER m:65v1] (in Chinese, translated: Home: loading and loaded layouts match, no jump, content arrives with a transition) · [OWNER c:14q] (in Chinese, translated: the owner flagged the ⋯ and chevron placement; recorded outcome: the same › rotates 90° with a transition) · [OWNER c:9o] (in Chinese, translated: make it rise and slide in) · [CODE] `frontend/src/motion/tokens.ts` `KEYBOARD_MOVE`: "so the screen moves one way at once instead of the thread rising while the page falls" · [EK] "this easing is just not made for UI animations" (on ease-in) · **Conflict:** Emil calls ease-in "not made for UI animations", yet the ⌘J close accelerates; ⌘K's curve is not an `EASE` token. **Choice:** the owner's values. **Why:** owner decisions bind.

**Michi today.** Present: `KEYBOARD_MOVE` (2 uses), the ModalShell constants, the Home arrival. Missing: the ⌘J motion, the gap MO-21 and TR-25 also record.

**Check.** `npm test -w frontend -- src/components/terminal/ComposerShell.test.tsx src/components/ui/ModalShell.test.tsx src/components/ui/ModalShell.enter.test.tsx src/components/terminal/pages/Home.test.tsx`.

### TK-32 Timings outside the tables

**Rule.** When a timing is in no table above, name it. A value several modules share goes into `frontend/src/motion/tokens.ts` with a one-line purpose (like `LINE_MOTION`); a value one module needs is a named constant at the top of that module (like `PUSH_MS` in `frontend/src/components/terminal/branchMotion.ts`); never a bare number at the call site. When a literal means a token, use the token (MO-04): 120ms is `--t-brief` / `DUR.brief`, 80ms `--t-dismiss` / `DUR.dismiss`, 220ms `--t-move` / `DUR.move`, 160ms `--t-collapse` / `DUR.collapse`, 140ms `--t-scrim-exit` / `DUR.scrimExit`, 180ms `--t-enter` / `DUR.enter`. A named constant that times motion with one of these values takes it from the token (`MENU_IN_MS`, `PANE_ENTER_MS` and the others MO-04 lists, written as `DUR.brief * 1000` and the like); a timer that only waits (a buffer, a debounce, a hold) is a dwell and keeps its own named constant.

**Sources.** [CODE] `frontend/src/motion/tokens.ts`: "Loops (shimmer, spinners, breathing dots, carets) stay in CSS; these are for enter/exit, layout and disclosure transitions." · [CODE] `frontend/eslint.config.mjs`: "Use a motion token: var(--t-quick|soft|enter|decay|slow) or var(--t-loop-fast|loop|loop-slow)." · [LIN] "replace hardcoded visual values with shared variables for colors, typography, shadows, animation, cursors, and thin borders" · [OWNER] decision 2026-11-14 (MO-Q1): add tokens in both CSS and JS, and give 160 ms and 140 ms a CSS version too

**Michi today.** Off-token values (census at f578af740): 120ms ×24 (13 JS literals, 4 constants, 7 CSS), 220ms ×12, 200ms ×7, 160ms written as a literal ×8, 140ms ×6, 80ms ×6. All of them but the 200ms ones have a token now (TK-29), which the code doesn't have yet. Copy `frontend/src/components/terminal/paneMotion.ts` (`PANE_ENTER_MS`, `PANE_EXIT_MS`, `PANE_EASE`) and `LINE_MOTION` in `frontend/src/motion/tokens.ts`.

**Check.** Diff check `\b(duration|delay|visualDuration):\s*0?\.\d+|\b(duration|delay):\s*\d{2,}\b|setTimeout\([^,]+,\s*\d{2,}`: it prints nothing outside named-constant definitions (in `frontend/src/motion/tokens.ts`, or declared at the top of a module); a hit at a call site fails.

### TK-33 Phone size tokens (`--pt-*`)

**Rule.** On a phone (the `frontend/src/components/terminal/mobile.css` breakpoint: `max-width: 700px`, or a coarse pointer with `max-height: 500px`), `html[data-phone-text]` (small / medium / large) defines the `--pt-*` sizes and re-maps `--fs-*`:
- When a phone surface takes the place of a desktop size pref (Message size, Composer size, sidebar density) or sits in the top bar, its size comes from `--pt-*`, read through the variable it feeds (`--message-body-size`, `--composer-body-size`, `--msg-meta-size`, `--sb-fs`, `--sb-ts-fs`, `--topbar-title-size`), never a px value.
- All other phone text uses `--fs-*`, which the medium and large presets re-map and phone drawers step up; px literals follow neither.
- `--pt-*` exist only inside the phone media query; outside it, read them with the desktop fallback, `var(--pt-tab, var(--fs-2xs))`, as `frontend/src/components/terminal/rail/rail.css` does.
- Text fields on touch are ≥16px (TK-10).

| Phone size | Token (small / medium / large) | Fed through |
|---|---|---|
| message body | `--pt-body` 15 / 16 / 18 | `--message-body-size(-base)` on `body` |
| composer text | `--pt-composer` 16 / 16 / 18 | `--composer-body-size` |
| top-bar and pane-switcher titles | `--pt-title` 15 / 16 / 17 | `--topbar-title-size`, `.mobile-pane-title` |
| drawer row titles | `--pt-row` 15 / 16 / 17 | `--sb-fs` in the overlay sidebar |
| secondary text: message meta, row times | `--pt-sub` 11 / 12 / 13 | `--msg-meta-size`, `--sb-ts-fs` |
| rail tab labels | `--pt-tab` 10 / 11 / 12 | `frontend/src/components/terminal/rail/rail.css` |
| top-bar icons | `--pt-icon` 17 / 18 / 20 | the workspace toolbar trigger, the Companion button |
| pane-switcher glyph | `--pt-switch` 19 / 20 / 22 | `.mobile-pane-trigger svg` |

**Sources.** [OWNER c:fi] (in Chinese, translated: phone small / medium / large changes the whole interface, independent of the desktop sizes) · [OWNER m:6yv1] (in Chinese, translated: the four top-bar icons share one size) · [CODE] `frontend/src/components/terminal/mobile.css`: "On a phone these replace the desktop's Message size, Composer size and sidebar text sizes." · [CODE] `frontend/src/components/terminal/mobile.css`: "'m' and 'l' also step up the chrome type scale, so every phone page grows with them." · [WIG] "`<input>` font size is ≥ 16px on mobile to prevent iOS Safari auto-zoom/pan on focus."

**Michi today.** `--pt-*` readers (census at f578af740): body 2, composer 1, title 2, row 1, sub 2, tab 1, icon 2, switch 1; all in `frontend/src/components/terminal/mobile.css` except `--pt-tab` in `frontend/src/components/terminal/rail/rail.css`. Copy the phone text-size block in `frontend/src/components/terminal/mobile.css`. Exceptions: the phone Home heading's `clamp(28px, …, 38px)` and its −.045em tracking (`frontend/src/components/terminal/mobile.css`).

**Check.** `npm run test:e2e -- e2e/specs/phone-drawer-type.spec.ts`. Devtools at 390px wide: switch Settings › Appearance › Text size through Small / Medium / Large (`phoneTextSize` s / m / l); every phone text and the top-bar icons grow, and nothing clips. TK-10's px diff check covers phone blocks too.

### TK-34 Prose colours

**Rule.**
- Every Markdown surface takes one set of prose colours, the transcript's: body text and list items `--term-fg`; list markers (bullets and counters) `--term-mid`; headings, bold and inline code `--term-fg`; quotes `--term-mid`; links `var(--term-accent-text)` (TK-06). That covers the transcript, file previews, run, subagent and multi-model results, Pages text blocks, the Branches document, the row drawer, the Digest page and pane, and Export. Thinking blocks keep `thoughtProseVars` (`frontend/src/components/terminal/MessageBlock.tsx`), and inline Markdown inside plain text keeps `INHERIT_PROSE_STYLE` (`frontend/src/components/markdownProse.ts`); both take the surrounding colour.
- Render Markdown through a helper that carries the set, and never restate `--tw-prose-*` or prose text classes by hand: `resultProseVars` (`frontend/src/components/terminal/resultProseVars.ts`) where a style object fits, `TERM_PROSE_CLASS` with `MESSAGE_PROSE_STYLE` (`frontend/src/components/markdownProse.ts`) where classes do.
- Gap: `--tw-prose-links` in `cssVarsFor()` passes the palette default (`p.accent`), and every link site passes `var(--term-accent)`.

**Sources.** [CODE] `frontend/src/components/terminal/resultProseVars.ts`: "Palette colours for an agent's or a run's Markdown result. Each MarkdownContent passes them itself" · [CODE] `frontend/src/components/markdownProse.ts`: "Typography's own --tw-prose-* colours win over index.css's remap, so paragraphs, list items, bold, links, inline code and h1-h4 are restated here." · [OWNER m:49v1] (in Chinese, translated: michi:// links in the accent colour) · [OWNER] decision 2026-11-14 (TK-Q9): every prose surface reads like the chat, bright body text with list markers one step dimmer · [OWNER] decision 2026-11-14 (TK-Q1): add an accent text colour that mixes a little toward the foreground until it reaches 4.5:1; links take it (TK-06) · [WCAG 1.4.3] "The visual presentation of text and images of text has a contrast ratio of at least 4.5:1" · **Conflict:** results, Pages text and the documents chose the quieter `--term-mid` body on purpose (`resultProseVars`, `TERM_PROSE_CLASS`). **Choice:** the `--term-fg` body and `--term-mid` markers everywhere. **Why:** the owner's decision; both tones pass 1.4.3 (`--term-fg` ≥7:1 and `--term-mid` ≥4.5:1 on bg, surface and alt by test), so it is a reading choice, not a contrast fix.

**Michi today.** (census at f578af740)

| Part | Transcript (`frontend/src/components/terminal/MessageBlock.tsx`), file preview (`frontend/src/components/terminal/FilePane.tsx`) | Results (`resultProseVars`, 6 call sites) | Pages text, Branches, row drawer (`TERM_PROSE_CLASS`, 3 call sites) | Digest page and pane, Export (`DIGEST_PROSE` ×2, `PANEL_PROSE`) | `cssVarsFor()` default |
|---|---|---|---|---|---|
| body | `--term-fg` | `--term-mid` | `--term-mid` | `--term-mid` | `p.fg` |
| list markers | `--term-mid` | `--term-muted` | unset: the typography plugin's own grey | unset | — |
| headings, bold, code | `--term-fg` | `--term-fg` | `--term-fg` | `--term-fg` (Digest leaves code unset) | `p.fg` |
| links | `var(--term-accent)` | `var(--term-accent)` | `var(--term-accent)` | `var(--term-accent)` | `p.accent`, the palette default |

The transcript's and the file preview's objects (`frontend/src/components/terminal/MessageBlock.tsx`, `frontend/src/components/terminal/FilePane.tsx`) restate the same colours by hand, and so do three class sets the helpers never reached: `DIGEST_PROSE` in `frontend/src/components/terminal/DigestPane.tsx` and again in `frontend/src/components/terminal/pages/Digest.tsx`, and `PANEL_PROSE` in `frontend/src/components/ExportPanel.tsx`. Moving: the body from mid to fg in `resultProseVars`, `TERM_PROSE_CLASS` (`[&_p]`, `[&_li]`), `MESSAGE_PROSE_STYLE` (`color`), `DIGEST_PROSE` and `PANEL_PROSE`; the markers to mid (from muted in `resultProseVars`, from unset in the class sets); every link to `--term-accent-text`.

**Check.** `rg -l -g '!*.test.*' -e "--tw-prose-[a-z]+['\"]?\s*:" frontend/src` lists no file beyond the five that set the colours today: `frontend/src/index.css`, `frontend/src/components/terminal/tokens.ts`, `frontend/src/components/terminal/resultProseVars.ts`, `frontend/src/components/terminal/FilePane.tsx` and `frontend/src/components/terminal/MessageBlock.tsx`. `rg -nP -g '!*.test.*' -e "--tw-prose-body'?+\s*+:\s*+'?+(?!var\(--term-fg\)|var\(--fg\)|inherit|p\.fg)" -e "--tw-prose-(bullets|counters)'?+\s*+:\s*+'?+(?!var\(--term-mid\))" -e '\[&_(p|li)\]:text-\(--term-(?!fg\))' frontend/src` prints nothing (at f578af740 it prints seven lines: `resultProseVars` ×3, `TERM_PROSE_CLASS`, `PANEL_PROSE` and both `DIGEST_PROSE`), and `MESSAGE_PROSE_STYLE` sets `color: 'var(--term-fg)'`. `rg -nP -g '!*.test.*' -e "--tw-prose-links'?+\s*+:\s*+'?+var\(--term-accent\)" -e '\[&_a\]:text-\(--term-accent\)' frontend/src` prints nothing (at f578af740 it prints nine lines). Diff check `--tw-prose-` prints nothing: new surfaces reuse a helper.

### TK-35 File-type badges take palette hues

**Rule.** When a file or a link shows a type badge (the WorkspaceManage resource list, `frontend/src/components/terminal/manage/ContextList.tsx`), its label takes a palette text token and its badge that hue's opaque soft fill, chosen by the family the type belongs to. No fixed hex, and no seventh family: a new type joins one of these.

| Types (today's hex) | Label | Badge fill |
|---|---|---|
| md, sh, and types with no colour of their own: txt, doc, unknown (`#5a544a`) | `--term-mid` | `--term-alt2` |
| pdf, rs, rb (`#a8261a`) and html, htm, xml (`#a8451f`) | `--term-danger-text` | `--term-danger-f` |
| csv, tsv, xls, xlsx, py (`#2f6b4e`) | `--term-digest` | `--term-digest-f` |
| ts, tsx, go and links, `url` (`#0b6cb6`) | `--term-accent-text` | `--term-accent-f` |
| js, jsx, json, yaml, yml, toml (`#a08300`) | `--term-waiting-text` | `--term-waiting-f` |
| images (`#6d4aa8`) | `--term-mauve` | `--term-mauve-f` |

The rust of html, htm and xml sits beside pdf's red and joins it, so seven hexes map onto six hues. Every pair measures ≥4.64:1 in all four palettes and with any picked accent; the lowest are Bone's accent text on `--term-accent-f` (4.65:1, 4.64 with clay picked) and Gruvbox's `--term-mid` on `--term-alt2` (4.66:1) (computed). Because the fills are opaque, the row's hover and selection fills never reach the label's ground.

**Sources.** [OWNER] decision 2026-11-14 (TK-Q7): the file-type labels switch to the palette's colours and follow the palette · [WCAG 1.4.3] "The visual presentation of text and images of text has a contrast ratio of at least 4.5:1" · [CODE] `frontend/src/components/terminal/manage/tokens.ts`: "These DO NOT enter the global token system." · [CODE] `frontend/src/components/terminal/manage/tokens.ts` (`MANAGE_COLORS`): "Link/URL badge color." · [OWNER] decision 2026-11-14 (TK-Q1): add an accent text colour that mixes a little toward the foreground until it reaches 4.5:1 · **Conflict:** the mock behind the decision drew each label on an 8% tint of its own hue, as the badge does today. Over the row's hover (`--term-alt`) and selection (accent 14%) fills, that tint fails in all four palettes, down to 4.23:1 (Bone), 4.19:1 (Slate), 3.16:1 (Monokai) and 3.50:1 (Gruvbox), and mauve misses 4.5:1 even at rest on Monokai's and Gruvbox's surfaces (4.26 / 4.35:1) (computed). **Choice:** the hue's opaque soft fill. **Why:** it keeps the tinted badge the owner chose and passes in every palette and row state; but for `--term-mid` on `--term-alt2`, the pairs are the ones TK-05 and TK-06 already use for words on a hue's fill.

**Michi today.** `FILETYPE_COLOR` and `MANAGE_COLORS.link` (`frontend/src/components/terminal/manage/tokens.ts`): 34 literals in 7 hexes, which `frontend/src/components/terminal/manage/ContextList.tsx` draws as the label colour on its own `${color}15` tint (8%). On the dark palettes' surfaces the labels measure 1.8–3.8:1 (1.7–3.4 on their chips), and the js/json amber 3.7:1 on the light ones (computed). Pinned today: waiting text on its fill (`frontend/src/components/terminal/tokens.test.ts`); the other five pairs are not.

**Check.** `npm test -w frontend -- src/components/terminal/tokens.test.ts`, with a case for the six label and fill pairs in every palette, the accent pair over `ACCENT_HUES`. `rg -n '#[0-9a-fA-F]{6}' frontend/src/components/terminal/manage/tokens.ts` prints nothing (at f578af740 it prints 13 lines: `MANAGE_COLORS`, `FILETYPE_COLOR` and the fallback in `manageFileType`). Devtools: hover and select a row in Monokai and Gruvbox; every badge label still measures ≥4.5:1.

## Open questions

None — all were decided on 2026-11-14 (Decided questions). The last one, TK-Q14, which motion.md MO-Q12 raised, was decided in chat that day.

TK-Q2 is a retired ID, kept so references resolve: it was merged into states.md ST-Q1 (how the derived `--focus-ring` lifts a picked accent), decided on 2026-11-14 (ST-07, TK-28). Its figures are the ones in TK-28's table: under 3:1 on every Bone ground, on Slate's `--term-alt` (2.97), and on Gruvbox's surface (2.87) and alt (2.59).

## Decided questions

| ID | Decision (2026-11-14) | Rules |
|---|---|---|
| TK-Q1 | (a) Add an accent text colour that, where the accent falls short, mixes a little toward the foreground until it reaches 4.5:1, the way `--term-danger-text` works; chips stay accent-coloured and every hue stays selectable. `--term-accent-text` (`accentTextFor()`, 5% steps) clears bg, surface, alt, `--term-accent-f` and the 12% and 18% chip tints, and every accent word uses it. | TK-06, TK-02, TK-15, TK-34, TK-35; also states.md ST-01, ST-07, ST-18, ST-34; motion.md MO-13 |
| TK-Q3 | (b) `--ui-radius` (4px by default), the radius most used by cards today (5 of 21): every in-flow card or box that is neither a chat frame nor paper. The branch hover card floats and keeps `--ui-radius-lg`. | TK-22, TK-20, TK-21 |
| TK-Q4 | (a) On phones, round together with the composer (8px by default): the shell notice and its tab, the branch anchors list and the interrupted-task list join the composer family; desktop stays square. | TK-20 |
| TK-Q5 | (c) On the dark palettes, a light red fill with red words: `--term-danger-f` with `--term-danger-text` (5.47 / 5.16:1), hovering at danger 14% → `--term-surface`, through `--term-danger-btn-*`; Bone and Slate keep the solid fill. | TK-04, TK-08; also states.md ST-01, ST-07, ST-16, ST-35 |
| TK-Q6 | (b) All green: a finished run's mark, its nodes and its segments take `--term-digest` on every surface; steps inside a turn keep the quiet dot. | TK-05; also states.md ST-19 |
| TK-Q7 | (a) The file-type labels switch to the palette's colours and follow the palette: each type family takes a text token on that hue's opaque soft fill. The workspace badge half moved to TK-Q13, decided (b) the same day. | TK-35, TK-02 |
| TK-Q8 | (b) Every inline code chip takes the prose chip's fill, currentColor 12%: in messages, the composer and Export too. | TK-08, TK-03 |
| TK-Q9 | (a) Every prose surface reads like the chat: body text in `--term-fg`, list markers one step dimmer in `--term-mid`. | TK-34 |
| TK-Q10 | (a) Take the nearest step by role: 26 and 32px → 28 (`--fs-5xl`), 20 → 22 (`--fs-4xl`), 16.5 → 16 (`--fs-2xl`), 15 → 14 (`--fs-xl`); no document steps. | TK-10 |
| TK-Q11 | (b) All eleven literal-radius cards and boxes take `--ui-radius`. | TK-22 |
| TK-Q12 | (b) Drop the paper cards' resting shadows and keep only the 1px `--term-line` edge. | TK-24, TK-08 |
| TK-Q13 | (b) The workspace badge's initial is decorative (the workspace name sits beside it): mark it `aria-hidden`; the badge keeps its white initial and its look. Decided in chat on 2026-11-14. | TK-02 |
| TK-Q14 | (a) Remove Settings › Appearance › Advanced › Glass blur and Glass saturation: their prefs (`glassBlur`, `glassSaturate`: type fields, defaults, storage scopes, normalization and the effect that writes the variables), the tokens `--term-glass-blur` and `--term-glass-saturate` with the sidebar `backdrop-filter` that reads them, their Settings rows and their search entries. Sidebar glass (`sidebarTranslucency`) and Sidebar material (`sidebarVibrancy`) stay, and Glass defaults resets only those two. It follows motion.md MO-Q12 (c): with the phone drawer opaque, nothing reads the two tokens. Decided in chat on 2026-11-14. | TK-25, TK-01; also motion.md MO-16; transitions.md TR-24 |

Related questions owned by other docs, all decided on 2026-11-14, recorded there and followed here: states.md ST-Q1 and ST-Q3 (the derived `--focus-ring`, and the 1px rings moving to it: TK-28, TK-06), ST-Q2 and ST-Q4 (the ghost press step and the selected pill tab: TK-07), ST-Q6 (the empty-state icon: TK-10, TK-19); motion.md MO-Q1 (the five duration tokens: TK-29, TK-32), MO-Q3 (literal overshoot curves: TK-30), MO-Q4 (the replaced loops: TK-29), MO-Q12 (opaque moving phone surfaces: TK-09, TK-25) and MO-Q13 (the caption veil and edit mode's opacity: TK-27).

## Sources

| Tag | Title | URL |
|---|---|---|
| [EK] | 7 Practical Animation Tips | https://emilkowal.ski/ui/7-practical-animation-tips |
| [EK] | 7 Practical Animation Tips: 4. Choose the right easing | https://emilkowal.ski/ui/7-practical-animation-tips#4.-choose-the-right-easing |
| [EK] | Train Your Judgement | https://emilkowal.ski/ui/train-your-judgement |
| [EK] | Agents with Taste (typography rules) | https://emilkowal.ski/ui/agents-with-taste#transferring-taste |
| [EK] | Sonner styles.css (pinned) | https://github.com/emilkowalski/sonner/blob/8e4662b/src/styles.css |
| [RF] | Web Interface Guidelines (interfaces) | https://github.com/raunofreiberg/interfaces |
| [RF] | Devouring Details system layout (ghost button) | https://devouringdetails.com/_next/static/chunks/app/system/layout-024dc9614a741589.js |
| [RF] | Devouring Details button styles (disabled state) | https://devouringdetails.com/_next/static/css/e2132223cd60efdf.css |
| [RF] | Devouring Details dialog source (nested radius) | https://devouringdetails.com/_next/static/chunks/9302-0cdbb084b4fb5d40.js |
| [RF] | Devouring Details: Behind the scenes (bespoke iconography) | https://devouringdetails.com/resources/behind-scenes#bespoke-iconography |
| [RF] | Vercel: Visual Rhythm | https://rauno.me/craft/vercel#visual-rhythm |
| [WIG] | Web Interface Guidelines | https://vercel.com/design/guidelines |
| [HIG] | Typography: Ensuring legibility | https://developer.apple.com/design/human-interface-guidelines/typography#Ensuring-legibility |
| [HIG] | Typography: macOS built-in text styles | https://developer.apple.com/design/human-interface-guidelines/typography#macOS-built-in-text-styles |
| [HIG] | Color: System colors | https://developer.apple.com/design/human-interface-guidelines/color#System-colors |
| [HIG] | Dark Mode: Dark Mode colors | https://developer.apple.com/design/human-interface-guidelines/dark-mode#Dark-Mode-colors |
| [HIG] | Dark Mode: iOS, iPadOS | https://developer.apple.com/design/human-interface-guidelines/dark-mode#iOS-iPadOS |
| [HIG] | Materials: Liquid Glass | https://developer.apple.com/design/human-interface-guidelines/materials#Liquid-Glass |
| [HIG] | Meet Liquid Glass (WWDC25) | https://developer.apple.com/videos/play/wwdc2025/219/ |
| [HIG] | WWDC25 session 356 (concentric shapes, capsules) | https://developer.apple.com/videos/play/wwdc2025/356/ |
| [HIG] | Pointing devices: Customizing pointers | https://developer.apple.com/design/human-interface-guidelines/pointing-devices#Customizing-pointers |
| [HIG] | Focus and selection: Best practices | https://developer.apple.com/design/human-interface-guidelines/focus-and-selection#Best-practices |
| [HIG] | Accessibility: Mobility | https://developer.apple.com/design/human-interface-guidelines/accessibility#Mobility |
| [HIG] | Split views: macOS | https://developer.apple.com/design/human-interface-guidelines/split-views#macOS |
| [HIG] | Animate with springs (WWDC23) | https://developer.apple.com/videos/play/wwdc2023/10158/ |
| [HIG] | SwiftUI monospacedDigit() | https://developer.apple.com/documentation/swiftui/view/monospaceddigit() |
| [M3] | Design tokens overview | https://m3.material.io/foundations/design-tokens/overview |
| [M3] | State layers | https://m3.material.io/foundations/interaction/states/state-layers |
| [M3] | Compose FilledButtonTokens (disabled opacities) | https://raw.githubusercontent.com/androidx/androidx/androidx-main/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens/FilledButtonTokens.kt |
| [M3] | Applying elevation (shadows, scrims) | https://m3.material.io/styles/elevation/applying-elevation |
| [M3] | Corner radius scale | https://m3.material.io/styles/shape/corner-radius-scale |
| [M3] | Type scale tokens | https://m3.material.io/styles/typography/type-scale-tokens |
| [M3] | Applying type (line height, tabular numbers) | https://m3.material.io/styles/typography/applying-type |
| [M3] | Spacing overview | https://m3.material.io/styles/spacing/overview |
| [M3] | Motion overview: how it works (spring tokens) | https://m3.material.io/styles/motion/overview/how-it-works |
| [M3] | Easing and duration: tokens and specs (extra-long durations) | https://m3.material.io/styles/motion/easing-and-duration/tokens-specs#ee9dbe95-70fa-4804-8347-c4fd58c60fe2 |
| [M3] | Compose MotionTokens (durations) | https://raw.githubusercontent.com/androidx/androidx/androidx-main/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens/MotionTokens.kt |
| [M3] | Divider guidelines | https://m3.material.io/components/divider/guidelines |
| [WCAG 1.4.3] | Contrast (Minimum) | https://www.w3.org/TR/WCAG22/#contrast-minimum |
| [WCAG 1.4.3] | Understanding Contrast (Minimum) | https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html |
| [WCAG 1.4.11] | Non-text Contrast | https://www.w3.org/TR/WCAG22/#non-text-contrast |
| [WCAG 1.4.11] | Understanding Non-text Contrast | https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html |
| [WCAG 1.4.12] | Text Spacing | https://www.w3.org/TR/WCAG22/#text-spacing |
| [WCAG 2.2.2] | Pause, Stop, Hide | https://www.w3.org/TR/WCAG22/#pause-stop-hide |
| [WCAG 2.4.7] | Focus Visible | https://www.w3.org/TR/WCAG22/#focus-visible |
| [WCAG 2.5.8] | Target Size (Minimum) | https://www.w3.org/TR/WCAG22/#target-size-minimum |
| [RUI] | 7 Practical Tips for Cheating at Design | https://medium.com/refactoring-ui/7-practical-tips-for-cheating-at-design-40c736799886 |
| [RUI] | Redesigning Laravel.io | https://medium.com/refactoring-ui/redesigning-laravel-io-c47ac495dff0 |
| [RUI] | Building Your Color Palette (preview) | https://refactoringui.com/previews/building-your-color-palette |
| [RUI] | Line-height is proportional (preview) | https://refactoringui.com/previews/line-height-is-proportional |
| [RUI] | The Little Details of UI Design (slides) | https://speakerdeck.com/steveschoger/the-little-details-of-ui-design |
| [LIN] | Styling Linear for the future: StyleX | https://linear.app/now/styling-linear-for-the-future-stylex#enforcing-stylex-at-scale |
| [LIN] | How we redesigned the Linear UI | https://linear.app/now/how-we-redesigned-the-linear-ui#2.-appearance |
| [LIN] | Changelog, 2022-10-19: New Linear interface theme | https://linear.app/changelog/page/12#new-linear-interface-theme |
| [LIN] | Behind the latest design refresh | https://linear.app/now/behind-the-latest-design-refresh#structure-should-be-felt-not-seen |
| [CODE] | Michi source repository | https://github.com/michiworks/Michi |
| [OWNER] | Michi Memory: owner decisions and conversations, cited by ref (m:…, c:…); the owner's 2026-11-14 review of the design-polish mock, cited by question (TK-Q1 and TK-Q3 to TK-Q12 here; ST-Q1 to ST-Q4, ST-Q6, MO-Q1, MO-Q3, MO-Q4, MO-Q12 and MO-Q13 from the other docs), and the owner's replies in chat the same day (TK-Q13 and TK-Q14) | Michi Memory (this workspace); the Decided questions tables |
