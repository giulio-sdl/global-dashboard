// A share's valuation measures, the nine Yahoo Finance lays out: market cap,
// enterprise value, trailing and forward P/E, the PEG ratio, price over sales
// and over book value, and enterprise value over revenue and over EBITDA.
// Today's, and at the end of each of the company's latest periods.
//
// Today's market cap is the quote feed's. Earlier ones are carried back from
// it by the price at each period's end and by the number of shares then, as
// the company filed it with the SEC, so a buyback or an issue of shares shows.
// Only the changes in the share count are used, which keeps a company with
// several classes of shares right. Where no count is filed, the price alone
// carries it back.
//
// Everything else comes from the filings (see valuationBasis in edgar.js):
// revenue and EBITDA over the twelve months to each date, and the balance
// sheet on it. Enterprise value is the market cap with debt added and cash
// and short-term investments taken off. The forward P/E is the feed's alone,
// and so is the PEG ratio: the feed's P/E over the growth in earnings per
// share that its forward estimate implies for the next year. (Yahoo's takes
// analysts' growth over five years, which the feed does not carry.)
//
// Without filings in the currency the share is priced in, only the feed's own
// figures for today are given.

const DAY_MS = 24 * 3600_000;
// A company whose latest figures are older than this (one that has stopped
// filing) is not valued on them; the P/E line stops at the same age.
const STALE_MS = 550 * DAY_MS;
// The price at a period's end is the last close in the week up to it.
const CLOSE_WITHIN_MS = 8 * DAY_MS;

export const MEASURES = ['marketCap', 'enterpriseValue', 'pe', 'forwardPe', 'peg', 'priceToSales', 'priceToBook', 'evToRevenue', 'evToEbitda'];

// A ratio over a loss, negative equity or nothing at all means nothing.
const ratio = (value, over) => (value != null && over > 0 ? value / over : null);
const positive = (value) => (value > 0 ? value : null);

// `quote` is the share's, with the feed's key figures as `stats`. `basis` is
// the filings' figures at the period ends, newest first, each share count with
// `sharesFiled`, the day it was filed; `trailing` is the twelve months'
// earnings per share as trailingEarnings gives them. Both must
// be in the price's currency, and `trailing` in the price's shares. `closes`
// are daily [time, close] bars in today's shares, oldest first, and
// `splitFactor(date)` is how many of today's shares one share was on a date.
export function valuationMeasures({ quote, basis = null, trailing = null, closes = null, splitFactor = null, now = Date.now() }) {
  const stats = quote.stats ?? {};
  const growth = stats.eps > 0 && stats.forwardEps != null ? (stats.forwardEps / stats.eps - 1) * 100 : null;
  const feed = { marketCap: stats.marketCap ?? null, forwardPe: positive(stats.forwardPe), peg: ratio(positive(stats.pe), growth) };

  const latest = basis?.periods[0];
  if (!latest || now - Date.parse(latest.end) > STALE_MS || feed.marketCap == null) {
    const ev = stats.enterpriseValue ?? null;
    return table(quote, 'feed', null, [null], [{
      ...feed,
      enterpriseValue: ev,
      pe: positive(stats.pe),
      priceToSales: positive(stats.priceToSales),
      evToRevenue: ratio(ev, stats.revenue),
      evToEbitda: ratio(ev, stats.ebitda),
    }]);
  }

  // The figures at a date, from the price and market cap then, the period's
  // filed figures and the twelve months' earnings per share to it.
  const measures = (price, marketCap, period, eps) => {
    const ev = marketCap != null && period.debt != null && period.cash != null ? marketCap + period.debt - period.cash : null;
    return {
      marketCap,
      enterpriseValue: ev,
      pe: price != null && eps != null ? ratio(price, eps) : null,
      priceToSales: ratio(marketCap, period.revenue),
      priceToBook: ratio(marketCap, period.equity),
      evToRevenue: ratio(ev, period.revenue),
      evToEbitda: ratio(ev, period.ebitda),
    };
  };
  const closeOn = (end) => {
    const until = Date.parse(end) + DAY_MS;
    let close = null;
    for (const [time, price] of closes ?? []) {
      if (time >= until) break;
      close = time >= until - CLOSE_WITHIN_MS ? price : null;
    }
    return close;
  };
  // The shares on a period's end over those on the latest one, both counted
  // in today's shares across splits. A count is in the shares of the day it
  // was filed: the reports after a split restate earlier counts in the new
  // shares, as they do earnings per share (see trailingEarnings in edgar.js).
  const inToday = (period) => period.shares * splitFactor(period.sharesFiled ?? period.end);
  const sharesThen = (period) => (period.shares != null && latest.shares && splitFactor ? inToday(period) / inToday(latest) : 1);

  const today = {
    ...measures(quote.last, feed.marketCap, latest, trailing?.at(-1)?.eps ?? null),
    forwardPe: feed.forwardPe,
    peg: feed.peg,
  };
  // Without earnings per share filed in this share's terms, the feed's P/E.
  if (!trailing) today.pe = positive(stats.pe);
  const then = basis.periods.map((period) => {
    const price = closeOn(period.end);
    const marketCap = price == null ? null : feed.marketCap * (price / quote.last) * sharesThen(period);
    return measures(price, marketCap, period, trailing?.find((entry) => entry.end === period.end)?.eps ?? null);
  });
  // What today's enterprise value is missing where it is not known: the debt, the cash or both.
  const lacks = ['debt', 'cash'].filter((part) => latest[part] == null);
  return table(quote, 'filings', basis.kind, [null, ...basis.periods.map((period) => period.end)], [today, ...then], lacks);
}

// Laid out by measure, a row of figures each: today's first (its date null),
// then each period's, newest first. `kind` says whether those are quarters or
// years, and `lacks` what the filings do not give for today's enterprise value.
function table(quote, source, kind, dates, columns, lacks = []) {
  return {
    source,
    kind,
    currency: quote.currency,
    dates,
    rows: Object.fromEntries(MEASURES.map((name) => [name, columns.map((column) => column[name] ?? null)])),
    lacks,
  };
}
