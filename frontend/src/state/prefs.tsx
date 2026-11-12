import React, { createContext, use, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { PALETTES, type TerminalPalette } from '../components/terminal/tokens';
import { fetchPrefs, savePrefs } from '../services/api';
// The level PUT lives with the other prefs calls (W3-F3-review #2): tests that keep a provider
// mounted mock this module, and the shared test setup answers its path for those that do not.
import { putChatNotificationLevel, savePermissionSettings, type ChatNotificationLevelWrite } from '../services/api/prefs';
import { setAttentionPreferences } from '../services/attention/policy';
import {
  isChatNotificationLevel,
  isChatPermissionMode,
  SERVER_PREF_KEYS,
  VIBRANCY_MATERIALS,
  type ChatNotificationLevel,
  type ChatPermissionSettings,
  type ChatPermissionMode,
  type ServerPrefKey,
} from 'michi-shared';
import type { VibrancyMaterial } from '../lib/electronBridge';
import { SIDEBAR_ROW_STYLES, type SidebarRowStyle } from '../components/terminal/sidebarRowStyle';
import { normalizePaneWidthMode, type PaneWidthMode } from './paneLayout';
import { normalizePaneMotion, type PaneMotion } from '../components/terminal/paneMotion';

export type { SidebarRowStyle };
export type { PaneWidthMode };
export type { TerminalPalette };

export type TerminalDensity = 'comfortable' | 'compact' | 'dense';
/** Vertical density of the LEFT SIDEBAR's rows only. Independent of
 *  `terminalDensity` (which governs message/pane spacing) so the tree can
 *  breathe without loosening chat messages. */
export type SidebarDensity = 'compact' | 'comfortable' | 'airy';

/** Sidebar lens mode: hierarchical tree ('structure') or time-grouped
 *  activity feed ('activity'). */
export type SidebarView = 'structure' | 'activity';

/** Assistant code-block chrome. Two design variants:
 *  - 'hairline' (01): no header bar - language sits as a faint mono overline,
 *    copy reveals on hover, recessed paper fill. Quietest.
 *  - 'header'   (02): classic terminal - divider bar with a lowercase
 *    language label. */
export type CodeBlockStyle = 'hairline' | 'header';

/** Agent block chrome (thinking / tool calls / subagents):
 *  - 'line'     (W2, default): one 28px disclosure line per run, outcome
 *    first ("Merged origin/dev  read 3 files…"), hanging type icon; the same
 *    box live and settled (AgentLineBlocks.tsx).
 *  From the 2026-08 "Agent Blocks Redesign" exploration:
 *  - 'plain'    (1a): bare text rows, ▸/▾ glyphs, 5px dots — the baseline.
 *  - 'card'     (1b): hairline square-corner cards with type icons and a
 *    right-hand status column (✓ / spinner / FAILED).
 *  - 'terminal' (1d): bare text with ❯/✓/× glyph columns, tracking-caps
 *    section headers, dotted leaders; only payloads/subagents get boxes. */
export type AgentBlockStyle = 'line' | 'plain' | 'card' | 'terminal';

const AGENT_BLOCK_STYLES: ReadonlySet<string> = new Set<AgentBlockStyle>(['line', 'plain', 'card', 'terminal']);

const DEFAULT_AGENT_BLOCK_STYLE: AgentBlockStyle = 'line';
/** Revision 2 made 'line' the default in place of 'card'. */
export const AGENT_BLOCK_STYLE_REVISION = 2;

/**
 * The saved agent-block style, migrated once. Settings had no picker when
 * revision 2 shipped, so a 'card' saved before it is the old default rather
 * than a choice: it becomes 'line'. The revision is saved alongside, so a
 * later explicit 'card' (Settings › Appearance › Advanced has a picker again)
 * stays. 'terminal' and 'plain' are kept; anything invalid gets the default.
 */
export function migrateAgentBlockStyle(saved: { agentBlockStyle?: unknown; agentBlockStyleRevision?: unknown }): {
  agentBlockStyle: AgentBlockStyle;
  agentBlockStyleRevision: number;
} {
  const style = typeof saved.agentBlockStyle === 'string' && AGENT_BLOCK_STYLES.has(saved.agentBlockStyle)
    ? saved.agentBlockStyle as AgentBlockStyle
    : DEFAULT_AGENT_BLOCK_STYLE;
  const current = typeof saved.agentBlockStyleRevision === 'number' && saved.agentBlockStyleRevision >= AGENT_BLOCK_STYLE_REVISION;
  return {
    agentBlockStyle: !current && style === 'card' ? 'line' : style,
    agentBlockStyleRevision: AGENT_BLOCK_STYLE_REVISION,
  };
}

/** UI font presets the user can A/B test. Each preset resolves to a full
 *  CSS font-family stack in the effect that sets `--ui-font`. Order matches
 *  the picker order in Settings → Interface font. */
export type UiFont = 'IBM Plex Sans' | 'Inter' | 'Geist';

export const UI_FONT_OPTS: readonly UiFont[] = [
  'Geist',
  'IBM Plex Sans',
  'Inter',
] as const;

/** Message body Latin-font presets. Each resolves to a `--message-latin-font`
 *  stack plus a paired `--message-code-font` (for message code blocks) in the
 *  effect below. CJK glyphs are unaffected — they always render in the
 *  `--message-cjk-font` (PingFang) tail appended by the .terminal-message CSS. */
export type MessageFont = 'Source Serif 4' | 'Geist';

/** Phone text size preset (小 / 中 / 大). Read only by the phone layout,
 *  where it replaces messageFontSize, composerFontSize and the sidebar's
 *  text sizes; mobile.css maps it to sizes through html[data-phone-text]. */
export type PhoneTextSize = 's' | 'm' | 'l';

const PHONE_TEXT_SIZE_OPTS: readonly PhoneTextSize[] = ['s', 'm', 'l'] as const;

export interface Prefs {
  /** Show Pages recommendations and custom content on Home. */
  homeRecommendations: boolean;
  linkOpenTarget: 'internal' | 'external';
  fontFamily: 'sans' | 'serif' | 'mono';
  /** When true, show the agent's streamed reasoning (agent_thought_chunk) + execution plan inside the assistant message. */
  showThoughts: boolean;
  terminalPalette: TerminalPalette;
  /** Per-palette accent override. Missing key → palette's built-in accent.
   *  Resolve via `resolveAccent(prefs, palette)` from `tokens.ts`. */
  terminalAccentOverrides: Partial<Record<TerminalPalette, string>>;
  /** Interface font — every UI element (sidebar, tabs, dialogs, buttons, kbd
   *  hints, badges, code blocks). Drives --ui-font. Message bodies are
   *  controlled separately by the .terminal-message CSS scope. */
  uiFont: UiFont;
  /** Message body Latin font — assistant prose + user bubble. Drives
   *  --message-latin-font and --message-code-font. CJK stays PingFang. */
  messageFont: MessageFont;
  /** Body text size for chat messages (user + assistant). Drives --message-body-size. */
  messageFontSize: number;
  /** Font size for the composer input area. Drives --composer-body-size. */
  composerFontSize: number;
  /** Phone-only text size preset; independent of the desktop sizes above. */
  phoneTextSize: PhoneTextSize;
  /** Assistant code-block chrome. Drives the `data-code-block` attribute on
   *  <html>; the visual treatment lives in index.css (`.michi-code-*`). */
  codeBlockStyle: CodeBlockStyle;
  /** Agent block chrome (thinking / tool calls / subagents). Read via
   *  `useAgentBlockStyle()` so components render 'plain' outside a
   *  PrefsProvider (tests, isolated mounts). */
  agentBlockStyle: AgentBlockStyle;
  /** Migration marker for `agentBlockStyle` (migrateAgentBlockStyle). */
  agentBlockStyleRevision: number;
  /** When true, long lines inside assistant code/text blocks wrap at the
   *  container edge instead of horizontally scrolling. Drives the
   *  `data-code-wrap` attribute on <html>; the wrap CSS lives in index.css.
   *  Default off (preserves the scroll behaviour). */
  codeWrap: boolean;
  terminalDensity: TerminalDensity;
  /** When true, draw a 1px hairline between panes (and between caption-row
   *  cells in the topbar). Off = panes butt up against each other with no
   *  visible seam. */
  paneRules: boolean;
  /** Width of the terminal shell's left sidebar, in CSS pixels. Resizable via drag handle. */
  terminalSidebarWidth: number;
  /** Dragged widths of drawers and side columns, in CSS pixels, by the key
   *  each passes to usePanelWidth. A panel with no entry uses its own
   *  default width. */
  panelWidths: Partial<Record<string, number>>;
  /** Row density of the left sidebar (workspace / thread / branch rows + bottom
   *  nav). Drives the `--sb-*` CSS vars (row padding, font size, workspace group
   *  gap, timestamp size) set on the sidebar root in Sidebar.tsx. */
  sidebarDensity: SidebarDensity;
  /** Horizontal gutter (px) between the sidebar's content and its left/right
   *  edges. Added on top of each row's own padding via the `--sb-inset` CSS
   *  var (0 = current flush look). Honoured by `sidebarRowStyle: 'classic'`
   *  only — the three card modes pin their own inset so switching between
   *  them is a controlled comparison of the corners alone. */
  sidebarInset: number;
  /** Shape of the sidebar's thread/branch rows. `classic` is the historical
   *  full-bleed row with a left accent bar; the other three are the "direction
   *  B" card treatment (state lives on the container, not the text) and differ
   *  only in corner radius + fill width. See sidebarRowStyle.ts. */
  sidebarRowStyle: SidebarRowStyle;
  /** When true, show the relative "last active" timestamp (e.g. "3h", "2d")
   *  on each thread row in the sidebar. Default off to keep rows uncluttered. */
  showSidebarTimestamps: boolean;
  /** Sidebar glass translucency, 0–100. 0 = solid surface (opaque), 100 = maximally
   *  see-through. Under macOS window vibrancy this sets how much the desktop shows
   *  through; without vibrancy it just controls the CSS-glass tint. Drives
   *  --term-sidebar-translucency (a 0..1 alpha) on <html>. */
  sidebarTranslucency: number;
  /** Sidebar glass blur radius in px (0–40). Drives --term-glass-blur. Overlays
   *  use their own fixed frost (--term-overlay-* in index.css). */
  glassBlur: number;
  /** Sidebar glass backdrop saturation in % (100–220). Drives
   *  --term-glass-saturate. */
  glassSaturate: number;
  /** Corner radius in px (0–12, default 4) for floating surfaces (menus,
   *  modals, popovers, toasts) and controls. Drives --ui-radius, plus
   *  --ui-radius-sm (half, for rows/buttons/tooltips inside those surfaces)
   *  and --ui-radius-lg (double, for cards, tables and tab pills). */
  cornerRadius: number;
  /** Sidebar's native macOS vibrancy material (Electron+macOS only). Lightest →
   *  densest: under-window < sidebar < menu < hud. Applied via
   *  window.electron.setVibrancy; ignored on web / Windows / Linux. */
  sidebarVibrancy: VibrancyMaterial;
  /** Window glass (Electron+macOS only): native vibrancy shows the desktop
   *  through the sidebar. Off makes the window opaque, which stops drawers, ⌘K
   *  and Settings from vanishing for a frame while agents run. Applied via
   *  window.electron.setWindowGlass; ignored elsewhere. */
  windowGlass: boolean;
  /** When true, the docked terminal sidebar is hidden and a hover popover replaces it.
   *  Toggled via ⌘B and the topbar icon. */
  sidebarCollapsed: boolean;
  /** Sidebar lens mode. 'structure' = traditional tree hierarchy,
   *  'activity' = time-grouped flat list (Now / Today / Yesterday).
   *  Toggled via ⌥⌘U and the Structure/Activity tabs. */
  sidebarView: SidebarView;
  /** Days a soft-deleted node stays in the trash before being purged. 0 = never auto-purge. */
  trashTTLDays: number;
  /** How much to dim unfocused panes. 0 = no dimming, 100 = maximum dimming. */
  focusDim: number;
  /** Height in px of the soft fade at the top of each pane where content scrolls into the title area. 0 disables. */
  paneTopFadeHeight: number;
  /**
   * When to show OS/toast notifications. 'all' = needs input + finished + failed,
   * 'approval-only' = only when an agent needs input (approvals, questions), 'off' = none.
   * The backend gets it too, to notify by it while no Michi window is open (DESIGN-v2 §5.2).
   */
  notifications: ChatNotificationLevel;
  /** Play a short synthesized tone when a notification is shown: one for
   *  "needs input", another for "finished". */
  notificationSounds: boolean;
  /** Pane entrance/exit style, including quiet fades and frozen-content retraction. */
  paneSpawnAnimation: PaneMotion;
  /** Default width (px) for new dashboard panes that have no explicit width set. */
  defaultPaneWidth: number;
  /** Width policy for two or more panes; custom per-pane widths take precedence. */
  paneWidthMode: PaneWidthMode;
  /** Maximum content column width when only one pane is open. null = full width. */
  singlePaneContentWidth: number | null;
  /** Browser-style single page: the active tree's panes open as topbar tabs
   *  and only the focused one is shown. Browser panes stay in the dock. */
  singlePageMode: boolean;
  /** Digest feature switch. Off hides every Digest entry point (thread Digest
   *  page, ⌘D / ⇧⌘D, Map and sidebar actions, the Manage tab); existing digest
   *  nodes and their data are kept and come back when it is turned on. */
  digestEnabled: boolean;
  /** How many lines of quoted text to show in the composer's quote bar before clamping. 1 = single-line ellipsis. */
  quoteMaxLines: number;
  /** When true, run a separate Kiro prompt to title untitled chats while the main turn is active. */
  enableKiroSidecarTitles: boolean;
  /** When true, ask kiro to end every reply by calling set_follow_ups. Disable to skip the 2-5s tail latency when you don't use follow-up suggestions. */
  enableFollowUps: boolean;
  /** When true, suppress all UI motion (drawer slide-ins, pane animations,
   *  scroll-to-view). Acts as an app-level override on top of the OS-level
   *  `prefers-reduced-motion` media query. Default false. */
  reduceMotion: boolean;
  /** Shared backend permission setting. Per-chat choices live on durable nodes. */
  globalPermissions: boolean;
  permissionMode: ChatPermissionMode;
  /** Approve for me on top of the global Ask (Kiro V3). Mirrors the Backend. */
  permissionApproveForMe: boolean;
  /** Number of unpinned threads to show per workspace before "Show more".
   *  Must be ≥1. Default 5. */
  sidebarThreadLimit: number;
  /** Sparse maps of user-toggled expand state. Missing keys fall back to defaults
   *  computed by sidebarSelectors. Persists across sessions via the existing
   *  500ms debounce. */
  sidebarExpanded: {
    workspaces: Record<string, boolean>;
    threads: Record<string, boolean>;
    branches: Record<string, boolean>;
    /** Sidebar groups that are not a workspace, thread or branch (By project's
     *  Earlier group). Optional: older saved prefs have no such map. */
    groups?: Record<string, boolean>;
  };
  /** Sparse user-defined sidebar order for live workspaces. Project IDs not
   *  present here render first, sorted by createdAt DESC. IDs present here
   *  render after, in array order. Stale IDs (deleted/archived projects)
   *  are ignored at sort time, not pruned eagerly. */
  workspaceOrder: string[];
  /** Epoch ms when the user finished (or was migrated past) the first-run
   *  runtime/model setup. null = never completed → FirstRunSetup shows on a
   *  fresh install with no workspaces. Existing users (any workspace) are
   *  auto-migrated to "done" so upgrades don't pop the wizard. */
  onboardingCompletedAt: number | null;
}

export const DEFAULT_PREFS: Prefs = {
  homeRecommendations: true,
  linkOpenTarget: 'internal',
  fontFamily: 'sans',
  showThoughts: true,
  terminalPalette: 'slate',
  terminalAccentOverrides: {},
  uiFont: 'Geist',
  messageFont: 'Geist',
  messageFontSize: 16,
  composerFontSize: 14.5,
  phoneTextSize: 's',
  codeBlockStyle: 'hairline',
  agentBlockStyle: DEFAULT_AGENT_BLOCK_STYLE,
  agentBlockStyleRevision: AGENT_BLOCK_STYLE_REVISION,
  codeWrap: false,
  terminalDensity: 'compact',
  paneRules: true,
  terminalSidebarWidth: 252,
  panelWidths: {},
  sidebarDensity: 'comfortable',
  sidebarInset: 2,
  sidebarRowStyle: 'square-full',
  showSidebarTimestamps: false,
  sidebarTranslucency: 60,
  glassBlur: 10,
  glassSaturate: 130,
  cornerRadius: 4,
  sidebarVibrancy: 'under-window',
  windowGlass: true,
  sidebarCollapsed: false,
  sidebarView: 'structure',
  trashTTLDays: 30,
  focusDim: 20,
  paneTopFadeHeight: 30,
  notifications: 'all',
  notificationSounds: true,
  defaultPaneWidth: 600,
  paneWidthMode: 'half',
  paneSpawnAnimation: 'soft-fade',
  singlePaneContentWidth: 676,
  singlePageMode: false,
  digestEnabled: false,
  quoteMaxLines: 2,
  enableKiroSidecarTitles: false,
  enableFollowUps: true,
  reduceMotion: false,
  globalPermissions: false,
  permissionMode: 'ask',
  permissionApproveForMe: false,
  sidebarExpanded: { workspaces: {}, threads: {}, branches: {} },
  sidebarThreadLimit: 5,
  workspaceOrder: [],
  onboardingCompletedAt: null,
};

/**
 * Where each pref is kept; a new pref does not compile until it picks one.
 * 'server': the backend's config.json (SERVER_PREF_KEYS), which every
 * browser takes when it loads, its own copy only caching them: what
 * Settings shows, unless it is meant per device. 'local': this browser
 * only. 'permissions': the backend's permission settings, which /prefs
 * reports and /permissions/settings writes.
 * @testonly
 */
export const PREF_STORAGE = {
  homeRecommendations: 'server',
  linkOpenTarget: 'server',
  fontFamily: 'local',
  showThoughts: 'local',
  terminalPalette: 'server',
  terminalAccentOverrides: 'server',
  uiFont: 'server',
  messageFont: 'server',
  messageFontSize: 'server',
  composerFontSize: 'server',
  phoneTextSize: 'server',
  codeBlockStyle: 'server',
  agentBlockStyle: 'local',
  agentBlockStyleRevision: 'local',
  codeWrap: 'server',
  terminalDensity: 'server',
  paneRules: 'server',
  terminalSidebarWidth: 'local',
  panelWidths: 'local',
  sidebarDensity: 'server',
  sidebarInset: 'server',
  sidebarRowStyle: 'server',
  showSidebarTimestamps: 'server',
  sidebarTranslucency: 'local',
  glassBlur: 'local',
  glassSaturate: 'local',
  cornerRadius: 'server',
  sidebarVibrancy: 'local',
  // Applied to this machine's macOS window; main also keeps it in userData.
  windowGlass: 'local',
  sidebarCollapsed: 'local',
  sidebarView: 'local',
  // A policy over the backend's data: the trash sweep deletes for good by it.
  trashTTLDays: 'server',
  focusDim: 'server',
  paneTopFadeHeight: 'local',
  notifications: 'server',
  notificationSounds: 'server',
  paneSpawnAnimation: 'server',
  defaultPaneWidth: 'server',
  paneWidthMode: 'server',
  singlePaneContentWidth: 'server',
  // Changes which panes a window shows, and the phone hides its switch.
  singlePageMode: 'local',
  digestEnabled: 'server',
  quoteMaxLines: 'local',
  enableKiroSidecarTitles: 'server',
  enableFollowUps: 'server',
  // Per device, like the OS reduced-motion setting it adds to.
  reduceMotion: 'local',
  globalPermissions: 'permissions',
  permissionMode: 'permissions',
  permissionApproveForMe: 'permissions',
  sidebarThreadLimit: 'local',
  sidebarExpanded: 'local',
  workspaceOrder: 'local',
  onboardingCompletedAt: 'local',
} as const satisfies Record<keyof Prefs, 'server' | 'local' | 'permissions'>;

export function normalizeKiroSidecarTitlesPreference(value: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_PREFS.enableKiroSidecarTitles;
}

export const CORNER_RADIUS_MAX = 12;

export function normalizeCornerRadius(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_PREFS.cornerRadius;
  return Math.min(CORNER_RADIUS_MAX, Math.max(0, Math.round(value)));
}

/** Pref → the three radius tokens. Inner shapes use half the outer radius so
 *  rows and buttons stay visibly nested inside their surface at any setting;
 *  larger containers use double. Pills and dots use --ui-radius-pill and
 *  never follow this pref. */
export function cornerRadiusVars(
  radius: number,
): { '--ui-radius': string; '--ui-radius-sm': string; '--ui-radius-lg': string } {
  const r = normalizeCornerRadius(radius);
  return { '--ui-radius': `${r}px`, '--ui-radius-sm': `${Math.round(r / 2)}px`, '--ui-radius-lg': `${r * 2}px` };
}

// Every dragged panel clamps to more than 160px; anything outside this range is not a drag.
const PANEL_MIN_STORED = 160;
const PANEL_MAX_STORED = 4000;
const isPanelLength = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= PANEL_MIN_STORED && value <= PANEL_MAX_STORED;

/** Keeps only lengths in range, so a bad entry falls back to the panel's default. */
function normalizePanelWidths(value: unknown): Partial<Record<string, number>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Partial<Record<string, number>> = {};
  for (const [key, width] of Object.entries(value)) if (isPanelLength(width)) out[key] = width;
  return out;
}

