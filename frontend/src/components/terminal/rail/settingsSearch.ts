import { DEFAULT_COMPANION_NAME } from 'michi-shared';
import { shortcutGroups } from '../pages/settings/ShortcutsPane';
import { HIDE_DOCK_LABEL, KEEP_RUNNING_LABEL, OPEN_AT_LOGIN_LABEL, TRAY_LABEL, WINDOWS_CLOSED_TITLE } from '../pages/settings/residencyCopy';
import { PAGES_UPKEEP_TITLE, settingsPageLabel, type SettingsPage } from './settingsPages';

/**
 * One setting the Settings window can find. `label` is the setting's name as
 * its page shows it, so a result can reveal it on that page; `keywords` hold
 * other words people search with (preference keys, option names).
 */
export interface SettingsSearchEntry {
  page: SettingsPage;
  /** The group heading the setting sits under on its page. */
  group?: string;
  label: string;
  description?: string;
  keywords?: readonly string[];
  /** Shown only where the window can be see-through (the macOS app's vibrancy). */
  vibrancy?: true;
}

const entries = (page: SettingsPage, group: string | undefined, items: ReadonlyArray<Omit<SettingsSearchEntry, 'page' | 'group'>>) =>
  items.map((item) => ({ page, group, ...item }));

/** Words people search Settings › <name> with: what it was called before v2, and the shortcut that opens it. */
const AGENT_WORDS = ['companion', 'assistant', '⌘j', 'cmd+j', 'check-in'] as const;
const UPKEEP_WORDS = ['meta agent', 'pages upkeep', 'maintenance'] as const;

/**
 * Every setting the window can find, with the agent's `name` where a page
 * shows it (its shortcuts). Settings › <name>'s entries hold no name, so the
 * same labels find their rows whatever it is called.
 */
