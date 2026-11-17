import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// MessageBlock keeps no hover state: index.css alone shows a message's
// actions, so a pointer over a message, even a streaming one, commits no
// render. Read from disk: vitest stubs CSS imports.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../index.css'), 'utf8');
const TAP_CONTROLS = "a[href], button, input, select, textarea, summary, [role='button'], [data-mention], [data-tap-target]";

describe('message actions', () => {
  it('rest hidden and show while their message is hovered, and under the latest answer', () => {
    expect(css).toMatch(/\n\.t-msg-actions \{\s*opacity: 0;\s*pointer-events: none;/);
    expect(css).toMatch(/\[data-msg-actions='pinned'\] > \.t-msg-actions \{\s*opacity: 1;\s*pointer-events: auto;/);
    expect(css).toMatch(/@media \(hover: hover\) \{\s*\.terminal-message-frame:hover \.t-msg-actions \{\s*opacity: 1;\s*pointer-events: auto;/);
    // A user message's row floats over the next line: only its shown buttons take pointers.
    expect(css).toContain('.t-user-msg-actions { pointer-events: none; }');
  });

  it('leave a tap on a control in the message to the control on a touch screen, and stay up for a tap on themselves', () => {
    expect(css).toContain(`@media (hover: none) {\n  .terminal-message-frame:hover:not(:has(:is(${TAP_CONTROLS}):not(.t-msg-actions *):hover))\n    .t-msg-actions {`);
  });
});