/** Also read by the first-frame script in index.html. */
export const PREFS_KEY = 'michi:v1:prefs';
const VALID_PALETTES: ReadonlySet<TerminalPalette> = new Set([
  'bone',
  'slate',
  'monokai',
  'gruvbox',
]);

const MESSAGE_FONT_OPTS: readonly MessageFont[] = ['Source Serif 4', 'Geist'];
const TERMINAL_DENSITIES: readonly TerminalDensity[] = ['comfortable', 'compact', 'dense'];
const NOTIFICATION_LEVELS: readonly Prefs['notifications'][] = ['all', 'approval-only', 'off'];

type PermissionPrefs = Pick<Prefs, 'globalPermissions' | 'permissionMode' | 'permissionApproveForMe'>;

/** Permission fields of stored or backend prefs; the former bypass flag means global Trust. */
function normalizePermissionPrefs(raw: Record<string, unknown>): PermissionPrefs {
  const permissionMode = isChatPermissionMode(raw.permissionMode) ? raw.permissionMode : raw.bypassPermissions === true ? 'trust' : 'ask';
  return {
    globalPermissions: typeof raw.globalPermissions === 'boolean' ? raw.globalPermissions : raw.bypassPermissions === true,
    permissionMode,
    permissionApproveForMe: permissionMode === 'ask' && raw.permissionApproveForMe === true,
  };
}

