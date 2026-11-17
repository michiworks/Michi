import React from 'react';
import type { CommandIcon } from '../../state/commands';
import {
  AgentIcon,
  AllThreadsIcon,
  ArchiveIcon,
  BranchesIcon,
  ChatIcon,
  ClockIcon,
  CloseIcon,
  DigestIcon,
  ExportIcon,
  HomeIcon,
  ICON_PX,
  MapIcon,
  PagesIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SettingsIcon,
  ShieldIcon,
  ShieldOffIcon,
  SkillIcon,
  ThreadIcon,
  TrashIcon,
  UserIcon,
  WeaveIcon,
  WorkspacesIcon,
} from './icons';
import { TemporaryChatGlyph } from './TemporaryChat';

const COMMAND_ICONS: Record<CommandIcon, (props: { size?: number }) => React.ReactElement> = {
  agent: AgentIcon,
  home: HomeIcon,
  branches: BranchesIcon,
  map: MapIcon,
  digest: DigestIcon,
  pages: PagesIcon,
  workspace: WorkspacesIcon,
  trash: TrashIcon,
  archive: ArchiveIcon,
  settings: SettingsIcon,
  profile: UserIcon,
  plus: PlusIcon,
  shield: ShieldIcon,
  'shield-off': ShieldOffIcon,
  thread: ThreadIcon,
  weave: WeaveIcon,
  export: ExportIcon,
  close: CloseIcon,
  pause: PauseIcon,
  play: PlayIcon,
  chat: ChatIcon,
  threads: AllThreadsIcon,
  clock: ClockIcon,
  skill: SkillIcon,
  ghost: TemporaryChatGlyph,
};

/** The house SVG for a command palette row, sized to the menu icon slot. */
export function CommandIconGlyph({ name, size = ICON_PX.md }: { name: CommandIcon; size?: number }) {
  const Icon = COMMAND_ICONS[name];
  return <Icon size={size} />;
}
