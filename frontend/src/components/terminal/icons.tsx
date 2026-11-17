import React from 'react';
import type { LucideIcon, LucideProps } from 'lucide-react';
import {
  AlarmClock, AppWindow, ArchiveRestore, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpDown, ArrowUpRight,
  AtSign, Bell, BellRing, Bookmark, Brain, Calendar, ChartColumn, ChartGantt, Circle, CircleChevronDown, CircleHelp,
  CircleAlert, Code, Columns2, CornerUpLeft, Cpu, Diff, Eye, EyeOff, FilePlus, Flag, FolderInput, Gauge, Ghost,
  GitMerge, GitPullRequest, GripVertical, Hand, HardDriveDownload, Hash, History, ImageOff, Info, Kanban, KeyRound,
  Keyboard, LayoutGrid, Lightbulb, List, ListFilter, LoaderCircle, LockKeyhole, Mail, Maximize2, Ellipsis, Minimize2,
  Minus, Monitor, MoveRight, Palette, Pause, Pin, PinOff, Play, Quote, Rows3, Ruler, Scissors, Server, ServerOff,
  Settings, SlidersHorizontal, Split, SquareCheck, SquareTerminal, SquareX, Star, StarOff, Table2, Tag, Tags,
  TriangleAlert, Type, Undo2, Workflow,
} from 'lucide-react';

/**
 * Michi's icons. Every icon in the app comes from this file: the house
 * drawings below, and the few Lucide shapes the house set has no drawing for,
 * wrapped by fromLucide so they share one size scale and one stroke.
 */

/** The three icon sizes, in CSS px. A number is for the exceptions: status dots, empty-state art, sizes computed at runtime. */
export const ICON_PX = { sm: 12, md: 14, lg: 16 } as const;
export type IconSize = keyof typeof ICON_PX | number;
export const iconPx = (size: IconSize = 'md'): number => (typeof size === 'number' ? size : ICON_PX[size]);

/**
 * Every line icon's drawn stroke in CSS px, the same at every size: about the
 * stem of 12px Geist Medium, a little heavier than the regular labels beside
 * most icons (Geist 12px Regular is 1.01px).
 */
export const STROKE_PX = 1.25;
/** The strokeWidth that draws STROKE_PX for an SVG on a `grid`-unit viewBox shown at `px`. */
export const strokeFor = (px: number, grid = 16): number => (STROKE_PX * grid) / px;

export type IconProps = Omit<React.SVGProps<SVGSVGElement>, 'ref' | 'width' | 'height' | 'strokeWidth'> & {
  size?: IconSize;
};
export type IconComponent = (props: IconProps) => React.ReactElement;

/**
 * The house drawings use the middle 12 units of a 16-unit grid. The box
 * shows the middle 14, so a drawing fills about as much of its box as a
 * Lucide shape fills of its own (20 of 24) and the two sets read the same
 * size side by side. A stroke may overhang the box by a hair; it isn't clipped.
 */
const HOUSE_VIEWBOX = '1 1 14 14';
const HOUSE_GRID = 14;

const base = (size: IconSize | undefined, rest: Omit<IconProps, 'size'>): React.SVGProps<SVGSVGElement> => {
  const px = iconPx(size);
  return {
    width: px,
    height: px,
    viewBox: HOUSE_VIEWBOX,
    overflow: 'visible',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: strokeFor(px, HOUSE_GRID),
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': rest['aria-label'] ? undefined : true,
    focusable: 'false',
    ...rest,
  };
};

/** A Lucide shape at Michi's sizes and stroke. Only this file imports lucide-react. */
export function fromLucide(L: LucideIcon, displayName: string): (props: IconProps & Omit<LucideProps, 'ref' | 'size' | 'strokeWidth' | 'absoluteStrokeWidth'>) => React.ReactElement {
  function Icon({ size, ...rest }: IconProps & Omit<LucideProps, 'ref' | 'size' | 'strokeWidth' | 'absoluteStrokeWidth'>) {
    return (
      <L
        size={iconPx(size)}
        strokeWidth={STROKE_PX}
        absoluteStrokeWidth
        aria-hidden={rest['aria-label'] ? undefined : true}
        focusable="false"
        {...(rest as Omit<LucideProps, 'ref'>)}
      />
    );
  }
  Icon.displayName = displayName;
  return Icon;
}

