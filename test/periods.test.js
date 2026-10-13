// Which session a quote belongs to, and so which close each period is counted
// back to (periods.js).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { barDate, lineFor, monthsBefore, nextWeekday, RANGES, referenceBar, sessionOf, thin } from '../periods.js';

const bar = (date, close) => [Date.parse(`${date}T04:00:00Z`), close, close, close];
const quote = (date, last, prev, dp = 2) => ({ date, last, prevClose: prev, change: last - prev, dp, high: last, low: last });
// As the feed sends it shortly before the open: no change, no range.
const cleared = (date, last, dp = 2) => ({ date, last, prevClose: last, change: 0, changePct: 0, dp, high: null, low: null });
const day = (b) => (b ? barDate(b).slice(5) : '-');

// Thursday 8 October 2026 is the latest full session; Friday the 9th is today.
const closes = { '09-07': 96, '09-08': 97, '09-09': 97.5, '09-10': 98, '09-11': 98.2, '09-30': 94.54, '10-01': 94.4, '10-02': 94.25, '10-05': 94.13, '10-06': 94.36, '10-07': 94.31, '10-08': 94.63 };
const hist = (upTo, extra = {}) => Object.entries({ ...closes, ...extra }).filter(([d]) => d <= upTo).sort().map(([d, c]) => bar(`2026-${d}`, c));

// The session, and the days whose closes five days and one month are measured from.
const read = (q, bars) => {
  const session = sessionOf(q, bars);
  return [session.date.slice(5), day(referenceBar(RANGES['1w'], session)), day(referenceBar(RANGES['1m'], session))];
};

