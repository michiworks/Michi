import { StringDecoder } from 'node:string_decoder';

/**
 * A 'data' listener for one byte stream of newline-delimited UTF-8 (an agent's
 * stdout): calls onLine with each complete line, without its newline.
 *
 * A pipe read can end inside a multi-byte character. Decoding each chunk on
 * its own turns both halves into U+FFFD, and the JSON line still parses, so
 * the text is damaged without an error; the decoder keeps the partial bytes
 * for the next chunk. The newline search resumes where the previous chunk
 * ended, so a line that spans many chunks is scanned once.
 *
 * A line onLine throws on is gone; the lines after it stay buffered and are
 * read with the next chunk.
 */
export function utf8LineReader(onLine: (line: string) => void): (chunk: Buffer) => void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  return (chunk) => {
    const searchFrom = buffer.length;
    buffer += decoder.write(chunk);
    let idx = buffer.indexOf('\n', searchFrom);
    while (idx !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      onLine(line);
      idx = buffer.indexOf('\n');
    }
  };
}