export function HomeIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M2.5 8 L8 3 L13.5 8" />
      <path d="M4 7.4 V13 H12 V7.4" />
      <path d="M6.8 13 V9.8 H9.2 V13" />
    </svg>
  );
}

export function MapIcon({ size, ...rest }: IconProps) {
  // Top-down node graph — a root branching to two children: the dagre topology at a glance.
  return (
    <svg {...base(size, rest)}>
      <circle cx="8" cy="3.4" r="1.5" />
      <circle cx="4" cy="12.6" r="1.5" />
      <circle cx="12" cy="12.6" r="1.5" />
      <path d="M8 4.9V7.4" />
      <path d="M8 7.4H4V11.1" />
      <path d="M8 7.4H12V11.1" />
    </svg>
  );
}

export function BranchesIcon({ size, ...rest }: IconProps) {
  // Vertical timeline — a spine with filled beads and body lines: read the branch log top to bottom.
  return (
    <svg {...base(size, rest)}>
      <path d="M4 3.5V12.5" />
      <path d="M7 4h5M7 8h4M7 12h5" />
      <circle cx="4" cy="4" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="4" cy="8" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function DigestIcon({ size, ...rest }: IconProps) {
  // Dog-eared note — a sheet with a folded corner: one written brief, not a menu.
  return (
    <svg {...base(size, rest)}>
      <path d="M4 2.5h5.4l2.6 2.6v8.4H4z" />
      <path d="M9.4 2.5v2.6h2.6" />
      <path d="M6 8.2h4M6 10.4h2.6" />
    </svg>
  );
}

export function ClockIcon({ size, ...rest }: IconProps) {
  // Scheduled jobs.
  return (
    <svg {...base(size, rest)}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5.2V8l1.9 1.3" />
    </svg>
  );
}

export function WorkspacesIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
    </svg>
  );
}

export function AllThreadsIcon({ size, ...rest }: IconProps) {
  // WorkspacesIcon's frame ruled into a header and a column: every thread,
  // laid out as one library.
  return (
    <svg {...base(size, rest)}>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.2h11M6.5 6.2V13" />
    </svg>
  );
}

export function FolderIcon({ size, ...rest }: IconProps) {
  // Closed folder — a collapsed workspace in the sidebar.
  return (
    <svg {...base(size, rest)}>
      <path d="M2 4.5a1 1 0 0 1 1-1h3.2a1 1 0 0 1 .7.3l1 1a1 1 0 0 0 .7.3H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5Z" />
    </svg>
  );
}

export function FolderOpenIcon({ size, ...rest }: IconProps) {
  // Open folder — FolderIcon's back panel with the front flap swung forward:
  // an expanded workspace.
  return (
    <svg {...base(size, rest)}>
      <path d="M2 12V4.5a1 1 0 0 1 1-1h3.2a1 1 0 0 1 .7.3l1 1a1 1 0 0 0 .7.3H12a1 1 0 0 1 1 1v1.3" />
      <path d="M2 12l1.6-3.9a1 1 0 0 1 .9-.7h8.8a.9.9 0 0 1 .8 1.3l-1.4 3.6a1 1 0 0 1-.9.7H3a1 1 0 0 1-1-1Z" />
    </svg>
  );
}

export function ArtifactsIcon({ size, ...rest }: IconProps) {
  // Stacked layers — reads as "a collection of things" (the artifact shelf).
  return (
    <svg {...base(size, rest)}>
      <path d="M8 2l6 3-6 3-6-3 6-3z" />
      <path d="M2 8l6 3 6-3" />
      <path d="M2 11l6 3 6-3" />
    </svg>
  );
}

/** The gear. (The house drawing was a circle with eight rays, which reads as a sun.) */
export const SettingsIcon = fromLucide(Settings, 'SettingsIcon');

export function UserIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <circle cx="8" cy="6" r="2.6" />
      <path d="M3 14a5 5 0 0 1 10 0" />
    </svg>
  );
}

export function CopyIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.5" />
      <path d="M3.5 10.5h-.5A1.5 1.5 0 0 1 1.5 9V3A1.5 1.5 0 0 1 3 1.5h6A1.5 1.5 0 0 1 10.5 3v.5" />
    </svg>
  );
}

export function RetryIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9L13.5 5.5" />
      <path d="M13.5 2v3.5H10" />
    </svg>
  );
}

