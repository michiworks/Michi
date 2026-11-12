import React from 'react';

/** `text` with every case-insensitive match of the trimmed `query` marked. */
export function SearchHighlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  const lower = text.toLocaleLowerCase();
  let start = 0, hit: number;
  while ((hit = lower.indexOf(needle, start)) !== -1) {
    parts.push(text.slice(start, hit), <mark key={hit} className="search-mark">{text.slice(hit, hit + needle.length)}</mark>);
    start = hit + needle.length;
  }
  parts.push(text.slice(start));
  return <>{parts}</>;
}
