// FRED as the stand-in for Treasury yield history (fred.js): its weekly bars,
// the rule for using it, and the day it lacks. The series here is made up; the
// cases that read the real one run only with LIVE=1, as they need the network.
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { INCOMPLETE, markIncomplete } from '../cache.js';
import { loadFredSeries, standIn, weekly, withYesterday } from '../fred.js';

const DAY_MS = 24 * 3600_000;
const HOUR_MS = 3600_000;
const bar = (date, value) => [Date.parse(`${date}T04:00:00Z`), value, value, value];
const day = (b) => new Date(b[0]).toISOString().slice(0, 10);

// It is the morning of Tuesday 13 October 2026, and FRED's latest figure is
// Friday's. Eleven years of weekdays, each with a yield a little different
// from the day before.
const NOW = Date.parse('2026-10-13T08:00:00Z');
const series = [];
for (let t = Date.parse('2015-10-05T04:00:00Z'); t <= Date.parse('2026-10-09T04:00:00Z'); t += DAY_MS) {
  if (new Date(t).getUTCDay() % 6 === 0) continue;
  const value = 2 + (series.length % 300) / 100;
  series.push([t, value, value, value]);
}

describe('weekly bars', () => {
  // A week with a holiday on the Monday, a full one, and one that has only begun.
  const daily = [
    bar('2026-09-08', 5.1), bar('2026-09-09', 5.3), bar('2026-09-10', 5.0), bar('2026-09-11', 5.2),
    bar('2026-09-14', 5.25), bar('2026-09-15', 5.4), bar('2026-09-16', 5.15), bar('2026-09-17', 5.3), bar('2026-09-18', 5.35),
    bar('2026-09-21', 5.31),
  ];
  const weeks = weekly(daily);

  test('each is stamped on the Sunday that starts its week', () => {
    assert.deepEqual(weeks.map(day), ['2026-09-06', '2026-09-13', '2026-09-20']);
  });
  test('a week\'s close is its last daily close', () => {
    assert.deepEqual(weeks.map((week) => week[1]), [5.2, 5.35, 5.31]);
  });
  test('its high and low are the highest and lowest of the week', () => {
    assert.deepEqual(weeks.map((week) => [week[2], week[3]]), [[5.3, 5.0], [5.4, 5.15], [5.31, 5.31]]);
  });
});

describe('the live series', { skip: process.env.LIVE ? false : 'asks fred.stlouisfed.org: run with LIVE=1' }, () => {
  let bars;
  let weeks;
  before(async () => {
    bars = await loadFredSeries('DGS10');
    weeks = weekly(bars);
  });
  test('10-year series loads', () => {
    const last = bars.at(-1);
    assert.ok(bars.length > 2500 && last[1] > 0 && last[1] < 20, `${bars.length} daily closes, latest ${last[1]}%`);
  });
  test('reaches back more than ten years', () => {
    assert.ok(Date.now() - bars[0][0] > 10.5 * 365 * DAY_MS, `first close ${day(bars[0])}`);
  });
  test('holidays are left out, order is by date', () => {
    assert.ok(bars.every((b, i) => Number.isFinite(b[1]) && (i === 0 || b[0] > bars[i - 1][0])));
  });
  test('weekly bars are stamped on Sundays and close on the week\'s last day', () => {
    assert.ok(weeks.every((b) => new Date(b[0]).getUTCDay() === 0));
    assert.equal(weeks.at(-1)[1], bars.at(-1)[1]);
  });
  test('a week\'s close is its last daily close', () => {
    const lastDay = bars.filter((b) => b[0] >= weeks.at(-2)[0] && b[0] < weeks.at(-1)[0]).at(-1);
    assert.equal(weeks.at(-2)[1], lastDay[1]);
  });
});

// The feed's three bar sizes, as server.js asks for them.
const HISTORY = { hour: { interval: '1H', daysBack: 14 }, day: { interval: '1D', daysBack: 400 }, week: { interval: '1W', daysBack: 3700 } };

// A history load in which the feed had nothing for `symbols`; the S&P 500 it did have.
const missing = (symbols) => markIncomplete({ '.SPX': [[1, 2, 2, 2]] }, symbols);
// Where the stand-in looks things up: only the 10-year yield names a series.
const lookups = ({ fred = series, quotes = {} } = {}) => ({
  seriesOf: (symbol) => ({ US10Y: 'DGS10' })[symbol],
  load: async () => { if (!fred) throw new Error('FRED down'); return fred; },
  quoteOf: (symbol) => quotes[symbol],
});
const never = new Map(); // the feed has not had bars for anything
const stopClock = (t) => t.mock.timers.enable({ apis: ['Date'], now: NOW });

