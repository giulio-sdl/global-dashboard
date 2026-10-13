// How far an index has moved since its exchange closed, read from a future or
// ETF that keeps trading (sinceclose.js).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MARKETS } from '../instruments.js';
import { sinceClose, zonedInstant } from '../sinceclose.js';

const at = (iso) => Date.parse(iso);
const utc = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const near = (got, want) => assert.ok(Math.abs(got - want) < 1e-9, `got ${got}, want ${want}`);

describe('a time on an exchange\'s clock', () => {
  const cases = [
    ['Paris in summer is two hours ahead', '2026-10-08', '17:30', 'Europe/Paris', '2026-10-08 15:30'],
    ['Paris in winter is one', '2026-01-15', '17:30', 'Europe/Paris', '2026-01-15 16:30'],
    ['the day the clocks go forward', '2026-03-29', '17:30', 'Europe/Paris', '2026-03-29 15:30'],
    ['the day they go back', '2026-10-25', '17:30', 'Europe/Paris', '2026-10-25 16:30'],
    ['New York, the week Europe has changed and America has not', '2026-10-30', '16:00', 'America/New_York', '2026-10-30 20:00'],
    ['New York in winter', '2026-11-02', '16:00', 'America/New_York', '2026-11-02 21:00'],
    ['Tokyo, which has no summer time', '2026-07-01', '15:30', 'Asia/Tokyo', '2026-07-01 06:30'],
    ['India, half an hour off the hour', '2026-10-08', '15:30', 'Asia/Kolkata', '2026-10-08 10:00'],
    ['an opening bell in Asia falls on the day before in UTC', '2026-10-08', '09:00', 'Asia/Seoul', '2026-10-08 00:00'],
  ];
  for (const [label, date, time, tz, want] of cases) {
    test(label, () => assert.equal(utc(zonedInstant(date, time, tz)), want));
  }
});

// The DAX on Thursday 8 October 2026: Xetra closes at 17:30 in Frankfurt, which
// is 15:30 UTC. Its proxy is an ETF listed in New York, in its regular session
// at that hour. Bars are [start, close] and ten minutes long.
const dax = { date: '2026-10-08', last: 24000 };
const etf = (last, more = {}) => ({ last, time: '2:00 PM EDT', session: 'REG_MKT', ext: null, ...more });
const tick = (time, close, date = '2026-10-08') => [at(`${date}T${time}:00Z`), close];
const evening = at('2026-10-08T18:00:00Z');

describe('the proxy\'s price at the bell', () => {
  test('its bar ending at the bell, when it was trading through the close', () => {
    const bars = [tick('15:00', 39.8), tick('15:10', 39.9), tick('15:20', 40.0), tick('15:30', 40.1), tick('15:40', 40.2)];
    const after = sinceClose(dax, MARKETS.eu, etf(40.4), bars, evening);
    near(after.pct, 1);
    near(after.level, 24240); // the index, moved by as much
    assert.equal(after.time, '2:00 PM EDT');
  });

  test('a bar that ends within five minutes of the bell is the bar at the bell', () => {
    const upTo = (lastStart) => sinceClose(dax, MARKETS.eu, etf(40.4), [tick('15:15', 39.9), tick(lastStart, 40.0), tick('15:50', 40.2)], evening).pct;
    near(upTo('15:25'), 1); // ends 15:35: measured from its 40.0
    near(upTo('15:26'), (40.4 / 39.9 - 1) * 100); // ends 15:36, after the bell: measured from the bar before
  });

  test('its last trade before the bell, if within 40 minutes', () => {
    const after = sinceClose(dax, MARKETS.eu, etf(40.4), [tick('14:50', 40.0), tick('16:30', 40.3)], evening);
    near(after.pct, 1);
  });

  test('older than that: its first trade after the bell instead', () => {
    const after = sinceClose(dax, MARKETS.eu, etf(40.4), [tick('14:40', 39.0), tick('16:30', 40.0)], evening);
    near(after.pct, 1);
  });

  // In winter a US-listed ETF starts pre-market trading at 09:00 UTC, two and
  // a half hours after Seoul has closed at 06:30.
  describe('an ETF asleep at an Asian close', () => {
    const kospi = { date: '2026-01-15', last: 5000 };
    const lastNight = tick('00:50', 98.0, '2026-01-15'); // the end of New York's after-hours
    const noon = at('2026-01-15T12:00:00Z');
    const since = (firstStart) => sinceClose(kospi, MARKETS.kr, etf(101, { session: 'PRE_MKT' }), [lastNight, tick(firstStart, 100.0, '2026-01-15'), tick('11:00', 100.5, '2026-01-15')], noon);

    test('its first pre-market trade stands for the bell', () => {
      const after = since('09:00');
      near(after.pct, 1);
      near(after.level, 5050);
    });
    test('up to 160 minutes after the close', () => near(since('09:10').pct, 1));
    test('later than that, there is no figure', () => assert.equal(since('09:20'), null));
  });
});