export function EditIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M11.3 2.1a1.85 1.85 0 0 1 2.6 2.6L5.2 13.4l-3.5.9.9-3.5z" />
    </svg>
  );
}

export function BranchIcon({ size, className, ...rest }: IconProps) {
  return (
    <Split
      size={iconPx(size)}
      strokeWidth={STROKE_PX}
      absoluteStrokeWidth
      className={className ? `rotate-90 ${className}` : 'rotate-90'}
      aria-hidden={rest['aria-label'] ? undefined : true}
      focusable="false"
      {...(rest as Omit<LucideProps, 'ref'>)}
    />
  );
}

export function CheckIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M3 8.5l3.5 3.5L13 5" />
    </svg>
  );
}

export function ExternalLinkIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M12 9v4.5H2.5V4H7" />
      <path d="M10 2h4v4" />
      <path d="M7 9L14 2" />
    </svg>
  );
}

export function ChevronLeftIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M10 3L5 8l5 5" />
    </svg>
  );
}

export function ChevronRightIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M6 3l5 5-5 5" />
    </svg>
  );
}

/** Close, dismiss, cancel: an X. */
export function CloseIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

// ---- Mention glyphs: one per @-mentionable thing (chat node + artifact types).

export function ChatIcon({ size, ...rest }: IconProps) {
  // Speech bubble with a tail — a conversation node you can cite.
  return (
    <svg {...base(size, rest)}>
      <path d="M3.5 3h9A1.5 1.5 0 0 1 14 4.5v5.5a1.5 1.5 0 0 1-1.5 1.5H7.5L4.5 14v-2.5h-1A1.5 1.5 0 0 1 2 10V4.5A1.5 1.5 0 0 1 3.5 3z" />
    </svg>
  );
}

export function DocIcon({ size, ...rest }: IconProps) {
  // Plain page with text lines. No dog-ear, so it stays distinct from DigestIcon.
  return (
    <svg {...base(size, rest)}>
      <rect x="3.5" y="2" width="9" height="12" rx="1.5" />
      <path d="M6 5.5h4M6 8h4M6 10.5h2.5" />
    </svg>
  );
}

export function FileIcon({ size, ...rest }: IconProps) {
  // Blank dog-eared sheet — DigestIcon's silhouette without the text: an opaque file.
  return (
    <svg {...base(size, rest)}>
      <path d="M4 2.5h5.4l2.6 2.6v8.4H4z" />
      <path d="M9.4 2.5v2.6h2.6" />
    </svg>
  );
}

export function ImageIcon({ size, ...rest }: IconProps) {
  // Frame with a sun and a ridge line.
  return (
    <svg {...base(size, rest)}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <circle cx="5.8" cy="6.3" r="1.1" />
      <path d="M2.5 12l3.8-3.6 2.7 2.4 1.8-1.6 2.7 2.4" />
    </svg>
  );
}

export function LinkIcon({ size, ...rest }: IconProps) {
  // Two interlocking chain links.
  return (
    <svg {...base(size, rest)}>
      <path d="M6.7 8.7a3.3 3.3 0 0 0 5 .4l2-2a3.3 3.3 0 0 0-4.7-4.7L7.8 3.5" />
      <path d="M9.3 7.3a3.3 3.3 0 0 0-5-.4l-2 2a3.3 3.3 0 0 0 4.7 4.7l1.1-1.1" />
    </svg>
  );
}

export function TrashIcon({ size, ...rest }: IconProps) {
  // Lidded bin with two ribs — deleted things wait here before they're gone.
  return (
    <svg {...base(size, rest)}>
      <path d="M2.5 4.5h11" />
      <path d="M6.2 4.5V3h3.6v1.5" />
      <path d="M4 4.5l.8 9h6.4l.8-9" />
      <path d="M6.8 7v4M9.2 7v4" />
    </svg>
  );
}

export function ArchiveIcon({ size, ...rest }: IconProps) {
  // Box with a lid and a pull slot — kept, but out of the way.
  return (
    <svg {...base(size, rest)}>
      <rect x="2" y="2.5" width="12" height="3.5" rx="1" />
      <path d="M3.5 6v6.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6" />
      <path d="M6.5 8.8h3" />
    </svg>
  );
}

