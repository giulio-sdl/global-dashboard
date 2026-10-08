// How far an index has probably moved since its exchange closed. A cash index
// does not trade out of hours, so the move is read from an instrument that
// does: an index future, or a US-listed ETF holding the same market. The
// figure is that instrument's price now against its price at the closing bell.

const MINUTE_MS = 60_000;
// The proxy's price "at the bell" is its last trade in the 40 minutes before
// the close or, failing that, its first in the 160 minutes after: a US-listed
// ETF only starts pre-market trading after Asian exchanges have shut, up to
// two and a half hours after Seoul in winter. Any move in that gap is missed.
const BEFORE_CLOSE_MS = 40 * MINUTE_MS;
const AFTER_CLOSE_MS = 160 * MINUTE_MS;
const BAR_MS = 10 * MINUTE_MS;

// The UTC instant of a wall-clock time ("17:30") on a date ("2026-10-08") in a time zone.
export function zonedInstant(date, time, tz) {
  const guess = Date.parse(`${date}T${time}:00Z`);
  // What that instant reads on a clock in the zone, as "2026-10-08 19:30:00".
  const shown = new Date(guess).toLocaleString('sv-SE', { timeZone: tz, hourCycle: 'h23' });
  const offset = Date.parse(`${shown.replace(' ', 'T')}Z`) - guess;
  return guess - offset;
}

// The proxy's most recent price: its pre-market or after-hours trade when that
// is newer than the regular session, otherwise its last regular trade.
function latest(proxy) {
  const regularSessionRunning = proxy.ext?.type === 'PRE_MKT' && proxy.session === 'REG_MKT';
  return proxy.ext && !regularSessionRunning ? proxy.ext : proxy;
}

// `index` and `proxy` are quotes, `market` the index's entry in MARKETS, and
// `bars` the proxy's recent [start time, close] history in 10-minute bars.
// Returns null while the index is still in its session, and whenever the
// proxy did not trade near the close or has not traded since.
export function sinceClose(index, market, proxy, bars, now = Date.now()) {
  if (!index?.date || !market || !proxy || !bars?.length) return null;
  const close = zonedInstant(index.date, market.sessions.at(-1)[1], market.tz);
  if (now < close) return null;

  // The first bar that ends after the bell; the one before it ends at or before it.
  const next = bars.findIndex(([start]) => start + BAR_MS > close + BAR_MS / 2);
  if (next < 0) return null; // nothing has traded since the close
  const before = bars[next - 1];
  const after = bars[next];
  const reference = before && close - before[0] <= BEFORE_CLOSE_MS ? before : after[0] - close <= AFTER_CLOSE_MS ? after : null;
  if (!reference) return null;

  const live = latest(proxy);
  const pct = (live.last / reference[1] - 1) * 100;
  return { pct, level: index.last * (1 + pct / 100), time: live.time };
}
