import type { MetadataOutputMode } from '../../contract/host';

/** A Codex chat reports its branch overview through the host's tool and its
 * follow-ups as sentinel lines. Keep this separate from Claude's mode. */
export const CODEX_METADATA_OUTPUT_MODE: MetadataOutputMode = 'sentinel-followups-tool-overview';

// The turn-metadata instruction text itself is the host's
// (CodexAdapterOptions.hostText.turnMetadataInstruction; Michi: hostText/codex.ts).