/**
 * Stored preferences, this browser's or the backend's, as Prefs: legacy
 * fields migrated, out-of-range or unknown values replaced by their
 * defaults. PrefsProvider renders outside the app's error boundary, so a
 * value the UI cannot render must not get through.
 */
function normalizePrefs(parsed: Record<string, any>): Prefs {
  const merged = { ...DEFAULT_PREFS, ...parsed, ...normalizePermissionPrefs(parsed) };
  merged.homeRecommendations = typeof parsed.homeRecommendations === 'boolean' ? parsed.homeRecommendations : DEFAULT_PREFS.homeRecommendations;
  delete (merged as { bypassPermissions?: unknown }).bypassPermissions;
  merged.linkOpenTarget = merged.linkOpenTarget === 'external' ? 'external' : 'internal';
  merged.paneWidthMode = normalizePaneWidthMode(merged.paneWidthMode);
  merged.paneSpawnAnimation = normalizePaneMotion(merged.paneSpawnAnimation);
  delete (merged as { theme?: string }).theme;
  if (!VALID_PALETTES.has(merged.terminalPalette)) {
    merged.terminalPalette = DEFAULT_PREFS.terminalPalette;
  }
  // Migrate legacy single `terminalAccent` field into per-palette overrides.
  if (
    !merged.terminalAccentOverrides ||
    typeof merged.terminalAccentOverrides !== 'object'
  ) {
    merged.terminalAccentOverrides = {};
  }
  if (typeof parsed.terminalAccent === 'string') {
    const paletteDefault = PALETTES[merged.terminalPalette as TerminalPalette].accent;
    if (parsed.terminalAccent !== paletteDefault) {
      merged.terminalAccentOverrides = {
        ...merged.terminalAccentOverrides,
        [merged.terminalPalette]: parsed.terminalAccent,
      };
    }
  }
  delete (merged as { terminalAccent?: string }).terminalAccent;
  // Drop legacy mono/prose font fields (replaced by uiFont).
  delete (merged as { terminalMonoFont?: string }).terminalMonoFont;
  delete (merged as { terminalProseFont?: string }).terminalProseFont;
  // Migrate legacy terminalRules object into the flat paneRules boolean.
  // Old shape: { panes, treeRows, ascii } — only `panes` survives.
  if (parsed.terminalRules && typeof parsed.terminalRules === 'object') {
    if (typeof parsed.terminalRules.panes === 'boolean') {
      merged.paneRules = parsed.terminalRules.panes;
    }
  }
  delete (merged as { terminalRules?: unknown }).terminalRules;
  // Drop legacy userBubbleStyle picker (the variant explorations are gone;
  // D is now the only user-bubble treatment, hardcoded in CSS).
  delete (merged as { userBubbleStyle?: unknown }).userBubbleStyle;
  if (!UI_FONT_OPTS.includes(merged.uiFont as UiFont)) merged.uiFont = DEFAULT_PREFS.uiFont;
  if (!MESSAGE_FONT_OPTS.includes(merged.messageFont)) merged.messageFont = DEFAULT_PREFS.messageFont;
  if (!TERMINAL_DENSITIES.includes(merged.terminalDensity)) merged.terminalDensity = DEFAULT_PREFS.terminalDensity;
  if (!NOTIFICATION_LEVELS.includes(merged.notifications)) merged.notifications = DEFAULT_PREFS.notifications;
  if (typeof merged.messageFontSize !== 'number' || merged.messageFontSize < 11 || merged.messageFontSize > 28) {
    merged.messageFontSize = DEFAULT_PREFS.messageFontSize;
  }
  if (typeof merged.composerFontSize !== 'number' || merged.composerFontSize < 11 || merged.composerFontSize > 28) {
    merged.composerFontSize = DEFAULT_PREFS.composerFontSize;
  }
  if (!PHONE_TEXT_SIZE_OPTS.includes(merged.phoneTextSize as PhoneTextSize)) {
    merged.phoneTextSize = DEFAULT_PREFS.phoneTextSize;
  }
  if (merged.codeBlockStyle !== 'hairline' && merged.codeBlockStyle !== 'header') {
    merged.codeBlockStyle = DEFAULT_PREFS.codeBlockStyle;
  }
  Object.assign(merged, migrateAgentBlockStyle(parsed));
  if (typeof merged.codeWrap !== 'boolean') {
    merged.codeWrap = DEFAULT_PREFS.codeWrap;
  }
  merged.enableKiroSidecarTitles = normalizeKiroSidecarTitlesPreference(
    merged.enableKiroSidecarTitles,
  );
  if (typeof merged.paneTopFadeHeight !== 'number' || merged.paneTopFadeHeight < 0 || merged.paneTopFadeHeight > 80) {
    merged.paneTopFadeHeight = DEFAULT_PREFS.paneTopFadeHeight;
  }
  if (typeof merged.sidebarTranslucency !== 'number' || merged.sidebarTranslucency < 0 || merged.sidebarTranslucency > 100) {
    merged.sidebarTranslucency = DEFAULT_PREFS.sidebarTranslucency;
  }
  if (typeof merged.glassBlur !== 'number' || merged.glassBlur < 0 || merged.glassBlur > 40) {
    merged.glassBlur = DEFAULT_PREFS.glassBlur;
  }
  if (typeof merged.glassSaturate !== 'number' || merged.glassSaturate < 100 || merged.glassSaturate > 220) {
    merged.glassSaturate = DEFAULT_PREFS.glassSaturate;
  }
  merged.cornerRadius = normalizeCornerRadius(merged.cornerRadius);
  if (!VIBRANCY_MATERIALS.includes(merged.sidebarVibrancy)) {
    merged.sidebarVibrancy = DEFAULT_PREFS.sidebarVibrancy;
  }
  if (typeof merged.windowGlass !== 'boolean') merged.windowGlass = DEFAULT_PREFS.windowGlass;
  if (
    merged.sidebarDensity !== 'compact' &&
    merged.sidebarDensity !== 'comfortable' &&
    merged.sidebarDensity !== 'airy'
  ) {
    merged.sidebarDensity = DEFAULT_PREFS.sidebarDensity;
  }
  if (typeof merged.sidebarInset !== 'number' || merged.sidebarInset < 0 || merged.sidebarInset > 24) {
    merged.sidebarInset = DEFAULT_PREFS.sidebarInset;
  }
  merged.panelWidths = normalizePanelWidths(merged.panelWidths);
  // Drop the floating ⌘J card's size: the docked Companion panel keeps its own width.
  delete (merged as { assistantPanelSize?: unknown }).assistantPanelSize;
  if (!SIDEBAR_ROW_STYLES.includes(merged.sidebarRowStyle)) {
    merged.sidebarRowStyle = DEFAULT_PREFS.sidebarRowStyle;
  }
  if (typeof merged.showSidebarTimestamps !== 'boolean') {
    merged.showSidebarTimestamps = DEFAULT_PREFS.showSidebarTimestamps;
  }
  if (typeof merged.reduceMotion !== 'boolean') {
    merged.reduceMotion = DEFAULT_PREFS.reduceMotion;
  }
  if (typeof merged.notificationSounds !== 'boolean') {
    merged.notificationSounds = DEFAULT_PREFS.notificationSounds;
  }
  if (typeof merged.singlePageMode !== 'boolean') {
    merged.singlePageMode = DEFAULT_PREFS.singlePageMode;
  }
  if (typeof merged.digestEnabled !== 'boolean') merged.digestEnabled = DEFAULT_PREFS.digestEnabled;
  if (
    merged.singlePaneContentWidth !== null &&
    merged.singlePaneContentWidth !== undefined &&
    (typeof merged.singlePaneContentWidth !== 'number' ||
      merged.singlePaneContentWidth < 480 ||
      merged.singlePaneContentWidth > 1280)
  ) {
    merged.singlePaneContentWidth = DEFAULT_PREFS.singlePaneContentWidth;
  }
  if (
    !merged.sidebarExpanded ||
    typeof merged.sidebarExpanded !== 'object' ||
    !merged.sidebarExpanded.workspaces ||
    !merged.sidebarExpanded.threads ||
    !merged.sidebarExpanded.branches
  ) {
    merged.sidebarExpanded = { workspaces: {}, threads: {}, branches: {} };
  }
  if (
    !Array.isArray(merged.workspaceOrder) ||
    !merged.workspaceOrder.every((id: unknown) => typeof id === 'string')
  ) {
    merged.workspaceOrder = [];
  }
  if (
    merged.onboardingCompletedAt !== null &&
    typeof merged.onboardingCompletedAt !== 'number'
  ) {
    merged.onboardingCompletedAt = DEFAULT_PREFS.onboardingCompletedAt;
  }
  return merged;
}

