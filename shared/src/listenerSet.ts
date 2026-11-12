/**
 * Fan-out to subscribed listeners. An emit calls the listeners subscribed
 * when it started, each in its own try, so one that throws or unsubscribes
 * cannot keep the others from hearing it, nor fail the emitter. A thrown
 * error goes to onError; without one it is dropped.
 */

type Listener<Args extends unknown[]> = (...args: Args) => void;

export interface ListenerSetOptions {
  onError?: (error: unknown) => void;
}

export interface ListenerSet<Args extends unknown[]> {
  subscribe(listener: Listener<Args>): () => void;
  emit(...args: Args): void;
}

function callEach<Args extends unknown[]>(listeners: Iterable<Listener<Args>>, args: Args, options: ListenerSetOptions): void {
  for (const listener of [...listeners]) {
    try {
      listener(...args);
    } catch (error) {
      options.onError?.(error);
    }
  }
}

export function createListenerSet<Args extends unknown[]>(options: ListenerSetOptions = {}): ListenerSet<Args> {
  const listeners = new Set<Listener<Args>>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    emit(...args) {
      callEach(listeners, args, options);
    },
  };
}

/** Listener sets per key (a run, a thread); a key is dropped with its last listener. */
export interface KeyedListenerSets<K, Args extends unknown[]> {
  subscribe(key: K, listener: Listener<Args>): () => void;
  emit(key: K, ...args: Args): void;
}

export function createKeyedListenerSets<K, Args extends unknown[]>(options: ListenerSetOptions = {}): KeyedListenerSets<K, Args> {
  const byKey = new Map<K, Set<Listener<Args>>>();
  return {
    subscribe(key, listener) {
      let listeners = byKey.get(key);
      if (!listeners) {
        listeners = new Set();
        byKey.set(key, listeners);
      }
      listeners.add(listener);
      const own = listeners;
      return () => {
        own.delete(listener);
        if (own.size === 0 && byKey.get(key) === own) byKey.delete(key);
      };
    },
    emit(key, ...args) {
      const listeners = byKey.get(key);
      if (listeners) callEach(listeners, args, options);
    },
  };
}
