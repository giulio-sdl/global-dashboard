// Holding on to what the data sources send. `cached` keeps a value for a time
// and refreshes it when that is up; `forEachSymbol` loads something for every
// symbol of a list and says which ones it could not get, so that `cached` can
// ask for those alone a little later.

// Marks a result as missing some of its symbols and names them, without the
// mark showing up among its entries. When every one of `total` symbols is
// missing, the list is flagged as an outage: the source itself is down (the
// network, or the feed's history service), not one instrument.
export const INCOMPLETE = Symbol('incomplete');
export const markIncomplete = (results, failed, total = Infinity) => Object.defineProperty(results, INCOMPLETE, {
  value: Object.assign(failed, { outage: failed.outage || failed.length >= total }),
});
const RETRY_INCOMPLETE_MS = 20_000;

// Serves a cached value while fresh, shares one in-flight refresh between
// callers, and falls back to the last good value when the provider fails.
// The provider is sometimes slow (most of all around the US open), so once
// there is a value a caller waits only `patienceMs` for the refresh: after
// that it gets the previous value, and the refresh finishes in the background.
//
// A load can come back incomplete (see forEachSymbol): some symbols failed,
// because the network was not up yet when the computer woke, or because the
// feed is struggling and answers with nothing. Such a result is topped up with
// what was known before, and `load` is called again after
// `RETRY_INCOMPLETE_MS` with the incomplete value, so that it can ask for the
// missing symbols alone. While the very same symbols keep failing, each wait
// is twice the last: a symbol that has no data at all is not asked for
// endlessly. An outage is the exception: when everything is missing the
// source is down, it comes back all at once, and it is asked every time.
// Everything is loaded afresh once the cache time is up, as usual.
export function cached(ttlMs, load, patienceMs = 2_500) {
  let value = null;
  let at = 0; // when everything was last loaded
  let retryAt = Infinity; // when an incomplete value is next topped up
  let stuck = 0; // top-ups in a row that the same symbols failed in
  let pending = null;
  const keep = (loaded, everything) => {
    const failed = loaded?.[INCOMPLETE];
    const before = value?.[INCOMPLETE];
    const merged = value && (failed || !everything) ? { ...value, ...loaded } : loaded;
    value = failed ? markIncomplete(merged, failed) : merged;
    if (everything) at = Date.now();
    const same = failed && before && failed.length === before.length && failed.every((symbol) => before.includes(symbol));
    stuck = same && !failed.outage ? stuck + 1 : 0;
    retryAt = failed ? Date.now() + RETRY_INCOMPLETE_MS * 2 ** Math.min(stuck, 10) : Infinity;
  };
  return async () => {
    const stale = !value || Date.now() - at >= ttlMs;
    if (!stale && Date.now() < retryAt) return { value, at, error: null };
    pending ??= load(stale ? null : value)
      .then((v) => { keep(v, stale); return null; })
      .catch((err) => {
        if (!stale) retryAt = Date.now() + RETRY_INCOMPLETE_MS;
        return err.message || String(err);
      })
      .finally(() => { pending = null; });
    const slow = new Promise((resolve) => setTimeout(resolve, patienceMs, null));
    const error = await (value ? Promise.race([pending, slow]) : pending);
    if (!value) throw new Error(error || 'no data');
    return { value, at, error };
  };
}

// Runs `load` for every symbol, `concurrency` of them at a time. Symbols that
// fail get one more try; if any still fail the result names them, so it is not
// mistaken for the full picture. Given an earlier result that was incomplete
// (`known`), only the symbols it lacks are asked for.
export async function forEachSymbol(load, symbols, concurrency, known = null) {
  const results = {};
  const run = async (list) => {
    const queue = [...list];
    const failed = [];
    await Promise.all(Array.from({ length: concurrency }, async () => {
      for (let symbol; (symbol = queue.shift()); ) {
        try {
          const result = await load(symbol);
          if (result) results[symbol] = result;
        } catch {
          failed.push(symbol);
        }
      }
    }));
    return failed;
  };
  const failed = await run(await run(known?.[INCOMPLETE] ?? symbols));
  if (!known && symbols.length && failed.length === symbols.length) throw new Error('chart feed unavailable');
  return failed.length ? markIncomplete(results, failed, symbols.length) : results;
}