type ServerPrefs = Partial<Pick<Prefs, ServerPrefKey>>;

/** The server prefs of `prefs`, for the keys `held` accepts. */
function serverPrefsOf(prefs: Prefs, held: (key: ServerPrefKey) => boolean = () => true): ServerPrefs {
  return Object.fromEntries(SERVER_PREF_KEYS.filter(held).map((key) => [key, prefs[key]]));
}

// By value: a copy read from localStorage holds its own {} of accent overrides.
const samePref = (a: unknown, b: unknown) => Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);

/** The server prefs that differ from those the backend holds; null when none do. */
function unsavedServerPrefs(prefs: Prefs, saved: ServerPrefs): Record<string, unknown> | null {
  const keys = SERVER_PREF_KEYS.filter((key) => !(key in saved) || !samePref(saved[key], prefs[key]));
  return keys.length > 0 ? Object.fromEntries(keys.map((key) => [key, prefs[key]])) : null;
}

function readInitial(): Prefs {
  if (typeof window === 'undefined') return { ...DEFAULT_PREFS };
  const raw = window.localStorage.getItem(PREFS_KEY);
  if (!raw) return { ...DEFAULT_PREFS };
  try {
    return normalizePrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

// ── The chat notification level, as the backend keeps it (DESIGN-v2 §5.2) ──

/** After a write that did not get through, the next goes 2s later, the wait doubling to a minute. */
const CHAT_NOTIFICATION_LEVEL_RETRY_MIN_MS = 2_000;
const CHAT_NOTIFICATION_LEVEL_RETRY_MAX_MS = 60_000;

/**
 * Sends the level to the backend one write at a time, so the last level asked
 * for is the one it keeps (a slow write never lands after a newer one), and
 * nothing it already took is sent again. A write that did not get through is
 * tried again on a backoff timer while the provider is mounted (W3-F3-review
 * #3), and at once by retry() (the window regaining focus).
 */
function chatNotificationLevelSync(write: (level: ChatNotificationLevel) => Promise<ChatNotificationLevelWrite>) {
  let wanted: ChatNotificationLevel | null = null;
  let taken: ChatNotificationLevel | null = null;
  let writing = false;
  let failures = 0;
  let mounted = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  /** Times the next try of a write that did not get through (`again` is run). */
  const schedule = (again: () => void) => {
    if (!mounted || failures === 0 || writing || timer !== null) return;
    const wait = Math.min(CHAT_NOTIFICATION_LEVEL_RETRY_MAX_MS, CHAT_NOTIFICATION_LEVEL_RETRY_MIN_MS * 2 ** (failures - 1));
    timer = setTimeout(() => { timer = null; again(); }, wait);
  };
  const run = async (): Promise<void> => {
    if (writing) return;
    clearTimer();
    writing = true;
    try {
      while (wanted !== null && wanted !== taken) {
        const level = wanted;
        const result = await write(level);
        if (result === 'failed') {
          failures += 1;
          return;
        }
        failures = 0;
        // Saved, or a backend that will never take it: either way not sent again.
        taken = level;
      }
    } finally {
      writing = false;
      schedule(() => { void run(); });
    }
  };
  return {
    request(level: ChatNotificationLevel) { wanted = level; void run(); },
    retry() { if (failures > 0) void run(); },
    /** The provider mounted (again, under StrictMode): a pending retry is timed again. */
    start() { mounted = true; schedule(() => { void run(); }); },
    /** The provider unmounted: no timer outlives it. */
    stop() { mounted = false; clearTimer(); },
  };
}

/** How long the level settles (a backend hydration, a quick change of mind) before it is sent. */
const CHAT_NOTIFICATION_LEVEL_SYNC_MS = 500;

interface PrefsContextValue {
  prefs: Prefs;
  setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void;
  setPermissionSettings(settings: ChatPermissionSettings): Promise<void>;
  reset(): void;
  /** Reset only the terminal appearance fields to defaults. */
  resetTerminal(): void;
}

const PrefsContext = createContext<PrefsContextValue | null>(null);
// React 19 propagates an outer context change through nested providers of the
// same context, so sidebar contents read their shielded value from a separate one.
const SidebarContentPrefsContext = createContext<PrefsContextValue | null>(null);
// Every agent block reads its style. A context of that one value keeps other
// pref writes (a sidebar resize, a toggle) from re-rendering every block.
const AgentBlockStyleContext = createContext<AgentBlockStyle | null>(null);

/** Inside the sidebar shield, rows never subscribe to the outer prefs context. */
function usePrefsContext(): PrefsContextValue | null {
  return use(SidebarContentPrefsContext) ?? use(PrefsContext);
}

export function PrefsProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(readInitial);
  const hydratedFromBackend = useRef(false);
  const permissionWriteRevision = useRef(0);
  // Whether prefs.notifications is the user's level and may go to the backend (W3-F3-review #3):
  // this device had its own prefs, or the backend's were taken in, or the user picked one. Until
  // then the default would overwrite the level the backend keeps (an empty window whose /prefs
  // is slow or failed).
  const [levelKnown, setLevelKnown] = useState(false);
  // The backend's server prefs win; this browser's copy caches them and keeps its local prefs.
  const [hadLocal] = useState(() => typeof window !== 'undefined' && !!window.localStorage.getItem(PREFS_KEY));
  const initialPrefs = useRef(prefs).current;
  // GET /prefs: nothing goes to the backend before it answers.
  const [backendRead, setBackendRead] = useState<'pending' | 'read' | 'failed'>('pending');
  // Server prefs the backend holds, as far as this window knows; saves send the rest.
  const savedRef = useRef<ServerPrefs>({});

  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  // A browser without a copy keeps none until it has read the backend's or
  // something changes here, so the next load reads the backend's again.
  const keepLocalCopy = hadLocal || backendRead === 'read' || prefs !== initialPrefs;
  const keepLocalCopyRef = useRef(keepLocalCopy);
  keepLocalCopyRef.current = keepLocalCopy;

  // The read below runs once per provider, so a StrictMode effect cleanup cannot own its guard.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (hydratedFromBackend.current) return;
    hydratedFromBackend.current = true;
    const permissionRevision = permissionWriteRevision.current;
    fetchPrefs().then((remote) => {
      if (!mountedRef.current) return;
      // Once /prefs settled: this device's own level stands (DESIGN-v2 §5.2: the renderer's pref).
      if (hadLocal) setLevelKnown(true);
      // Unread (or overtaken by a permission change): send only what changes here.
      if (!remote || permissionRevision !== permissionWriteRevision.current) {
        savedRef.current = serverPrefsOf(initialPrefs);
        setBackendRead('failed');
        return;
      }
      const backend = normalizePrefs(remote);
      // A key the backend lacks counts as the default: this browser sends its
      // value only when it is not, so an untouched default does not become the
      // value every other browser takes.
      savedRef.current = serverPrefsOf(backend);
      setPrefs((prev) => {
        const read = hadLocal
          ? { ...prev, ...normalizePermissionPrefs(remote), ...serverPrefsOf(backend, (key) => key in remote) }
          : backend;
        // A change made here before the answer is newer than the backend's.
        const changedHere = Object.fromEntries(Object.entries(prev).filter(([key, value]) => !Object.is(value, initialPrefs[key as keyof Prefs])));
        return { ...read, ...changedHere };
      });
      setBackendRead('read');
      setLevelKnown(true);
    });
  }, [hadLocal, initialPrefs]);

  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      const revision = permissionWriteRevision.current;
      void fetchPrefs().then((remote) => {
        if (disposed || !remote || revision !== permissionWriteRevision.current) return;
        // An incomplete answer is not the backend's setting.
        if (typeof remote.globalPermissions !== 'boolean' || !isChatPermissionMode(remote.permissionMode)) return;
        const next = normalizePermissionPrefs(remote);
        setPrefs((prev) => prev.globalPermissions === next.globalPermissions && prev.permissionMode === next.permissionMode
          && prev.permissionApproveForMe === next.permissionApproveForMe ? prev : { ...prev, ...next });
      });
    };
    const onStorage = (event: StorageEvent) => { if (event.key === PREFS_KEY) refresh(); };
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', onStorage);
    return () => { disposed = true; window.removeEventListener('focus', refresh); window.removeEventListener('storage', onStorage); };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !keepLocalCopy) return;
    const handle = setTimeout(() => {
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      } catch (err) {
        console.warn('prefs persist failed:', err);
      }
      if (backendRead === 'pending') return;
      const unsaved = unsavedServerPrefs(prefs, savedRef.current);
      if (!unsaved) return;
      void savePrefs(unsaved).then((saved) => {
        if (saved) savedRef.current = { ...savedRef.current, ...unsaved };
      });
    }, 500);
    return () => clearTimeout(handle);
  }, [prefs, backendRead, keepLocalCopy]);

  // DESIGN-v2 §5.2: while no Michi window is open, the backend sends the approval, question and
  // reply notices this window would have, by this same level. It gets the level at start (once
  // known, see levelKnown) and on every change (W3: F3 → H); one that did not reach it goes again
  // on a backoff timer, and at once when the window is focused.
  const [levelSync] = useState(() => chatNotificationLevelSync(putChatNotificationLevel));
  useEffect(() => {
    const level = prefs.notifications;
    if (!levelKnown || !isChatNotificationLevel(level)) return undefined;
    const handle = setTimeout(() => levelSync.request(level), CHAT_NOTIFICATION_LEVEL_SYNC_MS);
    return () => clearTimeout(handle);
  }, [levelKnown, levelSync, prefs.notifications]);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    levelSync.start();
    const retry = () => levelSync.retry();
    window.addEventListener('focus', retry);
    return () => {
      window.removeEventListener('focus', retry);
      levelSync.stop();
    };
  }, [levelSync]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const flush = () => {
      if (!keepLocalCopyRef.current) return;
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefsRef.current));
      } catch { /* best-effort */ }
    };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    document.documentElement.setAttribute('data-terminal-palette', prefs.terminalPalette);
  }, [prefs.terminalPalette]);

  useEffect(() => {
    setAttentionPreferences({ level: prefs.notifications, sounds: prefs.notificationSounds });
  }, [prefs.notifications, prefs.notificationSounds]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    document.documentElement.style.setProperty('--message-body-size-base', `${prefs.messageFontSize}px`);
  }, [prefs.messageFontSize]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    document.documentElement.style.setProperty('--composer-body-size', `${prefs.composerFontSize}px`);
  }, [prefs.composerFontSize]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    document.documentElement.dataset.phoneText = prefs.phoneTextSize;
  }, [prefs.phoneTextSize]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // 0..100 pref → 0..1 alpha. This is the sidebar's SOLIDNESS: higher pref =
    // more see-through = LOWER surface alpha. index.css reads this for both the
    // CSS-glass path and the native-vibrancy tint so one slider drives both.
    const solidAlpha = (1 - prefs.sidebarTranslucency / 100).toFixed(3);
    document.documentElement.style.setProperty('--term-sidebar-solid-alpha', solidAlpha);
  }, [prefs.sidebarTranslucency]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // The sidebar's glass knobs. Overlays (.term-glass) use their own fixed frost.
    const s = document.documentElement.style;
    s.setProperty('--term-glass-blur', `${prefs.glassBlur}px`);
    s.setProperty('--term-glass-saturate', `${prefs.glassSaturate}%`);
  }, [prefs.glassBlur, prefs.glassSaturate]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const s = document.documentElement.style;
    for (const [name, value] of Object.entries(cornerRadiusVars(prefs.cornerRadius))) s.setProperty(name, value);
  }, [prefs.cornerRadius]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    document.documentElement.setAttribute('data-code-block', prefs.codeBlockStyle);
  }, [prefs.codeBlockStyle]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    document.documentElement.setAttribute('data-code-wrap', prefs.codeWrap ? 'on' : 'off');
  }, [prefs.codeWrap]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Resolve preset → full CSS font-family stack. Sans presets all share
    // the same `--ui-cjk-font` tail so CJK text renders identically across
    // them; only the Latin glyphs change. Mono preset has no CJK tail —
    // CJK in mono looks broken, so we drop it.
    // --cjk-alias (index.css, fonts.css) draws CJK at full size ahead of system-ui.
    const sansTail = `var(--cjk-alias), system-ui, -apple-system, sans-serif, var(--ui-cjk-font)`;
    const plexMono = `'IBM Plex Mono', var(--cjk-alias), Menlo, ui-monospace, monospace`;
    // Each preset declares both its UI stack and its paired mono stack.
    // Mono is used by code blocks, tool calls, tabular numbers — Geist
    // pairs with Geist Mono; the others fall back to IBM Plex Mono.
    const [stack, monoStack]: [string, string] = (() => {
      switch (prefs.uiFont) {
        case 'IBM Plex Sans':
          return [`'IBM Plex Sans', ${sansTail}`, plexMono];
        case 'Inter':
          return [`'Inter', ${sansTail}`, plexMono];
        // 'Geist', the default. PrefsProvider is outside the error boundary: never throw here.
        default:
          return [`'Geist', ${sansTail}`, `'Geist Mono', ${plexMono}`];
      }
    })();
    document.documentElement.style.setProperty('--ui-font', stack);
    document.documentElement.style.setProperty('--font-mono', monoStack);
  }, [prefs.uiFont]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Resolve the message-font preset → Latin body stack + paired code stack.
    // CJK is untouched: .terminal-message appends `, var(--message-cjk-font)`.
    // Code (inline + fenced blocks) is always monospace so diagrams/tables
    // stay aligned: 'Geist' pairs Geist Sans prose with Geist Mono; 'Source
    // Serif 4' pairs the serif body with IBM Plex Mono.
    const [latin, code]: [string, string] = (() => {
      switch (prefs.messageFont) {
        case 'Source Serif 4':
          return [
            `'Source Serif 4', Georgia, serif`,
            `'IBM Plex Mono', 'Fira Mono', ui-monospace, SFMono-Regular, Menlo, monospace`,
          ];
        // 'Geist', the default, as for the interface font.
        default:
          return [
            `'Geist', var(--cjk-alias), system-ui, -apple-system, sans-serif`,
            `'Geist Mono', var(--cjk-alias), 'IBM Plex Mono', Menlo, ui-monospace, monospace`,
          ];
      }
    })();
    document.documentElement.style.setProperty('--message-latin-font', latin);
    document.documentElement.style.setProperty('--message-code-font', code);
  }, [prefs.messageFont]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    document.documentElement.dataset.reduceMotion = prefs.reduceMotion ? 'on' : 'off';
  }, [prefs.reduceMotion]);

  const setPref = useCallback(<K extends keyof Prefs>(key: K, value: Prefs[K]) => {
    setPrefs((prev) => ({ ...prev, [key]: value }));
    if (key === 'notifications') setLevelKnown(true);
  }, []);

  const setPermissionSettings = useCallback(async (settings: ChatPermissionSettings) => {
    permissionWriteRevision.current += 1;
    const saved = await savePermissionSettings(settings).finally(() => { permissionWriteRevision.current += 1; });
    setPrefs((prev) => ({ ...prev, globalPermissions: saved.global, permissionMode: saved.mode, permissionApproveForMe: saved.mode === 'ask' && saved.approveForMe === true }));
  }, []);

  const reset = useCallback(() => {
    setPrefs((prev) => ({ ...DEFAULT_PREFS, globalPermissions: prev.globalPermissions, permissionMode: prev.permissionMode, permissionApproveForMe: prev.permissionApproveForMe }));
    // The user reset everything: the default level is now theirs.
    setLevelKnown(true);
  }, []);

  const resetTerminal = useCallback(() => {
    setPrefs((prev) => ({
      ...prev,
      terminalPalette: DEFAULT_PREFS.terminalPalette,
      terminalAccentOverrides: { ...DEFAULT_PREFS.terminalAccentOverrides },
      uiFont: DEFAULT_PREFS.uiFont,
      messageFont: DEFAULT_PREFS.messageFont,
      messageFontSize: DEFAULT_PREFS.messageFontSize,
      composerFontSize: DEFAULT_PREFS.composerFontSize,
      phoneTextSize: DEFAULT_PREFS.phoneTextSize,
      codeBlockStyle: DEFAULT_PREFS.codeBlockStyle,
      agentBlockStyle: DEFAULT_PREFS.agentBlockStyle,
      agentBlockStyleRevision: DEFAULT_PREFS.agentBlockStyleRevision,
      codeWrap: DEFAULT_PREFS.codeWrap,
      terminalDensity: DEFAULT_PREFS.terminalDensity,
      paneRules: DEFAULT_PREFS.paneRules,
      paneWidthMode: DEFAULT_PREFS.paneWidthMode,
      paneSpawnAnimation: DEFAULT_PREFS.paneSpawnAnimation,
      defaultPaneWidth: DEFAULT_PREFS.defaultPaneWidth,
      terminalSidebarWidth: DEFAULT_PREFS.terminalSidebarWidth,
      panelWidths: {},
      sidebarDensity: DEFAULT_PREFS.sidebarDensity,
      sidebarInset: DEFAULT_PREFS.sidebarInset,
      sidebarRowStyle: DEFAULT_PREFS.sidebarRowStyle,
      paneTopFadeHeight: DEFAULT_PREFS.paneTopFadeHeight,
      cornerRadius: DEFAULT_PREFS.cornerRadius,
      reduceMotion: DEFAULT_PREFS.reduceMotion,
    }));
  }, []);

  const value = useMemo(
    () => ({ prefs, setPref, setPermissionSettings, reset, resetTerminal }),
    [prefs, setPref, setPermissionSettings, reset, resetTerminal],
  );

  return (
    <PrefsContext.Provider value={value}>
      <AgentBlockStyleContext.Provider value={prefs.agentBlockStyle}>{children}</AgentBlockStyleContext.Provider>
    </PrefsContext.Provider>
  );
}

