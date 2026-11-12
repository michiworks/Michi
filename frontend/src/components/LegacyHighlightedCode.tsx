import React, { useEffect, useState } from 'react';
import { createCodePlugin } from './shikiCodePlugin';
import type { CodeHighlighterPlugin, HighlightResult } from './shikiCodePlugin';
import CodeBlockPlainLines, { codeLineLinks } from './CodeBlockPlainLines';

type HighlightOptions = Parameters<CodeHighlighterPlugin['highlight']>[0];
type HighlightToken = HighlightResult['tokens'][number][number];
type CSSVars = React.CSSProperties & Record<`--${string}`, string | number | undefined>;

const CODE_THEMES: HighlightOptions['themes'] = ['github-light', 'github-dark'];
const codeHighlighter = createCodePlugin({ themes: CODE_THEMES });

function tokenStyle(token: HighlightToken): CSSVars | undefined {
  const htmlStyle = token.htmlStyle;
  if (!htmlStyle) return undefined;

  const style: CSSVars = {};
  for (const [key, value] of Object.entries(htmlStyle)) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    if (key === 'color') {
      style['--michi-code-token'] = value;
    } else if (key === 'background-color') {
      style['--michi-code-token-bg'] = value;
    } else {
      (style as Record<string, string | number | undefined>)[key] = value;
    }
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

function useShikiHighlight(source: string, language: string) {
  const [result, setResult] = useState<HighlightResult | null>(null);

  useEffect(() => {
    let active = true;
    setResult(null);

    const next = codeHighlighter.highlight(
      {
        code: source,
        language: (language || 'text') as HighlightOptions['language'],
        themes: CODE_THEMES,
      },
      (asyncResult) => {
        if (active) setResult(asyncResult);
      },
    );
    if (next) setResult(next);

    return () => {
      active = false;
    };
  }, [source, language]);

  return result;
}

/** A line's tokens, cut where links start and end so each link holds the token pieces it covers. */
function lineTokens(line: HighlightToken[], lineIndex: number, httpsLinksOnly: boolean): React.ReactNode[] {
  const links = codeLineLinks(line.map(token => token.content).join(''), httpsLinksOnly);
  if (!links.length) {
    return line.map((token, tokenIndex) => (
      <span className="michi-code-token" key={`${lineIndex}-${tokenIndex}`} style={tokenStyle(token)}>
        {token.content}
      </span>
    ));
  }
  const out: React.ReactNode[] = [];
  let anchor: React.ReactNode[] = [];
  let linkIndex = 0;
  let offset = 0;
  for (const [tokenIndex, token] of line.entries()) {
    const style = tokenStyle(token);
    let pos = 0;
    while (pos < token.content.length) {
      const link = links[linkIndex];
      const inside = link !== undefined && offset + pos >= link.start;
      const linkEnd = link ? link.start + link.url.length : Infinity;
      const stop = Math.min(token.content.length, (inside ? linkEnd : link?.start ?? Infinity) - offset);
      const piece = (
        <span className="michi-code-token" key={`${lineIndex}-${tokenIndex}-${pos}`} style={style}>
          {token.content.slice(pos, stop)}
        </span>
      );
      if (!inside) {
        out.push(piece);
      } else {
        anchor.push(piece);
        if (offset + stop === linkEnd) {
          out.push(
            <a key={`link-${link.start}`} href={link.href} target="_blank" rel="noopener noreferrer">
              {anchor}
            </a>,
          );
          anchor = [];
          linkIndex += 1;
        }
      }
      pos = stop;
    }
    offset += token.content.length;
  }
  return out;
}

function HighlightedCodeLines({
  result,
  tail,
  lineNumbers,
  httpsLinksOnly,
}: {
  result: HighlightResult;
  tail?: React.ReactNode;
  lineNumbers?: boolean;
  httpsLinksOnly: boolean;
}) {
  return (
    <>
      {result.tokens.map((line, lineIndex) => (
        <span
          className="michi-code-line"
          data-line-number={lineNumbers ? lineIndex + 1 : undefined}
          key={lineIndex}
        >
          {lineTokens(line, lineIndex, httpsLinksOnly)}
          {lineIndex === result.tokens.length - 1 ? tail : null}
        </span>
      ))}
    </>
  );
}

export default function LegacyHighlightedCode({
  source,
  language,
  tail,
  lineNumbers = false,
  httpsLinksOnly = false,
}: {
  source: string;
  language: string;
  tail?: React.ReactNode;
  lineNumbers?: boolean;
  httpsLinksOnly?: boolean;
}) {
  const result = useShikiHighlight(source, language);
  return result
    ? <HighlightedCodeLines result={result} tail={tail} lineNumbers={lineNumbers} httpsLinksOnly={httpsLinksOnly} />
    : <CodeBlockPlainLines source={source} tail={tail} lineNumbers={lineNumbers} httpsLinksOnly={httpsLinksOnly} />;
}
