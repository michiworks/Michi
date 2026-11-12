import { kbd } from '../../../../lib/platform';
import { useCompanionName } from '../../../../state/companion/companionName';
import { useDigestEnabled } from '../../../../state/prefs';
import { SettingsSection } from './SettingsSection';

/** `digest` bindings are listed only while Settings › Digest is on. */
type Binding = { keys: string; label: string; digest?: true };
type Group = { title: string; bindings: Binding[] };

/** Every shortcut by group; the agent's two (DESIGN-v2 §1.2) carry its name. */
export function shortcutGroups(name: string): Group[] {
  return [
    {
      title: 'Navigation (terminal)',
      bindings: [
        { keys: kbd('mod', 'K'), label: 'Open command palette' },
        { keys: kbd('mod', '1'), label: 'Dashboard page' },
        { keys: kbd('mod', 'M'), label: 'Map page' },
        { keys: kbd('mod', 'D'), label: 'Digest page', digest: true },
        { keys: kbd('mod', 'O'), label: 'Workspaces page' },
        { keys: kbd('mod', ','), label: 'Settings' },
        { keys: kbd('mod', 'J'), label: `Open ${name}` },
        { keys: kbd('shift', 'mod', 'J'), label: `${name}: Today` },
      ],
    },
    {
      title: 'Panes',
      bindings: [
        { keys: kbd('mod', 'W'), label: 'Close focused pane' },
        { keys: kbd('mod', 'T'), label: 'New thread (tree root in current workspace)' },
        { keys: kbd('mod', 'alt', 'T'), label: 'New blank branch from focused pane' },
        { keys: kbd('mod', '\\'), label: 'Open next chat not yet in a pane' },
        { keys: kbd('ctrl', 'Tab'), label: 'Cycle to next pane (works while typing)' },
        { keys: kbd('ctrl', 'shift', 'Tab'), label: 'Cycle to previous pane' },
      ],
    },
    {
      title: 'Composer',
      bindings: [
        { keys: kbd('enter'), label: 'Send message' },
        { keys: kbd('mod', 'enter'), label: 'Branch — send as a new child chat' },
        { keys: '/fanout a; b; c', label: 'Fan out into N sibling branches' },
        { keys: '/btw <msg>', label: `Branch with this message (alias of ${kbd('mod', 'enter')})` },
      ],
    },
    {
      title: 'Command palette',
      bindings: [
        { keys: '↑ ↓', label: 'Move highlight' },
        { keys: kbd('enter'), label: 'Run selected command' },
        { keys: 'esc', label: 'Close palette' },
      ],
    },
  ];
}

export function ShortcutsPane() {
  const name = useCompanionName();
  const digestEnabled = useDigestEnabled();
  return (
    <>
      {shortcutGroups(name).map((g) => (
        <SettingsSection key={g.title} title={g.title}>
          {g.bindings.filter((b) => digestEnabled || !b.digest).map((b, i) => (
            <div key={i} className="settings-shortcut-row">
              <span className="settings-shortcut-row__keys">{b.keys}</span>
              <span className="settings-shortcut-row__label">{b.label}</span>
            </div>
          ))}
        </SettingsSection>
      ))}
    </>
  );
}
