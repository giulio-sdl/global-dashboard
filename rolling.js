// Markets that never close. A share's change over a day is counted from its
// last closing bell; a crypto asset has no bell, and the feed's "previous
// close" for one is simply its price at 4 p.m. in New York. So for these the
// periods are spans of the clock instead: the last 24 hours, the last 5 days
// (120 hours), and for months and years the same day and time of day that
// long ago, each counted back from the moment it is asked.
//
// The price at such a moment is read from the finest bars that reach it:
// ten-minute bars for about a week, hourly ones for about three months. Beyond
// that the feed has one close a day, so the price at an hour of that day is
// placed between the closes either side of it.

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
export const MINUTE_BAR_MS = 10 * 60_000;
export const HOUR_BAR_MS = HOUR_MS;
// A daily bar is stamped at midnight in New York and closes at 4 p.m. there.
const DAILY_CLOSE_AFTER_MS = 16 * HOUR_MS;

// The moment a span before `now`. A span is so many hours, or so many months:
// the same day of the month (its last day, where the month is shorter) at the
// same time of day.
export function momentBefore(now, span) {
  if (span.hours) return now - span.hours * HOUR_MS;
  const at = new Date(now);
  const then = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - span.months, 1, at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds(), at.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(then.getUTCFullYear(), then.getUTCMonth() + 1, 0)).getUTCDate();
  then.setUTCDate(Math.min(at.getUTCDate(), lastDay));
  return then.getTime();
}

// The price at a moment, from bars [start, close, high, low] each `barMs`
// long: the close of the last bar that had ended by then. Null when the bars
// do not reach back that far, or stop short of the moment by more than a few
// bars (a gap in the feed is not a price).
export function priceAt(bars, barMs, moment) {
  let found = null;
  for (const bar of bars ?? []) {
    if (bar[0] + barMs > moment) break;
    found = bar;
  }
  return found && moment - (found[0] + barMs) <= 6 * barMs ? found[1] : null;
}

// Beyond the reach of hourly bars: the price at a moment, placed in proportion
// between the daily close before it and the one after. With a close on one
// side only (the moment is past the last bar, or before the first), that close
// stands. Null when no close is within a day and a half.
export function betweenDailyCloses(bars, moment) {
  let before = null;
  let after = null;
  for (const bar of bars ?? []) {
    const closed = bar[0] + DAILY_CLOSE_AFTER_MS;
    if (closed <= moment) before = { at: closed, close: bar[1] };
    else if (!after) after = { at: closed, close: bar[1] };
  }
  const near = (side) => side && Math.abs(side.at - moment) <= 1.5 * DAY_MS;
  if (near(before) && near(after)) return before.close + (after.close - before.close) * ((moment - before.at) / (after.at - before.at));
  return near(before) ? before.close : near(after) ? after.close : null;
}

// The highest and lowest price since a moment, from the bars that ended after it.
export function rangeSince(bars, barMs, moment) {
  const since = (bars ?? []).filter((bar) => bar[0] + barMs > moment);
  if (!since.length) return null;
  return { high: Math.max(...since.map((bar) => bar[2])), low: Math.min(...since.map((bar) => bar[3])) };
}