/** `bold`: the phone's top bar of solid glyphs, where + has no inside to fill. */
export function PlusIcon({ size, bold = false, ...rest }: IconProps & { bold?: boolean }) {
  if (bold) {
    const { fill: _fill, stroke: _stroke, strokeWidth: _sw, ...solid } = base(size, rest);
    // Drawn on the full 16 units, like the phone bar's other solid glyphs (sidebar, ghost, Companion).
    return (
      <svg {...solid} viewBox="0 0 16 16">
        <path fill="currentColor" d="M6.8 2.6a1.2 1.2 0 0 1 2.4 0v10.8a1.2 1.2 0 0 1-2.4 0ZM2.6 6.8h10.8a1.2 1.2 0 0 1 0 2.4H2.6a1.2 1.2 0 0 1 0-2.4Z" />
      </svg>
    );
  }
  return (
    <svg {...base(size, rest)}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function ThreadIcon({ size, ...rest }: IconProps) {
  // One thread: a root bead, a spine, and a branch curling off it — the tree
  // glyph's node-and-elbow language at 16 units.
  return (
    <svg {...base(size, rest)}>
      <circle cx="4.5" cy="3.8" r="1.5" />
      <circle cx="4.5" cy="12.2" r="1.5" />
      <circle cx="11.5" cy="8" r="1.5" />
      <path d="M4.5 5.3v5.4" />
      <path d="M4.5 5.6c0 1.6 1.2 2.4 3 2.4H10" />
    </svg>
  );
}

export function WeaveIcon({ size, ...rest }: IconProps) {
  // Two branches merging into one node — weaving chats back together.
  return (
    <svg {...base(size, rest)}>
      <circle cx="4" cy="3.5" r="1.5" />
      <circle cx="12" cy="3.5" r="1.5" />
      <circle cx="8" cy="12.5" r="1.5" />
      <path d="M4 5c0 3 4 3 4 6M12 5c0 3-4 3-4 6" />
    </svg>
  );
}

export function ExportIcon({ size, ...rest }: IconProps) {
  // Arrow dropping into a tray.
  return (
    <svg {...base(size, rest)}>
      <path d="M8 2.5V10" />
      <path d="M4.8 6.8L8 10l3.2-3.2" />
      <path d="M2.5 11v2.5h11V11" />
    </svg>
  );
}

// ---- Agents: the runtimes and modes that do a conversation's work. Michi
// itself (the Companion) is CompanionGlyph, not these. One shape in three states.

/** An agent: a rounded diamond holding a diamond core (◇ with ◆ inside). */
export function AgentIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <rect x="4.1" y="4.1" width="7.8" height="7.8" rx="1.7" transform="rotate(45 8 8)" />
      <rect x="6.6" y="6.6" width="2.8" height="2.8" rx="0.55" transform="rotate(45 8 8)" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * The small solid diamond (◆) that marks background agent runs in captions,
 * tabs and the top bar. `running` breathes it (.agent-glyph-run).
 */
export function AgentRunGlyph({ size = 10, running = false, className, ...rest }: IconProps & { running?: boolean }) {
  const { fill: _fill, stroke: _stroke, strokeWidth: _sw, ...solid } = base(size, rest);
  const cls = [running ? 'agent-glyph-run' : '', className ?? ''].filter(Boolean).join(' ') || undefined;
  return (
    <svg {...solid} className={cls}>
      <rect x="3.8" y="3.8" width="8.4" height="8.4" rx="1.8" transform="rotate(45 8 8)" fill="currentColor" />
    </svg>
  );
}

/** A subagent: the agent's diamond, smaller and without a core. */
export function SubagentIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <rect x="5.3" y="5.3" width="5.4" height="5.4" rx="1.3" transform="rotate(45 8 8)" />
    </svg>
  );
}

export function SkillIcon({ size, ...rest }: IconProps) {
  // An open book: instructions an agent can read when a task calls for them.
  return (
    <svg {...base(size, rest)}>
      <path d="M8 4.3C6.6 3.3 4.6 2.9 2.5 3.1v9.1c2.1-.2 4.1.2 5.5 1.2 1.4-1 3.4-1.4 5.5-1.2V3.1C11.4 2.9 9.4 3.3 8 4.3z" />
      <path d="M8 4.3v9.1" />
    </svg>
  );
}

export function ShieldIcon({ size, ...rest }: IconProps) {
  // Permission prompts on: a shield with a check.
  return (
    <svg {...base(size, rest)}>
      <path d="M8 1.8l5 2v4.1c0 3-2.1 5.1-5 6.3-2.9-1.2-5-3.3-5-6.3V3.8z" />
      <path d="M5.8 8.1l1.6 1.6 3-3.1" />
    </svg>
  );
}

