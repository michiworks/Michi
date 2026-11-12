/**
 * The JSON object a model wrote as its answer (AgentRuntime.completeStructured):
 * the whole text, a fenced block, or the outermost {…} in it. Null when there
 * is none; the host validates what it gets.
 */
export function parseJsonAnswer(text: string): unknown | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(trimmed)?.[1]?.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  const candidates = [trimmed, fenced, start >= 0 && end > start ? trimmed.slice(start, end + 1) : undefined];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // Not JSON: the next candidate.
    }
  }
  return null;
}