export function settingsSearchIndex(name: string): SettingsSearchEntry[] {
  return [
    ...entries('runtime', 'Model', [
      { label: 'Runtime', description: 'Applies to new chats. Existing chats keep the runtime they started with.', keywords: ['claude', 'kiro', 'codex', 'pi', 'crew', 'agent'] },
      { label: 'Reasoning effort', description: 'Models that support it receive this preference.', keywords: ['thinking', 'effort', 'low', 'high', 'max'] },
      { label: 'Native Resume', description: 'Reopen chats in the runtime’s own session.', keywords: ['resume', 'session'] },
      { label: 'Native Fork', description: 'Branch chats in the runtime’s own session.', keywords: ['fork', 'branch', 'session'] },
    ]),
    ...entries('runtime', 'Web search', [{ label: 'Search provider', description: 'Searches run from the backend.', keywords: ['web', 'search', 'jina', 'api key'] }]),
    ...entries('runtime', 'Follow-ups', [{ label: 'Generate follow-up questions', keywords: ['suggestions', 'follow up'] }]),
    ...entries('runtime', 'Permissions', [
      { label: 'Use global permissions', description: 'One permission mode for all chats, or one per chat.', keywords: ['ask', 'trust', 'yolo', 'approve', 'approval'] },
    ]),
    ...entries('companion', 'Name', [
      { label: 'Name', description: 'What you call it on its button, in messages, notifications and Settings.', keywords: [...AGENT_WORDS, 'rename', 'display name'] },
    ]),
    ...entries('companion', 'Model', [
      { label: 'Runs on', description: 'The runtime and model of your conversation with it.', keywords: [...AGENT_WORDS, 'runtime', 'model'] },
      { label: 'Reasoning', description: 'Used by check-ins and new conversations.', keywords: [...AGENT_WORDS, 'thinking', 'effort', 'high', 'xhigh', 'max'] },
    ]),
    ...entries('companion', 'Watching', [
      { label: 'Watch and check in', description: 'Off: no checks, check-ins or notifications; the conversation still works.', keywords: [...AGENT_WORDS, 'proactive', 'watch', 'turn off'] },
      { label: 'Pause', description: 'Stop checks, check-ins and notifications until you resume.', keywords: [...AGENT_WORDS, 'resume', 'stop'] },
    ]),
    ...entries('companion', 'Check-ins', [
      { label: 'Check-ins', description: 'How often it looks over what changed.', keywords: [...AGENT_WORDS, 'heartbeat', 'interval'] },
      { label: 'Morning brief', description: 'A short brief of what matters today.', keywords: [...AGENT_WORDS, 'brief', 'daily', 'pulse'] },
      { label: 'Daily turn budget', keywords: [...AGENT_WORDS, 'limit', 'cost'] },
    ]),
    ...entries('companion', 'Notifications', [
      { label: 'Notifications', description: 'What it notifies you about on its own: posts, the brief and Today.', keywords: [...AGENT_WORDS, 'alerts', 'important'] },
      { label: 'Quiet hours', description: 'No notifications and no check-ins.', keywords: [...AGENT_WORDS, 'do not disturb', 'night'] },
      { label: 'Workdays', keywords: [...AGENT_WORDS, 'weekend'] },
    ]),
    ...entries('companion', undefined, [
      { label: 'Your rules', description: 'What it must always follow.', keywords: [...AGENT_WORDS, 'instructions', 'rules'] },
      { label: 'Notes', description: 'Its own notes; edit, keep or clear them.', keywords: [...AGENT_WORDS, 'memory', 'notes'] },
      { label: 'Goals', description: 'What you are working toward.', keywords: [...AGENT_WORDS, 'goals', 'progress'] },
      { label: 'Activity', description: 'Every check-in, what it changed, and Undo.', keywords: [...AGENT_WORDS, 'log', 'history', 'undo', 'follow-ups', 'ask before sending'] },
      { label: 'New conversation', description: 'Start over; this conversation moves to History.', keywords: [...AGENT_WORDS, 'reset', 'start over'] },
    ]),
    ...entries('companion', PAGES_UPKEEP_TITLE, [
      { label: PAGES_UPKEEP_TITLE, description: 'Keeps your workspace homes and the Pages Home up to date.', keywords: [...AGENT_WORDS, ...UPKEEP_WORDS] },
      { label: 'Follow global settings', description: 'Pages upkeep uses the global runtime and model.', keywords: [...UPKEEP_WORDS, 'runtime', 'custom'] },
      { label: 'Background updates', description: 'Checks every workspace for new conversations every 60 seconds.', keywords: [...UPKEEP_WORDS, 'pause'] },
      { label: 'First run', description: 'How far back Pages upkeep reads a workspace the first time.', keywords: [...UPKEEP_WORDS, 'days', 'history'] },
      { label: 'Workspace homes', description: 'Keeps each workspace’s home page up to date.', keywords: [...UPKEEP_WORDS, 'pages', 'home page'] },
      { label: 'Pages home', description: 'Keeps the overview on the Pages Home up to date.', keywords: [...UPKEEP_WORDS, 'overview'] },
    ]),
    ...entries('memory', 'Memory', [
      { label: 'Use memory', description: 'On or off. Michi remembers what you tell it.', keywords: ['remember', 'memories', 'forget', 'automatic memory', 'turn off'] },
      { label: 'Delete all memories', description: 'Every saved memory and About the user. Conversations stay.', keywords: ['reset', 'clear', 'erase', 'forget everything'] },
    ]),
    ...entries('memory', undefined, [
      { label: 'About the user', description: 'The summary Michi writes from its memories of you, and the memories behind each line.', keywords: ['profile', 'summary', 'rebuild'] },
      { label: 'Saved memories', description: 'Search, edit, delete or change the scope of what agents remember.', keywords: ['remember', 'preferences', 'conventions', 'forget', 'global', 'workspace', 'imported'] },
    ]),
    ...entries('skills', undefined, [
      { label: 'Library', description: 'Create, edit, rename, turn off or delete your own skills.',
        keywords: ['skill', 'SKILL.md', 'slash', 'commands', 'new skill', 'instructions', 'enabled'] },
      { label: 'Runtime skills', description: 'The skills each runtime finds on its own, read only.', keywords: ['skill', 'plugin', 'project skills'] },
    ]),
    ...entries('machines', 'Connected machines', [
      { label: 'Connected machines', description: 'Work locally or connect a remote machine.', keywords: ['remote', 'ssh', 'devdesktop', 'dev desktop', 'server', 'connect remote', 'tunnel'] },
    ]),
    ...entries('machines', 'Phone access', [
      { label: 'Phone access', description: 'Open this machine’s Michi on your phone.', keywords: ['mobile', 'qr', 'tunnel', 'sign-in link', 'connect phone'] },
    ]),
    ...entries('appearance', 'Theme', [
      { label: 'Palette', description: 'Bone, Slate, Monokai or Gruvbox.', keywords: ['theme', 'dark', 'light', 'bone', 'slate', 'monokai', 'gruvbox', 'color', 'theme.palette'] },
      { label: 'Accent', description: 'The highlight color of the current palette.', keywords: ['accent hue', 'color', 'colour', 'rust', 'theme.accent'] },
    ]),
    ...entries('appearance', 'Reading', [
      { label: 'Density', description: 'Row height and spacing in the sidebar.', keywords: ['sidebar density', 'compact', 'comfortable', 'airy', 'theme.sidebarDensity'] },
      { label: 'Text size', description: 'Message text, in pixels.', keywords: ['font size', 'message size', 'bigger', 'smaller', 'theme.messageFontSize'] },
    ]),
    ...entries('appearance', 'Panes', [
      { label: 'Dim unfocused panes', description: 'Lowers the other panes when two or more are open.', keywords: ['dim', 'focus dimming', 'unfocused', 'panes', 'theme.focusDim'] },
      { label: 'Single-page mode', description: 'One pane at a time; the thread’s other panes become tabs.', keywords: ['tabs', 'panes', 'layout.singlePage'] },
      { label: 'Reduce motion', description: 'Turns off drawer slides and pane transitions.', keywords: ['animation', 'motion', 'a11y.reduceMotion', 'accessibility'] },
    ]),
    ...entries('appearance', 'Home', [
      { label: 'Pages recommendations', description: 'Pages recommendations or your custom Home page with the composer.', keywords: ['home', 'recommendations', 'suggestions', 'composer'] },
    ]),
    ...entries('appearance', 'Features', [
      { label: 'Digest', description: 'Synthesize selected chats into a source-tracked document. Off by default.', keywords: ['digest', 'summary', 'synthesis', 'features.digest'] },
    ]),
    ...entries('appearance', 'Advanced', [
      { label: 'Interface font', keywords: ['font', 'typeface', 'geist', 'inter', 'plex', 'theme.uiFont'] },
      { label: 'Message font', keywords: ['font', 'serif', 'theme.messageFont'] },
      { label: 'Composer size', keywords: ['font size', 'text size', 'theme.composerFontSize'] },
      { label: 'Code blocks', description: 'Hairline or Header.', keywords: ['code block style', 'language label', 'hairline', 'header', 'theme.codeBlockStyle'] },
      { label: 'Code wrap', description: 'Wrap long lines in code blocks instead of scrolling sideways.', keywords: ['code', 'wrap', 'theme.codeWrap'] },
      { label: 'Agent blocks', description: 'How thinking, tool calls and subagents show: Line, Plain, Card or Terminal.',
        keywords: ['agent block style', 'tool calls', 'thinking', 'subagents', 'line', 'plain', 'card', 'terminal', 'theme.agentBlockStyle'] },
      { label: 'Corner radius', keywords: ['rounded', 'radius', 'theme.cornerRadius'] },
      { label: 'Sidebar row style', keywords: ['sidebar', 'cards', 'theme.sidebarRowStyle'] },
      { label: 'Sidebar edge padding', keywords: ['sidebar', 'padding', 'inset', 'theme.sidebarInset'] },
      { label: 'Sidebar timestamps', description: 'Show last-active time on thread rows.', keywords: ['sidebar', 'time', 'theme.sidebarTimestamps'] },
      { label: 'Window glass', description: 'See the desktop through the sidebar (macOS app). Turn off if drawers or ⌘K flicker.', keywords: ['vibrancy', 'transparent', 'translucent', 'see-through', 'flicker', 'theme.windowGlass'], vibrancy: true },
      { label: 'Sidebar glass', description: 'How much shows through the sidebar.', keywords: ['glass', 'translucency', 'transparent', 'opacity', 'theme.sidebarTranslucency'] },
      { label: 'Glass blur', description: 'Blur behind the sidebar.', keywords: ['glass', 'blur', 'frost', 'theme.glassBlur'] },
      { label: 'Glass saturation', description: 'How vivid what shows through the sidebar is.', keywords: ['glass', 'saturation', 'saturate', 'theme.glassSaturate'] },
      { label: 'Sidebar material', description: 'How dense the macOS frost behind the sidebar is.', keywords: ['glass', 'vibrancy', 'frost', 'material', 'theme.sidebarVibrancy'], vibrancy: true },
      { label: 'Glass defaults', description: 'Put the glass settings back to the tuned look.', keywords: ['glass', 'reset', 'default'] },
      { label: 'Dim strength', description: 'How much Dim unfocused panes lowers the other panes.', keywords: ['dim', 'focus dimming', 'unfocused', 'strength', 'theme.focusDim'] },
      { label: 'Pane width mode', keywords: ['panes', 'width', 'layout.paneWidthMode'] },
      { label: 'Pane animation', description: 'How a pane enters and leaves.', keywords: ['motion', 'animation', 'motion.spawn'] },
      { label: 'Default pane width', keywords: ['panes', 'width', 'layout.paneWidth'] },
      { label: 'Single-pane reading width', keywords: ['reading', 'width', 'layout.singlePaneWidth'] },
      { label: 'Chrome rules', description: 'Hairline rules between panes.', keywords: ['lines', 'borders', 'theme.rules'] },
    ]),
    ...entries('notifications', undefined, [
      { label: 'Notifications', description: 'Approvals, questions and replies in every conversation: all, approvals only, or off.', keywords: ['notify', 'alerts', 'approval', 'questions'] },
      { label: 'Notification sounds', description: 'A short tone when an agent needs you or finishes.', keywords: ['sound', 'audio', 'chime', 'tone', 'beep'] },
    ]),
    ...entries('notifications', WINDOWS_CLOSED_TITLE, [
      { label: WINDOWS_CLOSED_TITLE, description: 'Stay in the menu bar, and notify you while no window is open.', keywords: ['tray', 'menu bar', 'background', 'quit', 'dock'] },
      { label: TRAY_LABEL, description: 'Closing the last window keeps Michi running.', keywords: ['tray', 'menu bar', 'notification area', 'resident'] },
      { label: HIDE_DOCK_LABEL, keywords: ['dock', 'macos'] },
      { label: OPEN_AT_LOGIN_LABEL, keywords: ['startup', 'login', 'windows'] },
      { label: KEEP_RUNNING_LABEL, description: 'Scheduled jobs and notifications go on after you quit.', keywords: ['background', 'service', 'login', 'launchagent', 'scheduled'] },
    ]),
    ...entries('links', 'Browser', [
      { label: 'Open links in', description: 'Michi Browser or your system browser.', keywords: ['browser', 'links', 'open_url', 'external'] },
    ]),
    ...entries('trash', 'Cleanup', [
      { label: 'Delete automatically', description: 'How long Trash keeps deleted threads.', keywords: ['trash', 'retention', 'auto delete', 'purge', 'days', 'ttl', 'deleted'] },
      { label: 'Empty Trash', description: 'Permanently delete everything in Trash.', keywords: ['trash', 'purge', 'clear', 'deleted'] },
    ]),
    ...entries('trash', undefined, [
      { label: 'Deleted items', description: 'Restore deleted threads, pages and workspaces.', keywords: ['trash', 'restore', 'undelete', 'recover', 'bin'] },
    ]),
    ...entries('archived', undefined, [
      { label: 'Archived threads', description: 'Unarchive threads and nodes, or move them to Trash.', keywords: ['archive', 'unarchive', 'hidden'] },
    ]),
    ...entries('backup', undefined, [
      { label: 'Backup and restore', description: 'Export workspaces, conversations and Agent data, or restore them.', keywords: ['export', 'import', 'restore', 'json'] },
    ]),
    ...entries('scheduled', 'Background', [
      { label: 'Default scheduled job thread', description: 'One ongoing thread, or a new thread each run.', keywords: ['scheduled', 'jobs', 'cron'] },
    ]),
    // Digest's shortcut is found through the Digest switch above, on or off.
    ...shortcutGroups(name).flatMap((group) => group.bindings.filter((binding) => !binding.digest).map((binding) => ({
      page: 'shortcuts' as const, group: group.title, label: binding.label, description: binding.keys, keywords: ['shortcut', 'keyboard'],
    }))),
    ...entries('account', undefined, [{ label: 'Account', description: 'Who is signed in, and Sign out.', keywords: ['sign out', 'email'] }]),
  ];
}