export function ShieldOffIcon({ size, ...rest }: IconProps) {
  // Permission prompts bypassed: the same shield, struck through.
  return (
    <svg {...base(size, rest)}>
      <path d="M8 1.8l5 2v4.1c0 3-2.1 5.1-5 6.3-2.9-1.2-5-3.3-5-6.3V3.8z" />
      <path d="M2 2l12 12" />
    </svg>
  );
}

/** Multi-model fork: two branches joining into one. */
export function ForkIcon({ size = 'sm', ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <circle cx="4" cy="3" r="1.6" />
      <circle cx="12" cy="3" r="1.6" />
      <circle cx="8" cy="13" r="1.6" />
      <path d="M4 4.6v1c0 2.2 4 2.6 4 5.8M12 4.6v1c0 2.2-4 2.6-4 5.8" />
    </svg>
  );
}

export function ChevronDownIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M3 6l5 5 5-5" />
    </svg>
  );
}

/** Stop: a square (an interrupted or stopped run). */
export function StopIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
    </svg>
  );
}

/** Search: a lens with its handle. */
export function SearchIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.4 10.4L13.5 13.5" />
    </svg>
  );
}

/** Pages: two stacked sheets, the front one written on. Distinct from ArtifactsIcon's layers and DocIcon's single page. */
export function PagesIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M5.5 2h6.5A1.5 1.5 0 0 1 13.5 3.5V11" />
      <rect x="2.5" y="4.5" width="8.5" height="9.5" rx="1.5" />
      <path d="M4.9 7.9h3.7M4.9 10.7h2.4" />
    </svg>
  );
}

