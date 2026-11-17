import type { SidebarDensity, TerminalDensity } from './prefs';

const MESSAGE_DENSITY: Readonly<Record<SidebarDensity, TerminalDensity>> = { compact: 'dense', comfortable: 'compact', airy: 'comfortable' };

/** The messages' spacing at a Settings › Density step: its middle step keeps the messages compact. */
export function messageDensity(density: SidebarDensity): TerminalDensity {
  return MESSAGE_DENSITY[density];
}