export interface SettingsSearchResult extends SettingsSearchEntry {
  /** "App › Appearance › Advanced": where the setting is. */
  path: string;
}

const normalize = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

/** Pages whose settings sit in one group: the page does not show that group's title, so a path leaves it out too. */
const SINGLE_GROUP_PAGES: ReadonlySet<SettingsPage> = (() => {
  const groups = new Map<SettingsPage, Set<string | undefined>>();
  for (const entry of settingsSearchIndex(DEFAULT_COMPANION_NAME)) groups.set(entry.page, (groups.get(entry.page) ?? new Set()).add(entry.group));
  return new Set([...groups].filter(([, names]) => names.size === 1).map(([page]) => page));
})();

/**
 * Settings whose name, description, page or keywords contain every word of
 * the query, names first: a name that starts with the query, then one that
 * contains it, then the rest. Settings that need the window's vibrancy are
 * left out where there is none, as their pages leave them out.
 */
export function searchSettings(query: string, pages: readonly SettingsPage[], groupOf: (page: SettingsPage) => string,
  { name = DEFAULT_COMPANION_NAME, vibrancy = false }: { name?: string; vibrancy?: boolean } = {}): SettingsSearchResult[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const allowed = new Set(pages);
  const scored: Array<{ result: SettingsSearchResult; score: number; order: number }> = [];
  settingsSearchIndex(name).forEach((entry, order) => {
    if (!allowed.has(entry.page) || (entry.vibrancy && !vibrancy)) return;
    const page = settingsPageLabel(entry.page, name);
    const label = normalize(entry.label);
    const haystack = normalize([entry.label, entry.description, page, entry.group, ...(entry.keywords ?? [])].filter(Boolean).join(' '));
    if (!words.every((word) => haystack.includes(word))) return;
    const phrase = words.join(' ');
    const score = label.startsWith(phrase) ? 0 : label.includes(phrase) ? 1 : words.every((word) => label.includes(word)) ? 2 : 3;
    const shownGroup = entry.group && entry.group !== page && entry.group !== entry.label && !SINGLE_GROUP_PAGES.has(entry.page) ? entry.group : null;
    const path = [groupOf(entry.page), page, shownGroup].filter(Boolean).join(' › ');
    scored.push({ result: { ...entry, path }, score, order });
  });
  return scored.sort((a, b) => a.score - b.score || a.order - b.order).map(({ result }) => result);
}
