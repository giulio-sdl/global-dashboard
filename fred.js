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

const CSV_URL = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
const DAY_MS = 24 * 3600_000;
const YEARS_BACK = 11; // enough for a ten-year change

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
