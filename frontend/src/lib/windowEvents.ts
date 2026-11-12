/**
 * A window event with one name and one detail shape, dispatched and
 * subscribed through the same definition, so the compiler checks both ends.
 * Any code can dispatch a window event, so `read` checks what arrives and
 * drops a malformed one (null).
 */
export interface WindowEvent<D> {
  readonly name: string;
  dispatch(detail: D): void;
  /** Returns the unsubscribe function. */
  subscribe(handler: (detail: D) => void): () => void;
}

export function defineWindowEvent<D>(name: string, read: (detail: unknown) => D | null): WindowEvent<D> {
  return {
    name,
    dispatch: (detail) => { window.dispatchEvent(new CustomEvent<D>(name, { detail })); },
    subscribe: (handler) => {
      const listener = (event: Event) => {
        const detail = read((event as CustomEvent<unknown>).detail);
        if (detail !== null) handler(detail);
      };
      window.addEventListener(name, listener);
      return () => window.removeEventListener(name, listener);
    },
  };
}