describe('when there is no figure', () => {
  const bars = [tick('15:10', 39.9), tick('15:20', 40.0), tick('15:30', 40.1)];

  test('while the index is in its session', () => {
    assert.equal(sinceClose(dax, MARKETS.eu, etf(40.4), bars, at('2026-10-08T15:29:59Z')), null);
    assert.notEqual(sinceClose(dax, MARKETS.eu, etf(40.4), bars, at('2026-10-08T15:30:00Z')), null);
  });

  test('a lunch break is not the close: Tokyo shuts at 15:30, its second session\'s end', () => {
    const nikkei = { date: '2026-10-08', last: 50000 };
    const futures = [tick('02:20', 49900), tick('06:20', 50100), tick('06:30', 50150)];
    assert.equal(sinceClose(nikkei, MARKETS.jp, etf(50601), futures, at('2026-10-08T03:00:00Z')), null); // 12:00 in Tokyo
    near(sinceClose(nikkei, MARKETS.jp, etf(50601), futures, at('2026-10-08T08:00:00Z')).pct, 1); // from the 06:20 bar, ending at the bell
  });

  test('the proxy has not traded since the close', () => {
    assert.equal(sinceClose(dax, MARKETS.eu, etf(40.4), [tick('15:10', 39.9), tick('15:20', 40.0)], evening), null);
  });

  test('the proxy traded neither near the close nor soon after', () => {
    assert.equal(sinceClose(dax, MARKETS.eu, etf(40.4), [tick('14:40', 39.0), tick('18:20', 40.0)], at('2026-10-08T19:00:00Z')), null);
  });

  test('something is missing: the quote\'s date, the market, the proxy or its bars', () => {
    assert.equal(sinceClose({ last: 24000 }, MARKETS.eu, etf(40.4), bars, evening), null);
    assert.equal(sinceClose(undefined, MARKETS.eu, etf(40.4), bars, evening), null);
    assert.equal(sinceClose(dax, undefined, etf(40.4), bars, evening), null);
    assert.equal(sinceClose(dax, MARKETS.eu, undefined, bars, evening), null);
    assert.equal(sinceClose(dax, MARKETS.eu, etf(40.4), [], evening), null);
    assert.equal(sinceClose(dax, MARKETS.eu, etf(40.4), undefined, evening), null);
  });
});

describe('the proxy\'s price now', () => {
  const bars = [tick('15:20', 40.0), tick('15:30', 40.1)];
  const night = at('2026-10-08T22:00:00Z');

  test('after hours: its after-hours trade', () => {
    const proxy = etf(40.2, { time: '4:00 PM EDT', session: 'POST_MKT', ext: { type: 'POST_MKT', last: 40.4, time: '5:58 PM EDT' } });
    const after = sinceClose(dax, MARKETS.eu, proxy, bars, night);
    near(after.pct, 1);
    assert.equal(after.time, '5:58 PM EDT');
  });

  test('before the open: its pre-market trade', () => {
    const proxy = etf(40.2, { time: '4:00 PM EDT', session: 'PRE_MKT', ext: { type: 'PRE_MKT', last: 40.4, time: '4:15 AM EDT' } });
    const after = sinceClose(dax, MARKETS.eu, proxy, bars, at('2026-10-09T06:00:00Z'));
    near(after.pct, 1);
    assert.equal(after.time, '4:15 AM EDT');
  });

  test('in its regular session: its last trade, not the morning\'s pre-market one', () => {
    const proxy = etf(40.4, { ext: { type: 'PRE_MKT', last: 39.0, time: '9:29 AM EDT' } });
    const after = sinceClose(dax, MARKETS.eu, proxy, bars, evening);
    near(after.pct, 1);
    assert.equal(after.time, '2:00 PM EDT');
  });
});