export function usePrefs(): PrefsContextValue {
  const v = usePrefsContext();
  if (!v) throw new Error('usePrefs must be used within a PrefsProvider');
  return v;
}

// The sidebar shell owns visibility. Its mounted contents always see an
// expanded sidebar, so toggling visibility does not invalidate every row.
const SidebarContentPrefs = React.memo(function SidebarContentPrefs({
  value,
  children,
}: {
  value: PrefsContextValue;
  children: React.ReactNode;
}) {
  const contentValue = useMemo(
    () => ({ ...value, prefs: { ...value.prefs, sidebarCollapsed: false } }),
    [value],
  );
  return <SidebarContentPrefsContext.Provider value={contentValue}>{children}</SidebarContentPrefsContext.Provider>;
}, (previous, next) => (
  previous.children === next.children &&
  previous.value.setPref === next.value.setPref &&
  previous.value.reset === next.value.reset &&
  previous.value.resetTerminal === next.value.resetTerminal &&
  (Object.keys(next.value.prefs) as (keyof Prefs)[]).every(
    (key) => key === 'sidebarCollapsed' || Object.is(previous.value.prefs[key], next.value.prefs[key]),
  )
));

export function SidebarContentPrefsProvider({ children }: { children: React.ReactNode }) {
  const value = usePrefs();
  return <SidebarContentPrefs value={value}>{children}</SidebarContentPrefs>;
}

