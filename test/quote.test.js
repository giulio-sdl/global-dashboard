// Reading the quote feed (quote.js): which percentage is shown, what a quote
// cleared ahead of the open is replaced with, and a raw record as a whole.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { awaitingOpen, change, normalizeQuote, num, places, restoreLastSession } from '../quote.js';

const near = (got, want, within) => assert.ok(got != null && Math.abs(got - want) < within, `got ${got}, want ${want}`);

// The feed's own percentage, or the one derived from price and change.
describe('which percentage is shown', () => {
  const cases = [
    ['S&P Broad Digital: feed rounds to one decimal → derived', 4468.237, '-127.01', '-2.70%', -2.7639],
    ['S&P MegaCap: same', 7335.848, '-176.534', '-2.30%', -2.3499],
    ['S&P 500: feed and derived agree → feed', 7765.36, '-36.41', '-0.47%', -0.47],
    ['XRP quoted to the cent: price too coarse → feed', 1.48, '+0.01', '+0.5112%', 0.5112],
    ['EUR/USD to four decimals → feed', 1.1228, '+0.0019', '+0.1695%', 0.1695],
    ['10-year yield → feed', 4.123, '-0.021', '-0.5068%', -0.5068],
    ['unchanged', 94.63, 'UNCH', 'UNCH', 0],
    ['no percentage from the feed → derived', 100, '2', undefined, 2.0408],
    ['restored last session (change passed as a number string)', 6750, String(6750 - 6683.17), undefined, 0.99997],
  ];
  for (const [label, last, changeText, pctText, want] of cases) {
    test(label, () => near(change(last, changeText, pctText).changePct, want, 0.0005));
  }

  test('the change and the close it is measured from come with it', () => {
    const { change: delta, prevClose } = change(7765.36, '-36.41', '-0.47%');
    assert.equal(delta, -36.41);
    near(prevClose, 7801.77, 1e-9);
  });
});

describe('the feed\'s text as numbers', () => {
  test('thousands separators, signs and percent signs are dropped', () => {
    assert.deepEqual(['7,765.36', '+4.33', '-0.47%', '5.189%'].map(num), [7765.36, 4.33, -0.47, 5.189]);
  });
  test('"UNCH" is zero; nothing, or not a number, is no figure', () => {
    assert.deepEqual(['UNCH', 'unch', '', undefined, null, 'N/A'].map(num), [0, 0, null, null, null, null]);
  });
  test('decimal places, where a percent sign is not one', () => {
    assert.deepEqual(['5.352%', '-36.41', '4468.237', '95', '+0.0019'].map(places), [3, 2, 3, 0, 4]);
  });
});

// Shortly before an exchange opens the feed clears the day's figures: the
// change reads 0 and the high and low are empty. The last session's change is
// restored from the daily closes; a genuine quote is left alone.
describe('a quote cleared ahead of the open', () => {
  const bar = (close) => [0, close, close, close];
  const reset = (last, dp = 2) => ({ last, change: 0, prevClose: last, changePct: 0, dp, high: null, low: null });
  const lastSession = (6750 / 6683.17 - 1) * 100;
  const cases = [
    ['reset quote, last close on top of history', reset(6750), [bar(6700), bar(6683.17), bar(6750)], true, lastSession],
    ['reset quote, early bar for today repeats the close', reset(6750), [bar(6683.17), bar(6750), bar(6750)], true, lastSession],
    ['reset quote, history does not match the quote: left alone', reset(6750), [bar(6600), bar(6683.17)], true, 0],
    ['reset quote, no history: left alone', reset(6750), [], true, 0],
    ['reset quote, every bar the same: left alone', reset(6750), [bar(6750), bar(6750)], true, 0],
    ['live quote that is genuinely unchanged: left alone', { ...reset(6750), high: 6760, low: 6740 }, [bar(6683.17), bar(6750)], false, 0],
    ['live quote with a change: left alone', { last: 6750, change: 10, prevClose: 6740, changePct: 0.1484, dp: 2, high: 6760, low: 6735 }, [bar(6683.17), bar(6740)], false, 0.1484],
    ['four-decimal currency pair', reset(1.1712, 4), [bar(1.1655), bar(1.1712)], true, (1.1712 / 1.1655 - 1) * 100],
  ];
  for (const [label, q, bars, waiting, want] of cases) {
    test(label, () => {
      assert.equal(awaitingOpen(q), waiting);
      // As the server does: only a quote that is waiting for the open is touched.
      if (waiting) restoreLastSession(q, bars);
      near(q.changePct, want, 0.005);
    });
  }

  test('the restored change is measured from the close before the last session', () => {
    const q = reset(6750);
    restoreLastSession(q, [bar(6700), bar(6683.17), bar(6750)]);
    near(q.prevClose, 6683.17, 1e-6);
    near(q.change, 66.83, 1e-6);
    assert.equal(awaitingOpen(q), false);
  });
});

