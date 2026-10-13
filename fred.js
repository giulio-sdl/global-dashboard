// FRED, the St. Louis Fed's data service: official daily series, among them the
// Treasury's constant-maturity yields. It is the second source for the yield
// rows: when the quote feed has no history for one, its 5-day to 10-year
// changes and trend lines are drawn from FRED instead.
//
// FRED is end-of-day and a business day behind, so it cannot supply live
// yields. Its figures are also not quite the feed's: FRED quotes the yield of a
// constant maturity, the feed that of the latest bill or bond sold. For a
// 10-year the two are within a couple of basis points; for a 3-month bill they
// can be five to ten apart, which then shows in the changes measured from it.

import { INCOMPLETE } from './cache.js';
import { barDate } from './periods.js';
import { awaitingOpen } from './quote.js';

const CSV_URL = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
const DAY_MS = 24 * 3600_000;
const YEARS_BACK = 11; // enough for a ten-year change
const BACKUP_AFTER_MS = 12 * 3600_000;

// A series as daily bars in the shape the charts use: [time, close, high, low],
// stamped like the feed's own daily bars (midnight in New York).
export async function loadFredSeries(id) {
  const since = new Date(Date.now() - YEARS_BACK * 366 * DAY_MS).toISOString().slice(0, 10);
  const res = await fetch(`${CSV_URL}?id=${encodeURIComponent(id)}&cosd=${since}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`fred.stlouisfed.org responded ${res.status}`);
  const bars = (await res.text())
    .split('\n')
    .slice(1) // the header row
    .map((line) => line.trim().split(','))
    // A holiday has a date and no value.
    .filter(([date, value]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && value !== '' && Number.isFinite(Number(value)))
    .map(([date, value]) => [Date.parse(`${date}T04:00:00Z`), Number(value), Number(value), Number(value)]);
  if (!bars.length) throw new Error(`FRED has no data for ${id}`);
  return bars;
}

// The same series as weekly bars. Like the feed's, each is stamped on the
// Sunday that starts its week and carries the week's last close.
export function weekly(bars) {
  const weeks = new Map();
  for (const bar of bars) {
    const day = new Date(bar[0]);
    const sunday = bar[0] - day.getUTCDay() * DAY_MS;
    const week = weeks.get(sunday);
    weeks.set(sunday, week ? [sunday, bar[1], Math.max(week[2], bar[2]), Math.min(week[3], bar[3])] : [sunday, bar[1], bar[2], bar[3]]);
  }
  return [...weeks.values()];
}

// Where the feed has had no history for a Treasury yield for half a day, the
// official series stands in. It has daily and weekly closes but nothing within
// the day, so the hourly history goes without. The bars are marked with their
// source, for the page to say so.
//
// `loaded` is a history load that names the symbols it lacks (see cache.js),
// `source` the bars it is made of (their `interval`, and how many `daysBack`
// they reach), and `charted` when the feed last had bars for each symbol. The
// rest is where to look things up: `seriesOf` a symbol is the FRED series it
// names, `load` fetches a series as daily bars, `quoteOf` a symbol is its
// latest quote.
export async function standIn(loaded, source, charted, { seriesOf, load, quoteOf }) {
  if (source.interval === '1H') return loaded;
  for (const symbol of loaded[INCOMPLETE] ?? []) {
    const id = seriesOf(symbol);
    if (!id || Date.now() - (charted.get(symbol) ?? 0) < BACKUP_AFTER_MS) continue;
    const daily = await load(id).catch(() => null);
    if (!daily) continue;
    const bars = source.interval === '1W' ? weekly(daily) : withYesterday(daily.filter((bar) => bar[0] >= Date.now() - source.daysBack * DAY_MS), quoteOf(symbol));
    loaded[symbol] = Object.assign(bars, { source: 'FRED' });
  }
  return loaded;
}

// FRED publishes a day's yield the following afternoon, so through most of a
// session its last close is from two sessions ago, and five sessions back
// would be counted one too far. The close the quote's own change is measured
// from is the missing day's, so it is added. (After a market holiday this adds
// a day that did not trade: the five days then start one session late.)
export function withYesterday(daily, quote) {
  if (!daily.length || !quote?.date || quote.prevClose == null || awaitingOpen(quote)) return daily;
  const before = new Date(`${quote.date}T04:00:00Z`);
  do before.setUTCDate(before.getUTCDate() - 1); while (before.getUTCDay() % 6 === 0);
  if (barDate(daily.at(-1)) >= barDate([before.getTime()])) return daily;
  return [...daily, [before.getTime(), quote.prevClose, quote.prevClose, quote.prevClose]];
}