/** Forces a specific agent-block style regardless of prefs — used by the dev
 *  specimen page to render every variant on one screen. */
export const AgentBlockStyleOverride = createContext<AgentBlockStyle | null>(null);

/** Active agent-block variant. Unlike usePrefs this never throws: outside a
 *  PrefsProvider (unit tests mounting ToolCallGroup / MessageBlock directly)
 *  it falls back to 'plain', keeping the baseline render path. */
export function useAgentBlockStyle(): AgentBlockStyle {
  const override = useContext(AgentBlockStyleOverride);
  const style = useContext(AgentBlockStyleContext);
  return override ?? style ?? 'plain';
}

/** A resizable drawer's or side column's saved width (e.g. for DrawerShell's
 *  `resize`). Null outside a PrefsProvider (isolated mounts): the panel keeps
 *  its fixed width. */
export function usePanelWidth(key: string): {
  width: number | undefined;
  set: (width: number) => void;
  reset: () => void;
} | null {
  const ctx = usePrefsContext();
  const widths = ctx?.prefs.panelWidths;
  const setPref = ctx?.setPref;
  const set = useCallback((width: number) => {
    setPref?.('panelWidths', { ...widths, [key]: Math.round(width) });
  }, [key, setPref, widths]);
  const reset = useCallback(() => {
    if (!widths || widths[key] === undefined) return;
    const rest = { ...widths };
    delete rest[key];
    setPref?.('panelWidths', rest);
  }, [key, setPref, widths]);
  return useMemo(() => (ctx ? { width: widths?.[key], set, reset } : null), [ctx, widths, key, set, reset]);
}

/** Home also supports isolated previews outside the app provider. */
export function useHomeRecommendations(): boolean {
  return usePrefsContext()?.prefs.homeRecommendations ?? DEFAULT_PREFS.homeRecommendations;
}

/** Digest entry points render only when the Settings switch is on; isolated
 *  renders outside the provider follow the default (off). */
export function useDigestEnabled(): boolean {
  return usePrefsContext()?.prefs.digestEnabled ?? DEFAULT_PREFS.digestEnabled;
}

/** Page components follow the active palette, including standalone previews. */
export function usePagePalette(): TerminalPalette {
  return usePrefsContext()?.prefs.terminalPalette ?? 'bone';
}
