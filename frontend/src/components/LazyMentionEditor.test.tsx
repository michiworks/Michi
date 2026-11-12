import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import LazyMentionEditor from './LazyMentionEditor';
import type { MentionEditorHandle, MentionEditorProps } from './MentionEditor';

vi.mock('./MentionEditor', () => ({
  default: React.forwardRef<MentionEditorHandle, MentionEditorProps>(function MentionEditorStub(props, ref) {
    React.useImperativeHandle(ref, () => ({ focus: () => {}, startMention: () => {}, editor: null }));
    return <textarea data-testid={props['data-testid']} value={props.value} readOnly />;
  }),
}));

const props = (testId: string): MentionEditorProps => ({
  value: testId, mentions: [], onChange: () => {}, artifacts: [], sameTreeNodes: [], currentNodeId: 'n', 'data-testid': testId,
});

describe('LazyMentionEditor', () => {
  it('shows the loading stub until the editor loads, and a later composer mounts it at once with its ref', async () => {
    const first = render(<LazyMentionEditor {...props('first')} />);
    expect(first.container.querySelector('.composer-loading-stub')).toBeTruthy();
    expect(await screen.findByTestId('first')).toBeTruthy();

    const ref = React.createRef<MentionEditorHandle>();
    const second = render(<LazyMentionEditor ref={ref} {...props('second')} />);
    expect(second.container.querySelector('.composer-loading-stub')).toBeNull();
    expect(screen.getByTestId('second')).toBeTruthy();
    expect(ref.current?.focus).toBeTypeOf('function');
  });
});
