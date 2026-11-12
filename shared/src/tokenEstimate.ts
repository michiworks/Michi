/** Rough token count: CJK characters count one each, other text four characters per token. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(/[⺀-鿿가-힯豈-﫿＀-￯]/gu)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
}
