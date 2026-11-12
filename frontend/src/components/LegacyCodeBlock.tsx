import React, { Suspense, startTransition, useEffect, useMemo, useRef, useState } from 'react';
import CodeBlockPlainLines from './CodeBlockPlainLines';
import { useCopyFeedback } from '../hooks/useCopyFeedback';
import { downloadText } from '../lib/download';

const languageClassRe = /(?:^|\s)language-([^\s]+)/;
const LegacyHighlightedCode = React.lazy(() => import('./LegacyHighlightedCode'));

export function languageFromClassName(className: string | undefined): string {
  return className?.match(languageClassRe)?.[1] ?? '';
}

function trimCodeFenceNewline(value: string): string {
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

export interface LegacyCodeBlockProps {
  text: string;
  className?: string;
  language?: string;
  deferHighlight?: boolean;
  lineNumbers?: boolean;
  showDownload?: boolean;
  tail?: React.ReactNode;
  /** Only https URLs in the code become links. */
  httpsLinksOnly?: boolean;
  'data-michi-code-block'?: boolean;
}

function LegacyCodeBlock({
  text,
  className,
  language,
  deferHighlight = false,
  lineNumbers = false,
  showDownload = false,
  tail,
  httpsLinksOnly = false,
}: LegacyCodeBlockProps) {
  const elementRef = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(() => typeof IntersectionObserver === 'undefined');
  const source = useMemo(() => trimCodeFenceNewline(text), [text]);
  const resolvedLanguage = language || languageFromClassName(className) || 'text';
  const highlightable = !deferHighlight && resolvedLanguage !== 'text' && source.trim().length > 0;
  const shouldHighlight = highlightable && nearViewport;

  useEffect(() => {
    const element = elementRef.current;
    if (!element || !highlightable || nearViewport || typeof IntersectionObserver === 'undefined') return;
    // Plain code keeps its geometry and copy behavior; offscreen tokens need
    // neither Shiki work nor a second React commit during pane entry.
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      startTransition(() => setNearViewport(true));
    }, { rootMargin: '200px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [highlightable, nearViewport]);

  const { result: copyResult, copy } = useCopyFeedback();
  const copied = copyResult === 'copied';

  const downloadCode = () => {
    downloadText(`code.${resolvedLanguage === 'text' ? 'txt' : resolvedLanguage}`, source, 'text/plain;charset=utf-8');
  };

  const copyButton = (
    <button
      aria-label="Copy code"
      className={copied ? 'michi-code-copy is-copied' : 'michi-code-copy'}
      onClick={() => { void copy(source); }}
      title="copy code"
      type="button"
    >
      {copied ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );

  return (
    <div
      ref={elementRef}
      className="michi-code-block"
      data-language={resolvedLanguage}
      data-michi-code-block
    >
      <div className="michi-code-header">
        <span className="michi-code-language">{resolvedLanguage}</span>
      </div>
      <div className="michi-code-body">
        {showDownload ? (
          <div className="michi-code-actions">
            {copyButton}
            <button
              aria-label="Download code"
              className="michi-code-download"
              data-michi-code-download
              onClick={downloadCode}
              type="button"
            >
              ↓
            </button>
          </div>
        ) : copyButton}
        <div className="michi-code-scroll">
          <pre className="michi-code-pre">
            <code className={className}>
              {shouldHighlight ? (
                <Suspense fallback={<CodeBlockPlainLines source={source} tail={tail} lineNumbers={lineNumbers} httpsLinksOnly={httpsLinksOnly} />}>
                  <LegacyHighlightedCode language={resolvedLanguage} source={source} tail={tail} lineNumbers={lineNumbers} httpsLinksOnly={httpsLinksOnly} />
                </Suspense>
              ) : (
                <CodeBlockPlainLines source={source} tail={tail} lineNumbers={lineNumbers} httpsLinksOnly={httpsLinksOnly} />
              )}
            </code>
          </pre>
        </div>
      </div>
    </div>
  );
}

export default React.memo(LegacyCodeBlock);