describe('the session a quote belongs to', () => {
  const cases = [
    ['in session, today\'s bar present', quote('2026-10-09', 95, 94.63), hist('10-09', { '10-09': 94.9 }), ['10-09', '10-02', '09-09']],
    ['in session, no bar for today yet', quote('2026-10-09', 95, 94.63), hist('10-08'), ['10-09', '10-02', '09-09']],
    ['US fund after the close, quote dated a day early', quote('2026-10-07', 94.63, 94.31), hist('10-08'), ['10-08', '10-01', '09-08']],
    ['market not open yet, quote already dated today', quote('2026-10-09', 94.63, 94.31), hist('10-08'), ['10-08', '10-01', '09-08']],
    ['future in a new session, dated by its last trade', quote('2026-10-08', 95.2, 94.63), hist('10-08'), ['10-09', '10-02', '09-09']],
    ['same on a Friday evening: the session is Monday\'s', quote('2026-10-09', 95.2, 94.9), hist('10-09', { '10-09': 94.9 }), ['10-12', '10-05', '09-11']],
    ['settlement differs from every bar: dates decide', quote('2026-10-09', 95, 94.7), hist('10-09', { '10-09': 94.9 }), ['10-09', '10-02', '09-09']],
    ['same, quote dated a day early but a newer bar exists', quote('2026-10-07', 94.63, 94.2), hist('10-08'), ['10-08', '10-01', '09-08']],
    ['unchanged on the day, today\'s bar equals the close', quote('2026-10-09', 94.63, 94.63), hist('10-09', { '10-09': 94.63 }), ['10-09', '10-02', '09-09']],
    ['unchanged, today\'s bar is an hour stale', quote('2026-10-09', 94.63, 94.63), hist('10-09', { '10-09': 94.8 }), ['10-09', '10-02', '09-09']],
    ['two equal closes in a row, then a move', quote('2026-10-09', 95, 94.63), hist('10-09', { '10-07': 94.63, '10-09': 94.9 }), ['10-09', '10-02', '09-09']],
    ['holiday week of repeated closes, first day back', quote('2026-10-08', 94.7, 94.25), hist('10-08', { '10-05': 94.25, '10-06': 94.25, '10-07': 94.25, '10-08': 94.7 }), ['10-08', '10-01', '09-08']],
    ['pre-open, last session restored, early bar on top', quote('2026-10-09', 94.63, 94.31), hist('10-09', { '10-09': 94.63 }), ['10-08', '10-01', '09-08']],
    ['feed cleared before the open, quote still dated yesterday', cleared('2026-10-08', 94.63), hist('10-08'), ['10-08', '10-01', '09-08']],
    ['feed cleared before the open, quote dated today', cleared('2026-10-09', 94.63), hist('10-08'), ['10-08', '10-01', '09-08']],
    ['feed cleared, early bar for today on top', cleared('2026-10-09', 94.63), hist('10-09', { '10-09': 94.63 }), ['10-08', '10-01', '09-08']],
    ['feed cleared, history does not reach the quote: dates decide', cleared('2026-10-09', 95.5), hist('10-08'), ['10-09', '10-02', '09-09']],
    // A known gap: with one of the last five closes missing, five days start a session too early.
    ['yesterday\'s bar not published yet (known gap: one late)', quote('2026-10-09', 95, 94.63), hist('10-07'), ['10-09', '10-01', '09-09']],
    ['half-cent bar close against a rounded quote', quote('2026-10-07', 77.87, 77.14), [...hist('10-06'), bar('2026-10-07', 77.145), bar('2026-10-08', 77.87)], ['10-08', '10-01', '09-08']],
    ['no history', quote('2026-10-09', 95, 94.63), undefined, ['10-09', '-', '-']],
  ];
  for (const [label, q, bars, want] of cases) {
    test(label, () => assert.deepEqual(read(q, bars), want));
  }

  test('no quote yet: today, or the latest bar if that is later', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-13T08:00:00Z') });
    assert.deepEqual(read(undefined, hist('10-08')), ['10-13', '10-02', '09-11']);
    assert.deepEqual(read(undefined, [...hist('10-08'), bar('2026-10-14', 95)]), ['10-14', '10-02', '09-11']);
  });

  // The case above comes out the same by dates. Here it does not: a future
  // dated by its last trade is in the next session only if its close is found.
  test('a close is found within three quarters of the last decimal shown, and no further', () => {
    const future = quote('2026-10-08', 78.2, 77.14);
    assert.deepEqual(read(future, [...hist('10-07'), bar('2026-10-08', 77.145)]), ['10-09', '10-02', '09-09']);
    assert.deepEqual(read(future, [...hist('10-07'), bar('2026-10-08', 77.15)]), ['10-08', '10-01', '09-08']);
  });

  test('a cleared quote is read without being changed', () => {
    const q = cleared('2026-10-09', 94.63);
    sessionOf(q, hist('10-08'));
    assert.deepEqual(q, cleared('2026-10-09', 94.63));
  });
});

describe('counting back', () => {
  test('months before a date: the day is held within the month', () => {
    assert.deepEqual(
      [['2026-03-31', 6], ['2026-10-09', 1], ['2026-01-15', 1], ['2028-02-29', 12], ['2026-10-12', 120]].map(([date, months]) => monthsBefore(date, months)),
      ['2025-09-30', '2026-09-09', '2025-12-15', '2027-02-28', '2016-10-12'],
    );
  });

  test('the day after a date, skipping the weekend', () => {
    assert.deepEqual(['2026-10-08', '2026-10-09', '2026-10-10', '2026-12-31'].map(nextWeekday), ['2026-10-09', '2026-10-12', '2026-10-12', '2027-01-01']);
  });

  test('months and years: the last close on or before the same date that long ago', () => {
    const session = sessionOf(quote('2026-10-09', 95, 94.63), [bar('2026-07-08', 90), bar('2026-07-09', 91), bar('2026-07-10', 92), ...hist('10-08')]);
    assert.equal(day(referenceBar(RANGES['3m'], session)), '07-09');
    // Where that date did not trade, the close before it.
    assert.equal(day(referenceBar(RANGES['1m'], { ...session, date: '2026-10-29' })), '09-11');
  });

  // A weekly bar is stamped on the Sunday and closes on the Friday.
  test('five and ten years: the last weekly close on or before that date', () => {
    const weeks = [bar('2021-09-19', 50), bar('2021-09-26', 51), bar('2021-10-03', 52), bar('2021-10-10', 53)];
    const from = (date) => day(referenceBar(RANGES['5y'], { date, closed: [] }, weeks));
    assert.equal(from('2026-10-08'), '10-03'); // the week of 3 October 2021 closed on Friday the 8th
    assert.equal(from('2026-10-07'), '09-26'); // on the 7th it had not closed yet
  });

  test('a period the history does not reach back to has no reference', () => {
    const session = sessionOf(quote('2026-10-09', 95, 94.63), hist('10-08'));
    assert.equal(referenceBar(RANGES['3m'], session), undefined);
    assert.equal(referenceBar(RANGES['5y'], session, [bar('2024-01-07', 50)]), undefined);
    assert.equal(referenceBar(RANGES['5y'], session, undefined), undefined);
    assert.equal(referenceBar(RANGES['1w'], sessionOf(quote('2026-10-09', 95, 94.63), hist('10-08').slice(-4))), undefined);
  });
});

