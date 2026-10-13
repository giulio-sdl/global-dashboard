// Reading the quote feed: what it sends for an instrument, as the figures the
// dashboard shows. Everything arrives as text ("7,765.36", "-0.47%", "UNCH").

export function num(text) {
  if (text == null) return null;
  const t = String(text).replace(/[,%+]/g, '').trim();
  if (t === '') return null;
  if (/^unch$/i.test(t)) return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const positive = (text) => { const n = num(text); return n > 0 ? n : null; };

// Yields arrive as "5.352%"; the sign is not a decimal place.
export const places = (text) => (String(text).replace('%', '').split('.')[1] || '').length;

const decimals = (text, value) => Math.min(places(text), Math.abs(value) >= 1000 ? 2 : 4);

// The feed's own percentage is preferred: for low-priced instruments (XRP at
// 1.48) the rounded price and change are too coarse to derive it from. But
// for some indexes the feed rounds it to one decimal (-2.70% for a fall of
// 2.76%), so where it is further from the derived figure than the rounding
// of the change can explain, the derived figure is used.
export function change(last, changeText, pctText) {
  const delta = num(changeText) ?? 0;
  const prev = last - delta;
  const derived = prev ? (delta / prev) * 100 : null;
  const stated = num(pctText);
  const doubt = prev ? ((0.5 * 10 ** -places(changeText)) / Math.abs(prev)) * 100 : Infinity;
  const coarse = stated != null && derived != null && Math.abs(stated - derived) > doubt + 0.006;
  return { change: delta, prevClose: prev, changePct: stated == null || coarse ? derived : stated };
}

// "4.913T", "466.823B", "35.52M", "33,372,853" and "0.32%" as numbers.
function amount(text) {
  const match = /^(-?[\d,.]+)\s*([KMBT])?%?$/.exec(String(text ?? '').trim());
  const n = match ? Number(match[1].replace(/,/g, '')) : NaN;
  return Number.isFinite(n) ? n * ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[match[2]] ?? 1) : null;
}

// What the feed knows about a company besides its price: the figures of a
// share's summary page. Indexes, futures and currencies have none.
function companyStats(raw) {
  if (raw.mktcapView == null && raw.pe == null && raw.sharesout == null) return null;
  return {
    exchange: raw.exchange || null,
    open: amount(raw.open),
    volume: amount(raw.volume),
    averageVolume: amount(raw.tendayavgvol),
    marketCap: amount(raw.mktcapView),
    sharesOutstanding: amount(raw.sharesout),
    pe: amount(raw.pe),
    forwardPe: amount(raw.fpe),
    eps: amount(raw.eps),
    forwardEps: amount(raw.feps),
    priceToSales: amount(raw.psales),
    dividend: amount(raw.dividend),
    dividendYield: amount(raw.dividendyield),
    beta: amount(raw.beta),
    revenue: amount(raw.revenuettm),
    ebitda: amount(raw.TTMEBITD),
    grossMargin: amount(raw.GROSMGNTTM),
    netMargin: amount(raw.NETPROFTTM),
    returnOnEquity: amount(raw.ROETTM),
    debtToEquity: amount(raw.DEBTEQTYQ),
  };
}

// `withStats` adds a company's key figures; the dashboard's own rows go without.
export function normalizeQuote(raw, withStats = false) {
  const last = num(raw.last);
  if (raw.code !== 0 || last == null) return null;
  const ext = raw.ExtendedMktQuote;
  const extLast = ext ? num(ext.last) : null;
  return {
    last,
    ...change(last, raw.change, raw.change_pct),
    dp: decimals(raw.last, last),
    high: positive(raw.high),
    low: positive(raw.low),
    yrHigh: positive(raw.yrhiprice),
    yrLow: positive(raw.yrloprice),
    currency: raw.currencyCode || null,
    time: raw.last_timedate || null,
    date: (raw.last_time || '').slice(0, 10) || null,
    realTime: raw.realTime === 'true',
    session: raw.curmktstatus || null,
    contract: /\(([A-Z][a-z]{2})'(\d{2})\)/.exec(raw.name || '')?.slice(1, 3).join(" '") || null,
    fullName: raw.name || null,
    stats: withStats ? companyStats(raw) : undefined,
    ext: extLast == null ? null : {
      type: ext.type || null,
      last: extLast,
      ...change(extLast, ext.change, ext.change_pct),
      time: ext.last_timedate || null,
    },
  };
}

// Shortly before an exchange opens, the feed clears the day's figures: the
// change reads zero and the last close is reported as the previous close.
export const awaitingOpen = (q) => q.change === 0 && q.high == null && q.low == null;

// Until such an instrument trades again, show the change of its last session
// instead of a meaningless zero, taken from its daily closes.
export function restoreLastSession(q, bars) {
  if (!bars?.length) return;
  const same = (close) => Math.abs(close - q.last) <= 0.5 * 10 ** -q.dp + 1e-9;
  // The last session is the newest daily bar; an early bar for today may sit on top of it.
  let i = bars.length - 1;
  if (!same(bars[i][1])) return;
  while (i > 0 && same(bars[i][1])) i--;
  if (same(bars[i][1])) return;
  Object.assign(q, change(q.last, String(q.last - bars[i][1])));
}
