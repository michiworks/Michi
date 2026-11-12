import React from 'react';
import type { MentionEditorHandle, MentionEditorProps } from './MentionEditor';

const MentionEditor = React.lazy(() => import('./MentionEditor'));

/**
 * The composer editor, loaded on first use. Every composer shares this one
 * loader, so once any of them has loaded it the others mount it at once
 * instead of each suspending on its own first render.
 */
const LazyMentionEditor = React.forwardRef<MentionEditorHandle, MentionEditorProps>(function LazyMentionEditor(props, ref) {
  return (
    <React.Suspense fallback={<div className="composer-loading-stub" />}>
      <MentionEditor ref={ref} {...props} />
    </React.Suspense>
  );
});

export default LazyMentionEditor;