// Records as the feed sends them, trimmed to the fields that are read.
describe('a raw record', () => {
  const index = {
    symbol: '.SPX', code: 0, name: 'S&P 500 Index', last: '7,807.24', last_timedate: '10/12/26 EDT', last_time: '2026-10-12',
    high: '7,821.67', low: '7,796.94', change: '-4.30', change_pct: '-0.06%', currencyCode: 'USD', realTime: 'true',
    curmktstatus: 'REG_MKT', yrhiprice: '7,844.52', yrloprice: '6,316.91',
  };
  const share = {
    symbol: 'AAPL', code: 0, name: 'Apple Inc.', last: '340.97', last_timedate: '10/12/26 EDT', last_time: '2026-10-12', exchange: 'NASDAQ',
    open: '0.00', high: '0.00', low: '0.00', change: '+4.33', change_pct: '+1.29%', currencyCode: 'USD', volume: '23,265,274',
    realTime: 'true', curmktstatus: 'REG_MKT', pe: '39.23', mktcapView: '4.976T', dividendyield: '0.32%', tendayavgvol: '36.31M',
    sharesout: '14.59B', revenuettm: '466.823B',
    ExtendedMktQuote: { type: 'POST_MKT_PREV', last: '341.34', change: '+0.37', change_pct: '+0.11%', last_timedate: '7:59 PM EDT' },
  };

  test('an index: figures as numbers, the session and the date', () => {
    const q = normalizeQuote(index);
    assert.deepEqual(
      { last: q.last, change: q.change, changePct: q.changePct, dp: q.dp, high: q.high, low: q.low, yrHigh: q.yrHigh, yrLow: q.yrLow },
      { last: 7807.24, change: -4.3, changePct: -0.06, dp: 2, high: 7821.67, low: 7796.94, yrHigh: 7844.52, yrLow: 6316.91 },
    );
    near(q.prevClose, 7811.54, 1e-9);
    assert.deepEqual(
      { currency: q.currency, time: q.time, date: q.date, realTime: q.realTime, session: q.session, contract: q.contract, fullName: q.fullName, stats: q.stats, ext: q.ext },
      { currency: 'USD', time: '10/12/26 EDT', date: '2026-10-12', realTime: true, session: 'REG_MKT', contract: null, fullName: 'S&P 500 Index', stats: undefined, ext: null },
    );
  });

  test('a yield arrives with a percent sign, which is not a decimal place', () => {
    const q = normalizeQuote({ code: 0, last: '5.189%', high: '5.236%', low: '5.181%', change: '-0.055', change_pct: '-1.0488%', last_time: '2026-10-13T03:14:19.000-0400' });
    assert.deepEqual([q.last, q.dp, q.change, q.changePct, q.high, q.low, q.date], [5.189, 3, -0.055, -1.0488, 5.236, 5.181, '2026-10-13']);
  });

  test('a future names its contract month', () => {
    const q = normalizeQuote({ code: 0, name: 'WTI Crude (Nov\'26)', last: '92.58', change: '-1.16', change_pct: '-1.24%', realTime: 'false' });
    assert.deepEqual([q.contract, q.realTime], ['Nov \'26', false]);
  });

  test('prices are shown to at most four decimals, two from a thousand up', () => {
    const dp = (last) => normalizeQuote({ code: 0, last, change: '0.1' }).dp;
    assert.deepEqual(['4,468.237', '1.17125', '94.63', '95'].map(dp), [2, 4, 2, 0]);
  });

  test('a share out of hours: no range for the day yet, and its extended quote', () => {
    const q = normalizeQuote(share);
    assert.deepEqual([q.high, q.low], [null, null]);
    assert.deepEqual({ ...q.ext, prevClose: undefined }, { type: 'POST_MKT_PREV', last: 341.34, change: 0.37, prevClose: undefined, changePct: 0.11, time: '7:59 PM EDT' });
    near(q.ext.prevClose, 340.97, 1e-9);
  });

  test('a company\'s key figures are read only when asked for', () => {
    assert.equal(normalizeQuote(share).stats, undefined);
    const { stats } = normalizeQuote(share, true);
    assert.deepEqual(
      { exchange: stats.exchange, volume: stats.volume, averageVolume: stats.averageVolume, marketCap: stats.marketCap, sharesOutstanding: stats.sharesOutstanding, pe: stats.pe, dividendYield: stats.dividendYield, revenue: stats.revenue, beta: stats.beta },
      { exchange: 'NASDAQ', volume: 23265274, averageVolume: 36.31e6, marketCap: 4.976e12, sharesOutstanding: 14.59e9, pe: 39.23, dividendYield: 0.32, revenue: 466.823e9, beta: null },
    );
    assert.equal(normalizeQuote(index, true).stats, null); // an index has none
  });

  test('a symbol the feed does not know, or one without a price, is no quote', () => {
    assert.equal(normalizeQuote({ symbol: 'NOPE123', code: 1 }), null);
    assert.equal(normalizeQuote({ symbol: 'NOPE123', code: 1, last: '10.00' }), null);
    assert.equal(normalizeQuote({ symbol: '.SPX', code: 0, last: '' }), null);
  });
});
