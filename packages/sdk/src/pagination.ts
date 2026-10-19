import type { CursorPage } from './types.js';

export interface PaginateOptions {
  /** Stop after this many pages. */
  maxPages?: number | undefined;
  /** Stop after yielding this many items. */
  maxItems?: number | undefined;
}

/**
 * Iterate every item across cursor pages.
 *
 * @example
 *   for await (const b of paginate((cursor) => ferry.bookings.list({ cursor, limit: 50 }))) { ... }
 *   // or, equivalently:
 *   for await (const b of ferry.bookings.iterate({ limit: 50 })) { ... }
 */
export async function* paginate<T>(
  fetchPage: (cursor: string | undefined) => Promise<CursorPage<T>>,
  opts: PaginateOptions = {},
): AsyncGenerator<T, void, undefined> {
  const maxPages = opts.maxPages ?? Number.POSITIVE_INFINITY;
  const maxItems = opts.maxItems ?? Number.POSITIVE_INFINITY;
  let cursor: string | undefined;
  let yielded = 0;
  const seen = new Set<string>();
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage(cursor);
    for (const item of res.data) {
      if (yielded >= maxItems) return;
      yield item;
      yielded++;
    }
    const next = res.next_cursor;
    // Stop on exhaustion, a reached item cap, or a repeated cursor (defensive against server loops).
    if (!next || yielded >= maxItems || seen.has(next) || res.data.length === 0) return;
    seen.add(next);
    cursor = next;
  }
}

/** Collect an async iterable into an array (convenience for scripts; mind the memory). */
export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}
