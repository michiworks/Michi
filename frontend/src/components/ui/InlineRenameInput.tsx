import React from 'react';
import { isImeComposing } from '../../lib/ime';

type InputProps = Omit<React.ComponentProps<'input'>, 'value' | 'defaultValue' | 'onChange' | 'onBlur'>;

interface InlineRenameInputProps extends InputProps {
  /** The name the field opens with; a rename has to differ from it. */
  value: string;
  /** Takes a trimmed, non-empty new name. Returning false refuses it: the field stays open. */
  onCommit: (name: string) => boolean | void;
  /** The field is done (saved, given up or left); the caller unmounts it. */
  onEnd: () => void;
  /** Leaving the field saves it ('commit', the default) or gives it up. */
  blur?: 'commit' | 'cancel';
}

/**
 * The field a row shows while it is renamed in place, mounted only for that
 * long. Enter saves and Esc gives up, but neither while an input method is
 * composing: then the key picks or dismisses a candidate. Esc stops at the
 * field, so the drawer or page around it stays.
 */
export function InlineRenameInput({ value, onCommit, onEnd, blur = 'commit', onKeyDown, ...input }: InlineRenameInputProps) {
  const [base] = React.useState(value);
  const [draft, setDraft] = React.useState(value);
  const done = React.useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    const name = draft.trim();
    if (save && name && name !== base && onCommit(name) === false) return;
    done.current = true;
    onEnd();
  };
  return (
    <input
      {...input}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (isImeComposing(event)) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => finish(blur === 'commit')}
    />
  );
}
