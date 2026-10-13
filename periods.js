// The periods a change is measured over on the server's side: which session a
// quote belongs to, the close each period is counted back to from there, and
// the line drawn since. (Markets that never close are measured differently:
// see rolling.js.)
import { awaitingOpen, restoreLastSession } from './quote.js';

const DAY_MS = 24 * 3600_000;
const SPARK_MAX_POINTS = 300;

// Every period is measured from a closing level, counted back from the
// instrument's latest session (see sessionOf):
//   5 days          the close five sessions earlier
//   months, years   the last close on or before the same date that long ago
// `chart` is the bar size of the line drawn since then.
export const RANGES = {
  '1w': { sessions: 5, chart: 'hour' },
  '1m': { months: 1, chart: 'day' },
  '3m': { months: 3, chart: 'day' },
  '6m': { months: 6, chart: 'day' },
  '1y': { months: 12, chart: 'day' },
  '5y': { months: 60, chart: 'week' },
  '10y': { months: 120, chart: 'week' },
};

export function thin(bars) {
  if (bars.length <= SPARK_MAX_POINTS) return bars;
  const step = Math.ceil(bars.length / SPARK_MAX_POINTS);
  return bars.filter((_, i) => (bars.length - 1 - i) % step === 0);
}

// A bar's date. Daily and weekly bars are stamped at midnight New York time,
// which is the same calendar day in UTC.
export const barDate = (bar) => new Date(bar[0]).toISOString().slice(0, 10);

// "2026-03-31" six months back is "2025-09-30": the day is held within the month.
export function monthsBefore(date, months) {
  const [year, month, day] = date.split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 1 - months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(day, lastDay));
  return first.toISOString().slice(0, 10);
}

// The day after a date, skipping the weekend.
export function nextWeekday(date) {
  const day = new Date(`${date}T00:00:00Z`);
  do day.setUTCDate(day.getUTCDate() + 1); while (day.getUTCDay() % 6 === 0);
  return day.toISOString().slice(0, 10);
}

// The session a quote's figures belong to: its date, and the daily bars that
// closed before it. The date on the quote does not say. The feed dates the
// closing quote of a US-listed fund a day early, dates a future by the
// calendar day of its last trade, and moves on to today before a market has
// opened. What the quote does state is the close its change is measured from,
// so that close is looked for among the latest daily bars. Where it is not
// there (a future settles away from its last trade), or two bars in a row
// carry it (nothing moved, a holiday), the dates decide instead.
export function sessionOf(quote, daily = []) {
  // A quote the feed has cleared ahead of the open is read as it is shown: as its last session.
  const q = quote && awaitingOpen(quote) ? { ...quote } : quote;
  if (q !== quote) restoreLastSession(q, daily);
  const quoted = q?.date ?? new Date().toISOString().slice(0, 10);
  const stated = q && !awaitingOpen(q) ? q.prevClose : null;
  const matches = (bar) => bar && stated != null && Math.abs(bar[1] - stated) <= 0.75 * 10 ** -q.dp;
  for (let i = daily.length - 1; i >= Math.max(0, daily.length - 3); i--) {
    if (!matches(daily[i])) continue;
    if (matches(daily[i - 1])) break;
    const before = barDate(daily[i]);
    const date = daily[i + 1] ? barDate(daily[i + 1]) : quoted > before ? quoted : nextWeekday(before);
    return { date, closed: daily.slice(0, i + 1) };
  }
  const latest = daily.length ? barDate(daily.at(-1)) : quoted;
  const date = quoted > latest ? quoted : latest;
  return { date, closed: daily.filter((bar) => barDate(bar) < date) };
}

// The bar whose close a period is measured from, or undefined when the
// history does not reach back that far. A weekly bar is stamped on the Sunday
// and closes on the Friday, five days later.
export function referenceBar(spec, session, weekly) {
  if (spec.sessions) return session.closed.at(-spec.sessions);
  const target = monthsBefore(session.date, spec.months);
  if (spec.chart === 'week') return weekly?.filter((bar) => barDate([bar[0] + 5 * DAY_MS]) <= target).at(-1);
  return session.closed.filter((bar) => barDate(bar) <= target).at(-1);
}

// One instrument's line over a period, and the close the period's change is
// measured from (`from`, null when the history does not reach back that far).
// `charted` holds the bars of the size the period is drawn in.
export function lineFor(spec, session, daily, weekly, charted) {
  const start = referenceBar(spec, session, weekly);
  // Where the history is shorter than the period, the line starts at the
  // first bar there is, and no change over the period is given.
  const reference = start ?? (spec.sessions ? null : charted?.[0]);
  if (!reference) return null;
  // The line starts at the reference close and runs through everything since.
  const since = (bars) => (bars ?? []).filter((bar) => barDate(bar) > barDate(reference));
  let line = since(charted);
  let step = spec.chart;
  // Some instruments have no hourly bars; draw their five days from daily closes.
  if (step === 'hour' && line.length < 2) { line = since(daily); step = 'day'; }
  const series = thin([reference, ...line]);
  return { spark: { t: series.map((bar) => bar[0]), c: series.map((bar) => bar[1]), base: reference[1], step }, from: start?.[1] ?? null };
}
