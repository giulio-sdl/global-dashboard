// Spans of the clock for markets that never close (rolling.js).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { betweenDailyCloses, HOUR_BAR_MS, MINUTE_BAR_MS, momentBefore, priceAt, rangeSince } from '../rolling.js';

const at = (iso) => Date.parse(iso);
const iso = (ms) => `${new Date(ms).toISOString().slice(0, 16)}Z`;
const bar = (start, close, high = close, low = close) => [at(start), close, high, low];

describe('the moment a span ago', () => {
  const cases = [
    ['24 hours before', '2026-10-12T07:45:00Z', { hours: 24 }, '2026-10-11T07:45Z'],
    ['5 days is 120 hours, weekend included', '2026-10-12T07:45:00Z', { hours: 120 }, '2026-10-07T07:45Z'],
    ['1 month: same day, same time', '2026-10-12T07:45:00Z', { months: 1 }, '2026-09-12T07:45Z'],
    ['6 months from 31 Aug: February has no 31st', '2026-08-31T23:10:00Z', { months: 6 }, '2026-02-28T23:10Z'],
    ['1 year across a leap day', '2028-02-29T12:00:00Z', { months: 12 }, '2027-02-28T12:00Z'],
    ['10 years', '2026-10-12T07:45:00Z', { months: 120 }, '2016-10-12T07:45Z'],
  ];
  for (const [label, now, span, want] of cases) {
    test(label, () => assert.equal(iso(momentBefore(at(now), span)), want));
  }
});

// Bars are stamped at their start: a ten-minute bar closes ten minutes later.
const mins = [
  bar('2026-10-11T07:20:00Z', 100),
  bar('2026-10-11T07:30:00Z', 101, 103, 99),
  bar('2026-10-11T07:40:00Z', 102, 104, 101),
  bar('2026-10-11T07:50:00Z', 105, 106, 102),
];

describe('the price at a moment', () => {
  const hours = [bar('2026-09-12T05:00:00Z', 77000), bar('2026-09-12T06:00:00Z', 77100), bar('2026-09-12T07:00:00Z', 77200)];
  const cases = [
    ['price at 07:45 is the close of the bar that ended 07:40', mins, MINUTE_BAR_MS, '2026-10-11T07:45:00Z', 101],
    ['price at exactly 07:50 is the bar ending then', mins, MINUTE_BAR_MS, '2026-10-11T07:50:00Z', 102],
    ['before the first bar ends: not known', mins, MINUTE_BAR_MS, '2026-10-11T07:25:00Z', null],
    ['long after the last bar (a gap in the feed): not known', mins, MINUTE_BAR_MS, '2026-10-11T10:00:00Z', null],
    ['up to an hour after the last ten-minute bar is still its close', mins, MINUTE_BAR_MS, '2026-10-11T08:55:00Z', 105],
    ['no bars: not known', undefined, HOUR_BAR_MS, '2026-10-11T07:45:00Z', null],
    ['hourly: 07:45 a month ago is the bar that ended 07:00', hours, HOUR_BAR_MS, '2026-09-12T07:45:00Z', 77100],
  ];
  for (const [label, bars, barMs, moment, want] of cases) {
    test(label, () => assert.equal(priceAt(bars, barMs, at(moment)), want));
  }
});

// Daily closes are taken at 4 p.m. New York: 16 hours after the bar's midnight
// stamp, which is 20:00 UTC on these dates.
describe('between daily closes', () => {
  const days = [bar('2026-04-10T04:00:00Z', 70), bar('2026-04-11T04:00:00Z', 71), bar('2026-04-12T04:00:00Z', 73), bar('2026-04-13T04:00:00Z', 73)];
  const cases = [
    ['08:00 on the 12th is halfway between the closes of the 11th and 12th', days, '2026-04-12T08:00:00Z', 72],
    ['at the moment of a close, that close', days, '2026-04-11T20:00:00Z', 71],
    ['a quarter of the way on', days, '2026-04-12T02:00:00Z', 71.5],
    ['past the last close, the last close stands', days, '2026-04-14T06:00:00Z', 73],
    ['before the first close, the first stands', days, '2026-04-10T10:00:00Z', 70],
    ['nothing within a day and a half', days, '2026-04-20T08:00:00Z', null],
    ['no bars', undefined, '2026-04-12T08:00:00Z', null],
  ];
  for (const [label, bars, moment, want] of cases) {
    test(label, () => assert.equal(betweenDailyCloses(bars, at(moment)), want));
  }
});

describe('the range since a moment', () => {
  test('range of the bars that ended after 07:35', () => {
    assert.deepEqual(rangeSince(mins, MINUTE_BAR_MS, at('2026-10-11T07:35:00Z')), { high: 106, low: 99 });
  });
  test('range when nothing has ended since', () => {
    assert.equal(rangeSince(mins, MINUTE_BAR_MS, at('2026-10-11T09:00:00Z')), null);
  });
});