describe('the line over a period', () => {
  const daily = hist('10-08');
  const session = sessionOf(quote('2026-10-09', 95, 94.63), daily);
  const days = (spark) => spark.t.map((t) => barDate([t]).slice(5));

  test('starts at the reference close and runs through everything since', () => {
    const { spark, from } = lineFor(RANGES['1m'], session, daily, null, daily);
    assert.deepEqual(days(spark), ['09-09', '09-10', '09-11', '09-30', '10-01', '10-02', '10-05', '10-06', '10-07', '10-08']);
    assert.deepEqual([spark.c[0], spark.c.at(-1), spark.base, spark.step, from], [97.5, 94.63, 97.5, 'day', 97.5]);
  });

  test('history shorter than the period: the line starts at the first bar, and no change is given', () => {
    const { spark, from } = lineFor(RANGES['3m'], session, daily, null, daily);
    assert.deepEqual([days(spark)[0], spark.t.length, spark.base, from], ['09-07', 12, 96, null]);
  });

  test('five days are drawn from hourly bars since the reference close', () => {
    const hour = (date, time, close) => [Date.parse(`${date}T${time}:00Z`), close, close, close];
    const hourly = [hour('2026-10-02', '19:00', 94.2), hour('2026-10-05', '14:00', 94.0), hour('2026-10-05', '15:00', 94.1), hour('2026-10-09', '14:00', 95)];
    const { spark, from } = lineFor(RANGES['1w'], session, daily, null, hourly);
    assert.deepEqual(spark.c, [94.25, 94.0, 94.1, 95]); // Friday the 2nd's close, then every hour after that day
    assert.deepEqual([days(spark)[0], spark.base, spark.step, from], ['10-02', 94.25, 'hour', 94.25]);
  });

  test('...or from daily closes where there are no hourly bars', () => {
    for (const hourly of [undefined, [], [bar('2026-10-09', 95)]]) {
      const { spark } = lineFor(RANGES['1w'], session, daily, null, hourly);
      assert.deepEqual([days(spark), spark.step], [['10-02', '10-05', '10-06', '10-07', '10-08'], 'day']);
    }
  });

  test('five days with fewer than five closes behind them: no line', () => {
    const few = daily.slice(-4);
    assert.equal(lineFor(RANGES['1w'], sessionOf(quote('2026-10-09', 95, 94.63), few), few, null, few), null);
  });

  test('five and ten years are drawn from weekly bars', () => {
    const weeks = [bar('2021-09-26', 51), bar('2021-10-03', 52), bar('2021-10-10', 53), bar('2026-10-04', 94.63)];
    const { spark, from } = lineFor(RANGES['5y'], session, daily, weeks, weeks);
    assert.deepEqual([spark.c, spark.step, from], [[52, 53, 94.63], 'week', 52]);
  });

  test('a long line is thinned to a few hundred points, always keeping the latest', () => {
    const bars = Array.from({ length: 700 }, (_, i) => [i, i, i, i]);
    const thinned = thin(bars);
    assert.deepEqual([thinned.length, thinned.at(-1), thinned.at(-2)], [234, bars[699], bars[696]]);
    assert.equal(thin(bars.slice(0, 300)).length, 300);
  });
});