describe('when FRED stands in', () => {
  test('daily history missing for a yield: FRED stands in', async (t) => {
    stopClock(t);
    const out = await standIn(missing(['US10Y', '.DJI']), HISTORY.day, never, lookups());
    // 400 days back from that Tuesday morning is 8 September 2025, 08:00 UTC.
    assert.deepEqual([out.US10Y.source, day(out.US10Y[0]), day(out.US10Y.at(-1)), out.US10Y.length], ['FRED', '2025-09-09', '2026-10-09', 284]);
    assert.equal(out['.DJI'], undefined); // the Dow, which has no series, is left missing
    assert.deepEqual(out['.SPX'], [[1, 2, 2, 2]]);
  });
  test('...and it is still named as missing, so the feed is asked again', async (t) => {
    stopClock(t);
    const out = await standIn(missing(['US10Y', '.DJI']), HISTORY.day, never, lookups());
    assert.deepEqual([...out[INCOMPLETE]], ['US10Y', '.DJI']);
  });
  test('weekly history: FRED\'s weekly closes', async (t) => {
    stopClock(t);
    const out = await standIn(missing(['US10Y']), HISTORY.week, never, lookups());
    assert.deepEqual([out.US10Y.source, day(out.US10Y[0]), day(out.US10Y.at(-1)), out.US10Y.at(-1)[1]], ['FRED', '2015-10-04', '2026-10-04', series.at(-1)[1]]);
  });
  test('hourly history: no stand-in (FRED has nothing within the day)', async (t) => {
    stopClock(t);
    const out = await standIn(missing(['US10Y']), HISTORY.hour, never, lookups());
    assert.equal(out.US10Y, undefined);
  });
  test('feed had bars an hour ago: its own bars are kept, no stand-in', async (t) => {
    stopClock(t);
    const out = await standIn(missing(['US10Y']), HISTORY.day, new Map([['US10Y', NOW - HOUR_MS]]), lookups());
    assert.equal(out.US10Y, undefined); // left for the merge with what was known
  });
  test('feed last had bars 13 hours ago: FRED stands in', async (t) => {
    stopClock(t);
    const out = await standIn(missing(['US10Y']), HISTORY.day, new Map([['US10Y', NOW - 13 * HOUR_MS]]), lookups());
    assert.equal(out.US10Y.source, 'FRED');
  });
  test('FRED unreachable too: nothing breaks', async (t) => {
    stopClock(t);
    const out = await standIn(missing(['US10Y']), HISTORY.day, never, lookups({ fred: null }));
    assert.deepEqual([out.US10Y, out['.SPX']], [undefined, [[1, 2, 2, 2]]]); // the yield stays missing, the rest is untouched
  });
  test('a complete load is returned as it is', async (t) => {
    stopClock(t);
    const loaded = { '.SPX': [[1, 2, 2, 2]] };
    assert.equal(await standIn(loaded, HISTORY.day, never, lookups()), loaded);
    assert.deepEqual(Object.keys(loaded), ['.SPX']);
  });
});

// FRED is a business day behind: the quote's previous close stands for the day it lacks.
describe('the day FRED lacks', () => {
  const week = [bar('2026-10-05', 5.2), bar('2026-10-06', 5.21), bar('2026-10-07', 5.28), bar('2026-10-08', 5.22), bar('2026-10-09', 5.25)];
  const live = (date, prev) => ({ date, prevClose: prev, last: prev + 0.01, change: 0.01, high: prev + 0.02, low: prev });
  const lastTwo = (bars) => bars.slice(-2).map((b) => `${day(b).slice(5)}=${b[1]}`).join(', ');

  test('Tuesday, FRED still at Friday: Monday is added from the quote', () => {
    const out = withYesterday(week, live('2026-10-13', 5.31));
    assert.deepEqual([out.length, lastTwo(out), out.at(-1)], [6, '10-09=5.25, 10-12=5.31', [Date.parse('2026-10-12T04:00:00Z'), 5.31, 5.31, 5.31]]);
    assert.equal(week.length, 5); // the series itself is not added to
  });
  test('Monday, FRED at Friday: nothing to add', () => {
    assert.equal(withYesterday(week, live('2026-10-12', 5.26)), week);
  });
  test('Monday, FRED still at Thursday: Friday is added (the weekend is skipped)', () => {
    assert.equal(lastTwo(withYesterday(week.slice(0, 4), live('2026-10-12', 5.26))), '10-08=5.22, 10-09=5.26');
  });
  test('quote cleared ahead of the open: left alone', () => {
    assert.equal(withYesterday(week, { date: '2026-10-13', prevClose: 5.31, last: 5.31, change: 0, high: null, low: null }), week);
  });
  test('no quote yet: left alone', () => {
    assert.equal(withYesterday(week, undefined), week);
  });
  test('the stand-in applies it to the daily bars', async (t) => {
    stopClock(t);
    const out = await standIn(markIncomplete({}, ['US10Y']), HISTORY.day, never, lookups({ quotes: { US10Y: live('2026-10-13', 5.5) } }));
    assert.deepEqual([out.US10Y.source, lastTwo(out.US10Y), out.US10Y.length], ['FRED', `10-09=${series.at(-1)[1]}, 10-12=5.5`, 285]);
    assert.equal(day(series.at(-1)), '2026-10-09'); // what FRED sent is kept as it came
  });
  test('...and not to the weekly ones', async (t) => {
    stopClock(t);
    const out = await standIn(markIncomplete({}, ['US10Y']), HISTORY.week, never, lookups({ quotes: { US10Y: live('2026-10-13', 5.5) } }));
    assert.deepEqual([day(out.US10Y.at(-1)), out.US10Y.at(-1)[1]], ['2026-10-04', series.at(-1)[1]]);
  });
});
