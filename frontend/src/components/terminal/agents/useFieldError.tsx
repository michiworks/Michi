import React from 'react';

/** What a control takes while its field shows an error: aria-invalid, and aria-describedby naming the error line. */
export type FieldErrorProps = { 'aria-invalid'?: true; 'aria-describedby'?: string };

const LINE_STYLE: React.CSSProperties = { color: 'var(--term-danger-text)', fontSize: 'var(--fs-md)', letterSpacing: 0, textTransform: 'none' };

/**
 * An agent form field's error line, and the props that tie its control to it
 * (ST-17). The line is no live region: the editor focuses the first invalid
 * field when a save is stopped, and later edits are not announced key by key.
 */
export function useFieldError(error: string | undefined): { control: FieldErrorProps; line: React.ReactNode } {
  const id = React.useId();
  if (!error) return { control: {}, line: null };
  return { control: { 'aria-invalid': true, 'aria-describedby': id }, line: <span id={id} style={LINE_STYLE}>{error}</span> };
}
