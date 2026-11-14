/**
 * Words handed to the Home composer from elsewhere (the palette's
 * "New thread: …"). A composer on screen takes them at once; otherwise they
 * wait for the next one to mount. Small session state with one reader.
 */
type HomeDraftSink = (text: string) => void;

const sinks = new Set<HomeDraftSink>();
let pending: string[] = [];

export function addToHomeDraft(text: string): void {
  if (!text.trim()) return;
  if (sinks.size > 0) sinks.forEach((sink) => sink(text));
  else pending.push(text);
}

/** The Home composer, while mounted: takes what waited, then what arrives. */
export function receiveHomeDraft(sink: HomeDraftSink): () => void {
  const waiting = pending;
  pending = [];
  waiting.forEach(sink);
  sinks.add(sink);
  return () => { sinks.delete(sink); };
}

/** @testonly */
export function __resetHomeDraftForTests(): void {
  sinks.clear();
  pending = [];
}
