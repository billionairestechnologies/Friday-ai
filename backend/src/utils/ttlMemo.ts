/**
 * Tiny async memoizer: caches a result for `ttlMs`, and collapses concurrent calls for the same key
 * into one in-flight promise (single-flight). Failures are never cached.
 *
 * Used for provider/model lookups that used to hit the database on EVERY chat request — several
 * sequential Supabase round trips (provider row, API key row, model rows) before the first token was
 * even requested. Those rows change only when an admin edits them, so a short TTL plus explicit
 * invalidation on every admin mutation removes that latency without ever serving stale config for long.
 */
type Entry<T> = { at: number; value?: T; inflight?: Promise<T> };

const registry = new Set<Map<string, Entry<unknown>>>();

export type Memoized<A extends unknown[], T> = ((...args: A) => Promise<T>) & {
  /** Drops one cached entry immediately, by the same key `keyOf` would produce for it — for
   *  when a mutation makes a specific cached value stale before its TTL would (e.g. a profile
   *  field a request just changed), instead of waiting it out or clearing every key. */
  invalidate: (key: string) => void;
};

export function memoAsync<A extends unknown[], T>(
  ttlMs: number,
  fn: (...args: A) => Promise<T>,
  keyOf: (...args: A) => string = (...args) => JSON.stringify(args),
): Memoized<A, T> {
  const store = new Map<string, Entry<T>>();
  registry.add(store as Map<string, Entry<unknown>>);
  const memoized = ((...args: A) => {
    const key = keyOf(...args);
    const hit = store.get(key);
    const now = Date.now();
    if (hit?.value !== undefined && now - hit.at < ttlMs) return Promise.resolve(hit.value);
    if (hit?.inflight) return hit.inflight;
    const inflight = fn(...args).then(
      (value) => {
        store.set(key, { at: Date.now(), value });
        return value;
      },
      (err) => {
        store.delete(key);
        throw err;
      },
    );
    store.set(key, { at: hit?.at ?? 0, inflight });
    return inflight;
  }) as Memoized<A, T>;
  memoized.invalidate = (key: string) => store.delete(key);
  return memoized;
}

/** Drops every memoized value (call after any admin change to providers, keys or models). */
export function invalidateMemoized() {
  for (const store of registry) store.clear();
}