// ---- Lucide shapes the house set has no drawing for. Names say what they
// mean in Michi; one concept, one export. Add here, never import lucide-react
// elsewhere.
export const AlarmIcon = fromLucide(AlarmClock, 'AlarmIcon');
export const AppWindowIcon = fromLucide(AppWindow, 'AppWindowIcon');
export const ArchiveRestoreIcon = fromLucide(ArchiveRestore, 'ArchiveRestoreIcon');
export const ArrowDownIcon = fromLucide(ArrowDown, 'ArrowDownIcon');
export const ArrowLeftIcon = fromLucide(ArrowLeft, 'ArrowLeftIcon');
export const ArrowRightIcon = fromLucide(ArrowRight, 'ArrowRightIcon');
export const ArrowUpIcon = fromLucide(ArrowUp, 'ArrowUpIcon');
export const ArrowUpRightIcon = fromLucide(ArrowUpRight, 'ArrowUpRightIcon');
export const AtSignIcon = fromLucide(AtSign, 'AtSignIcon');
export const BellIcon = fromLucide(Bell, 'BellIcon');
export const BellRingIcon = fromLucide(BellRing, 'BellRingIcon');
export const BookmarkIcon = fromLucide(Bookmark, 'BookmarkIcon');
export const BrainIcon = fromLucide(Brain, 'BrainIcon');
export const CalendarIcon = fromLucide(Calendar, 'CalendarIcon');
export const ChartIcon = fromLucide(ChartColumn, 'ChartIcon');
export const CircleIcon = fromLucide(Circle, 'CircleIcon');
export const CircleChevronDownIcon = fromLucide(CircleChevronDown, 'CircleChevronDownIcon');
export const CodeIcon = fromLucide(Code, 'CodeIcon');
/** Side by side. */
export const ColumnsIcon = fromLucide(Columns2, 'ColumnsIcon');
export const CornerUpLeftIcon = fromLucide(CornerUpLeft, 'CornerUpLeftIcon');
export const CpuIcon = fromLucide(Cpu, 'CpuIcon');
export const DiffIcon = fromLucide(Diff, 'DiffIcon');
export const ErrorIcon = fromLucide(CircleAlert, 'ErrorIcon');
export const EyeIcon = fromLucide(Eye, 'EyeIcon');
export const EyeOffIcon = fromLucide(EyeOff, 'EyeOffIcon');
export const FilePlusIcon = fromLucide(FilePlus, 'FilePlusIcon');
export const FlagIcon = fromLucide(Flag, 'FlagIcon');
export const FolderInputIcon = fromLucide(FolderInput, 'FolderInputIcon');
export const GanttIcon = fromLucide(ChartGantt, 'GanttIcon');
export const GaugeIcon = fromLucide(Gauge, 'GaugeIcon');
export const GhostIcon = fromLucide(Ghost, 'GhostIcon');
export const GripIcon = fromLucide(GripVertical, 'GripIcon');
export const HandIcon = fromLucide(Hand, 'HandIcon');
export const BackupIcon = fromLucide(HardDriveDownload, 'BackupIcon');
export const HashIcon = fromLucide(Hash, 'HashIcon');
export const HelpIcon = fromLucide(CircleHelp, 'HelpIcon');
export const HistoryIcon = fromLucide(History, 'HistoryIcon');
export const ImageOffIcon = fromLucide(ImageOff, 'ImageOffIcon');
export const InfoIcon = fromLucide(Info, 'InfoIcon');
export const KanbanIcon = fromLucide(Kanban, 'KanbanIcon');
export const KeyIcon = fromLucide(KeyRound, 'KeyIcon');
export const KeyboardIcon = fromLucide(Keyboard, 'KeyboardIcon');
export const GridIcon = fromLucide(LayoutGrid, 'GridIcon');
export const IdeaIcon = fromLucide(Lightbulb, 'IdeaIcon');
export const ListIcon = fromLucide(List, 'ListIcon');
export const FilterIcon = fromLucide(ListFilter, 'FilterIcon');
export const LockIcon = fromLucide(LockKeyhole, 'LockIcon');
export const MailIcon = fromLucide(Mail, 'MailIcon');
export const MaximizeIcon = fromLucide(Maximize2, 'MaximizeIcon');
export const MergeIcon = fromLucide(GitMerge, 'MergeIcon');
export const MinimizeIcon = fromLucide(Minimize2, 'MinimizeIcon');
export const MinusIcon = fromLucide(Minus, 'MinusIcon');
export const MonitorIcon = fromLucide(Monitor, 'MonitorIcon');
export const MoreIcon = fromLucide(Ellipsis, 'MoreIcon');
export const MoveRightIcon = fromLucide(MoveRight, 'MoveRightIcon');
export const PaletteIcon = fromLucide(Palette, 'PaletteIcon');
export const PauseIcon = fromLucide(Pause, 'PauseIcon');
export const PinIcon = fromLucide(Pin, 'PinIcon');
export const PinOffIcon = fromLucide(PinOff, 'PinOffIcon');
export const PlayIcon = fromLucide(Play, 'PlayIcon');
export const PullRequestIcon = fromLucide(GitPullRequest, 'PullRequestIcon');
export const QuoteIcon = fromLucide(Quote, 'QuoteIcon');
export const RowsIcon = fromLucide(Rows3, 'RowsIcon');
export const RulerIcon = fromLucide(Ruler, 'RulerIcon');
export const ScissorsIcon = fromLucide(Scissors, 'ScissorsIcon');
export const ServerIcon = fromLucide(Server, 'ServerIcon');
export const ServerOffIcon = fromLucide(ServerOff, 'ServerOffIcon');
export const SlidersIcon = fromLucide(SlidersHorizontal, 'SlidersIcon');
export const SortIcon = fromLucide(ArrowUpDown, 'SortIcon');
/** Spinning loader; the caller adds the spin animation it already uses. */
export const SpinnerIcon = fromLucide(LoaderCircle, 'SpinnerIcon');
export const SquareCheckIcon = fromLucide(SquareCheck, 'SquareCheckIcon');
export const SquareCloseIcon = fromLucide(SquareX, 'SquareCloseIcon');
export const StarIcon = fromLucide(Star, 'StarIcon');
export const StarOffIcon = fromLucide(StarOff, 'StarOffIcon');
export const TableIcon = fromLucide(Table2, 'TableIcon');
export const TagIcon = fromLucide(Tag, 'TagIcon');
export const TagsIcon = fromLucide(Tags, 'TagsIcon');
export const TerminalIcon = fromLucide(SquareTerminal, 'TerminalIcon');
export const TypeIcon = fromLucide(Type, 'TypeIcon');
export const UndoIcon = fromLucide(Undo2, 'UndoIcon');
export const WarningIcon = fromLucide(TriangleAlert, 'WarningIcon');
export const WorkflowIcon = fromLucide(Workflow, 'WorkflowIcon');
