import { useMemo } from 'react';
import { findUrlMatches } from '../lib/linkify';
import { isLocalOnlyHref } from './rehypeLocalOnly';

/** The URLs in one line of code that become links, plain or highlighted. */
export function codeLineLinks(line: string, httpsLinksOnly: boolean) {
  const matches = findUrlMatches(line, { schemeOnly: true });
  return httpsLinksOnly ? matches.filter(entry => isLocalOnlyHref(entry.href)) : matches;
}

function linkifyLine(line: string, httpsLinksOnly: boolean): React.ReactNode {
  const linked = codeLineLinks(line, httpsLinksOnly);
  if (!linked.length) return line;

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  for (const { start, end, url, href } of linked) {
    if (start > lastIndex) parts.push(line.slice(lastIndex, start));
    parts.push(
      <a key={start} href={href} target="_blank" rel="noopener noreferrer">
        {url}
      </a>,
    );
    const trailing = line.slice(start + url.length, end);
    if (trailing) parts.push(trailing);
    lastIndex = end;
  }
  if (lastIndex < line.length) parts.push(line.slice(lastIndex));
  return parts;
}

export default function CodeBlockPlainLines({
  source,
  tail,
  lineNumbers = false,
  httpsLinksOnly = false,
}: {
  source: string;
  tail?: React.ReactNode;
  lineNumbers?: boolean;
  /** Only https URLs become links, as rehypeLocalOnly does for the rest of the Markdown. */
  httpsLinksOnly?: boolean;
}) {
  const lines = useMemo(() => source.split('\n'), [source]);
  return (
    <>
      {lines.map((line, index) => (
        <span
          className="michi-code-line"
          data-line-number={lineNumbers ? index + 1 : undefined}
          key={index}
        >
          {linkifyLine(line, httpsLinksOnly)}
          {index === lines.length - 1 ? tail : null}
        </span>
      ))}
    </>
  );
}
