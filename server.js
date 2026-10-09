// Zero-dependency server: serves the dashboard and proxies market data so the
// browser never talks to the data provider directly.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHoldings } from './holdings.js';
import { MARKETS, OVERVIEW, SECTIONS } from './instruments.js';
import { sinceClose } from './sinceclose.js';

const PORT = Number(process.env.PORT) || 5177;
// Only this computer can reach the server unless HOST says otherwise; a
// hosting service sets HOST=0.0.0.0 to accept visitors.
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const QUOTE_URL = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol';
const BARS_URL = 'https://ts-api.cnbc.com/harmony/app/bars';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const QUOTE_TTL_MS = 10_000;
const QUOTE_BATCH = 50;
const QUOTE_TIMEOUT_MS = 6_000;
const QUOTE_CONCURRENCY = 4;
const CONSTITUENT_TTL_MS = 60_000;
const HOLDINGS_TTL_MS = 12 * 3600_000;
const REFERENCE_TTL_MS = 30 * 60_000;
const REFERENCE_CONCURRENCY = 16; // several hundred small requests per index and period
const SPARK_TTL_MS = 180_000;
const SPARK_CONCURRENCY = 8;
const SESSION_GAP_MS = 3 * 3600_000; // a longer pause than this starts a new session
const SPARK_MAX_SPAN_MS = 24 * 3600_000;
const SPARK_MIN_BARS = 6;
const SPARK_MAX_POINTS = 300;
const DAY_MS = 24 * 3600_000;

const SYMBOLS = [...new Set(SECTIONS.flatMap((s) => s.cards.flatMap((c) => c.groups.flatMap((g) => g.items.map((i) => i.symbol)))).filter(Boolean))];

// Where each row's chart history comes from: its own symbol, unless it names another.
const CHART_SYMBOL = new Map(SECTIONS.flatMap((s) => s.cards.flatMap((c) => c.groups.flatMap((g) =>
  g.items.filter((item) => item.symbol).map((item) => [item.symbol, item.chart ?? item.symbol])))));

// Indexes whose move since the close is read from a future or ETF that keeps trading.
const PROXIED = SECTIONS.flatMap((s) => s.cards.flatMap((c) => c.groups.flatMap((g) =>
  g.items.filter((item) => item.proxy).map((item) => ({ symbol: item.symbol, market: item.market ?? g.markets?.[0], proxy: item.proxy.symbol })))));
const PROXY_SYMBOLS = [...new Set(PROXIED.map((p) => p.proxy))];
const PROXY_DAYS_BACK = 7; // far enough to reach the last close across a long weekend

async function fetchJson(url, timeoutMs = 12_000) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} responded ${res.status}`);
  return res.json();
}

// Marks a result as missing some of its symbols, without the mark showing up
// among its entries.
const INCOMPLETE = Symbol('incomplete');
const markIncomplete = (results) => Object.defineProperty(results, INCOMPLETE, { value: true });
const RETRY_INCOMPLETE_MS = 20_000;

// Serves a cached value while fresh, shares one in-flight refresh between
// callers, and falls back to the last good value when the provider fails.
// The provider is sometimes slow (most of all around the US open), so once
// there is a value a caller waits only `patienceMs` for the refresh: after
// that it gets the previous value, and the refresh finishes in the background.
//
// A load can come back incomplete (see forEachSymbol): some symbols failed,
// typically because the network was not up yet when the computer woke. Such a
// result is topped up with what was known before and counts as fresh for only
// `RETRY_INCOMPLETE_MS`, so the gaps are filled on the next request instead of
// lasting the whole cache time.
function cached(ttlMs, load, patienceMs = 2_500) {
  let value = null;
  let at = 0;
  let pending = null;
  const keep = (loaded) => {
    const incomplete = Boolean(loaded?.[INCOMPLETE]);
    value = incomplete && value ? markIncomplete({ ...value, ...loaded }) : loaded;
    at = incomplete ? Date.now() - ttlMs + RETRY_INCOMPLETE_MS : Date.now();
  };
  return async () => {
    if (value && Date.now() - at < ttlMs) return { value, at, error: null };
    pending ??= load()
      .then((v) => { keep(v); return null; })
      .catch((err) => err.message || String(err))
      .finally(() => { pending = null; });
    const slow = new Promise((resolve) => setTimeout(resolve, patienceMs, null));
    const error = await (value ? Promise.race([pending, slow]) : pending);
    if (!value) throw new Error(error || 'no data');
    return { value, at, error };
  };
}

// ---- quotes ---------------------------------------------------------------

function num(text) {
  if (text == null) return null;
  const t = String(text).replace(/[,%+]/g, '').trim();
  if (t === '') return null;
  if (/^unch$/i.test(t)) return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const positive = (text) => { const n = num(text); return n > 0 ? n : null; };

// Yields arrive as "5.352%"; the sign is not a decimal place.
const places = (text) => (String(text).replace('%', '').split('.')[1] || '').length;

const decimals = (text, value) => Math.min(places(text), Math.abs(value) >= 1000 ? 2 : 4);

// The feed's own percentage is preferred: for low-priced instruments (XRP at
// 1.48) the rounded price and change are too coarse to derive it from. But
// for some indexes the feed rounds it to one decimal (-2.70% for a fall of
// 2.76%), so where it is further from the derived figure than the rounding
// of the change can explain, the derived figure is used.
function change(last, changeText, pctText) {
  const delta = num(changeText) ?? 0;
  const prev = last - delta;
  const derived = prev ? (delta / prev) * 100 : null;
  const stated = num(pctText);
  const doubt = prev ? ((0.5 * 10 ** -places(changeText)) / Math.abs(prev)) * 100 : Infinity;
  const coarse = stated != null && derived != null && Math.abs(stated - derived) > doubt + 0.006;
  return { change: delta, prevClose: prev, changePct: stated == null || coarse ? derived : stated };
}

function normalizeQuote(raw) {
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
    ext: extLast == null ? null : {
      type: ext.type || null,
      last: extLast,
      ...change(extLast, ext.change, ext.change_pct),
      time: ext.last_timedate || null,
    },
  };
}

// Quotes for any list of symbols, fetched in batches, a few batches at a time.
// Symbols the feed does not know are simply absent from the result.
async function fetchQuotes(symbols) {
  const quotes = {};
  const batches = [];
  for (let i = 0; i < symbols.length; i += QUOTE_BATCH) batches.push(symbols.slice(i, i + QUOTE_BATCH));
  const total = batches.length;
  const failed = [];
  let lastError = null;
  const load = async (batch, onError) => {
    const params = new URLSearchParams({
      symbols: batch.join('|'),
      requestMethod: 'itv', noform: '1', partnerId: '2', fund: '1', exthrs: '1', output: 'json', events: '1',
    });
    try {
      const data = await fetchJson(`${QUOTE_URL}?${params}`, QUOTE_TIMEOUT_MS);
      for (const raw of [].concat(data?.FormattedQuoteResult?.FormattedQuote ?? [])) {
        const q = normalizeQuote(raw);
        if (q) quotes[raw.symbol] = q;
      }
    } catch (err) {
      lastError = err;
      onError(batch);
    }
  };
  await Promise.all(Array.from({ length: QUOTE_CONCURRENCY }, async () => {
    for (let batch; (batch = batches.shift()); ) await load(batch, (b) => failed.push(b));
  }));
  // One more try for batches that failed, so a single dropped request does
  // not leave part of the dashboard without fresh prices.
  let stillFailing = 0;
  for (const batch of failed) await load(batch, () => stillFailing++);
  if (total && stillFailing === total) throw lastError;
  return quotes;
}

// Shortly before an exchange opens, the feed clears the day's figures: the
// change reads zero and the last close is reported as the previous close.
const awaitingOpen = (q) => q.change === 0 && q.high == null && q.low == null;

// Until such an instrument trades again, show the change of its last session
// instead of a meaningless zero, taken from its daily closes.
function restoreLastSession(q, bars) {
  if (!bars?.length) return;
  const same = (close) => Math.abs(close - q.last) <= 0.5 * 10 ** -q.dp + 1e-9;
  // The last session is the newest daily bar; an early bar for today may sit on top of it.
  let i = bars.length - 1;
  if (!same(bars[i][1])) return;
  while (i > 0 && same(bars[i][1])) i--;
  if (same(bars[i][1])) return;
  Object.assign(q, change(q.last, String(q.last - bars[i][1])));
}

// The 52-week range. The feed's own figures are missing for many instruments
// and rounded or stale for currencies, so the range is taken from a year of
// daily highs and lows, widened by today's trading. Without history, the
// feed's figures stand.
function yearRange(q, bars) {
  const year = (bars ?? []).filter((bar) => bar[0] >= Date.now() - 365 * DAY_MS);
  if (year.length < 100) return {};
  const today = [q.last, q.high, q.low].filter((value) => value != null);
  return {
    yrHigh: Math.max(...year.map((bar) => bar[2]), ...today),
    yrLow: Math.min(...year.map((bar) => bar[3]), ...today),
  };
}

let lastQuotes = {};

// Waits briefly for a slow source, then carries on without it.
const soon = (get, ms = 1_000) => Promise.race([
  get().then((result) => result.value, () => null),
  new Promise((resolve) => setTimeout(resolve, ms, null)),
]);

async function loadQuotes() {
  const fresh = await fetchQuotes([...new Set([...SYMBOLS, ...PROXY_SYMBOLS])]);
  if (!Object.keys(fresh).length) throw new Error('quote feed returned no data');
  // If a batch was lost even after the retry, its symbols keep their last quote.
  const quotes = { ...lastQuotes, ...fresh };
  lastQuotes = quotes;
  // Just after start-up the daily history is still loading. Do not hold the
  // first prices back for it; the next refresh applies what depends on it.
  const history = await soon(HISTORY.day.get);
  if (history) {
    for (const symbol of SYMBOLS) {
      const q = quotes[symbol];
      if (!q) continue;
      if (awaitingOpen(q)) restoreLastSession(q, history[symbol]);
      Object.assign(q, yearRange(q, history[symbol]));
    }
  }
  // For an index whose exchange has closed, the move since then.
  const proxyBars = await soon(getProxyBars);
  for (const { symbol, market, proxy } of proxyBars ? PROXIED : []) {
    if (quotes[symbol]) quotes[symbol].after = sinceClose(quotes[symbol], MARKETS[market], quotes[proxy], proxyBars[proxy]);
  }
  return quotes;
}

// ---- index constituents -----------------------------------------------------

const INDEX_ITEMS = new Map(
  SECTIONS.flatMap((s) => s.cards.flatMap((c) => c.groups.flatMap((g) => g.items)))
    .filter((item) => item.holdings)
    .map((item) => [item.symbol, item]),
);
const lastLiveDetail = new Map();

// One cached loader per key, made on first use.
function keyed(ttlMs, load) {
  const loaders = new Map();
  return (key, ...args) => {
    if (!loaders.has(key)) loaders.set(key, cached(ttlMs, () => load(...args)));
    return loaders.get(key)();
  };
}

const holdingsOf = keyed(HOLDINGS_TTL_MS, (item) => loadHoldings(item.holdings.fund));

// An index's holdings, each with the symbol it is quoted under and its live quote.
const pricedOf = keyed(CONSTITUENT_TTL_MS, async (item) => {
  const { value: holdings } = await holdingsOf(item.symbol, item);
  const quotes = await fetchQuotes(holdings.items.flatMap((h) => h.symbols));
  // The feed occasionally drops a symbol from a batch; ask once more for the gaps.
  const missed = holdings.items.filter((h) => !h.symbols.some((s) => quotes[s])).flatMap((h) => h.symbols);
  if (missed.length) Object.assign(quotes, await fetchQuotes(missed).catch(() => ({})));
  return {
    asOf: holdings.asOf,
    rows: holdings.items.map((holding) => {
      const symbol = holding.symbols.find((s) => quotes[s]);
      return { holding, symbol, quote: quotes[symbol] ?? null };
    }),
  };
});

// Each constituent's close at the start of a period: its last close on or
// before the day the index's own change is measured from, so that the two
// cover the same stretch. One small request per constituent.
const referencesOf = keyed(REFERENCE_TTL_MS, async (item, range) => {
  const spec = RANGES[range];
  const [{ value: priced }, daily] = await Promise.all([pricedOf(item.symbol, item), HISTORY.day.get().catch(() => null)]);
  const session = sessionOf(lastQuotes[item.symbol], daily?.value[item.symbol]);
  const start = spec.sessions
    // Without the index's history, five sessions are taken to be a week.
    ? session.closed.at(-spec.sessions)?.[0] ?? Date.parse(session.date) - 7 * DAY_MS
    : Date.parse(monthsBefore(session.date, spec.months));
  const target = barDate([start]);
  return forEachSymbol(async (symbol) => {
    const bars = await loadBarsBetween(symbol, '1D', start - 12 * DAY_MS, start + 2 * DAY_MS);
    return bars.filter((bar) => barDate(bar) <= target).at(-1)?.[1];
  }, priced.rows.filter((row) => row.quote).map((row) => row.symbol), REFERENCE_CONCURRENCY);
});

// How many times over a share price can believably have multiplied in each
// period. A bigger jump, or a fall of more than nine tenths, is taken to be a
// break in the price history rather than a real move: a share that changed
// the currency or unit it trades in (pence to dollars, say). One such name
// would otherwise swamp the whole calculation, so it is left without a change.
const PLAUSIBLE_GROWTH = { '1w': 5, '1m': 5, '3m': 10, '6m': 10, '1y': 20, '5y': 60, '10y': 400 };

function plausibleChange(last, reference, period) {
  const growth = reference ? last / reference : null;
  return growth == null || growth < 0.1 || growth > PLAUSIBLE_GROWTH[period] ? null : (growth - 1) * 100;
}

// The constituents of an index with their weights and their change over a
// period: one day from the quotes themselves, anything longer against the
// reference closes above.
async function getIndexDetail(symbol, range) {
  const item = INDEX_ITEMS.get(symbol);
  if (!item) throw new Error('no constituent data for this index');
  const period = RANGES[range] ? range : '1d';
  const priced = await pricedOf(symbol, item);
  const references = period === '1d' ? null : (await referencesOf(`${symbol}|${period}`, item, period)).value;
  const detail = {
    etf: item.holdings.etf,
    asOf: priced.value.asOf,
    period,
    constituents: priced.value.rows.map(({ holding, symbol: quoted, quote }) => {
      const reference = references?.[quoted];
      return {
        ticker: holding.ticker,
        name: quote?.fullName || holding.name,
        sector: holding.sector,
        weight: holding.weight,
        last: quote?.last ?? null,
        changePct: !quote ? null : !references ? quote.changePct : plausibleChange(quote.last, reference, period),
        dp: quote?.dp ?? 2,
        currency: quote?.currency ?? holding.currency,
      };
    }),
  };
  const result = (value) => ({ value, at: priced.at, error: priced.error });
  if (period !== '1d') return result(detail);

  // Before the open the feed has cleared every constituent's change. Serve
  // the last session seen instead, or say that there is nothing to show yet.
  const quoted = priced.value.rows.filter((row) => row.quote);
  if (quoted.length && quoted.filter((row) => awaitingOpen(row.quote)).length / quoted.length > 0.8) {
    const previous = lastLiveDetail.get(symbol);
    return result(previous ? { ...previous, session: 'previous' } : { ...detail, session: 'awaiting' });
  }
  lastLiveDetail.set(symbol, detail);
  return result(detail);
}

// ---- intraday sparklines --------------------------------------------------

const stamp = (d) => d.toISOString().replace(/\D/g, '').slice(0, 14);

function loadBars(symbol, interval, daysBack) {
  const now = Date.now();
  // The feed counts bars from the requested start, so the start is put on the
  // hour: 10-minute and hourly bars then always fall on the same clock times,
  // whenever they are fetched.
  return loadBarsBetween(symbol, interval, Math.floor((now - daysBack * DAY_MS) / 3600_000) * 3600_000, now + DAY_MS);
}

async function loadBarsBetween(symbol, interval, start, end) {
  const url = `${BARS_URL}/${encodeURIComponent(symbol)}/${interval}/${stamp(new Date(start))}/${stamp(new Date(end))}/adjusted/GMT.json`;
  const data = await fetchJson(url);
  // Each bar is [time, close, high, low]. The feed marks a missing high or low
  // with a negative number; the close stands in for it.
  return (data?.barData?.priceBars ?? [])
    .map((b) => {
      const close = Number(b.close);
      const high = Number(b.high);
      const low = Number(b.low);
      return [Number(b.tradeTimeinMills), close, high > 0 ? high : close, low > 0 ? low : close];
    })
    .filter(([t, c]) => Number.isFinite(t) && Number.isFinite(c) && c > 0);
}

// The most recent trading session: walk back from the last bar until a long
// pause (overnight, weekend) or until a full day is covered (24h futures).
function lastSession(bars) {
  // Cash indexes keep repeating the closing value after the bell; drop the repeats.
  let stop = bars.length;
  while (stop > 1 && bars[stop - 1][1] === bars[stop - 2][1]) stop--;
  if (stop < 2) return null;

  let start = stop - 1;
  const end = bars[start][0];
  while (start > 0) {
    // A session with only a few prints so far (thin pre-market) is too short
    // to draw on its own, so keep reaching back into the previous one.
    const thin = stop - start < SPARK_MIN_BARS;
    const newSession = bars[start][0] - bars[start - 1][0] >= SESSION_GAP_MS;
    const tooLong = end - bars[start - 1][0] > SPARK_MAX_SPAN_MS;
    if (!thin && (newSession || tooLong)) break;
    start--;
  }
  const session = bars.slice(start, stop);
  return { t: session.map((b) => b[0]), c: session.map((b) => b[1]) };
}

async function loadSpark(symbol) {
  // Two days covers a normal weekday; widen for weekends and holidays.
  let bars = await loadBars(CHART_SYMBOL.get(symbol), '10M', 2);
  if (bars.length < 2) bars = await loadBars(CHART_SYMBOL.get(symbol), '10M', 7);
  return lastSession(bars);
}

// Runs `load` for every symbol, a few at a time, and keeps what succeeds.
// Symbols that fail get one more try; if any still fail the result is marked
// incomplete, so it is not mistaken for the full picture.
async function forEachSymbol(load, symbols = SYMBOLS, concurrency = SPARK_CONCURRENCY) {
  const results = {};
  const run = async (list) => {
    const queue = [...list];
    const failed = [];
    await Promise.all(Array.from({ length: concurrency }, async () => {
      for (let symbol; (symbol = queue.shift()); ) {
        try {
          const result = await load(symbol);
          if (result) results[symbol] = result;
        } catch {
          failed.push(symbol);
        }
      }
    }));
    return failed;
  };
  const failed = await run(await run(symbols));
  if (symbols.length && failed.length === symbols.length) throw new Error('chart feed unavailable');
  return failed.length ? markIncomplete(results) : results;
}

const getProxyBars = cached(SPARK_TTL_MS, () => forEachSymbol((symbol) => loadBars(symbol, '10M', PROXY_DAYS_BACK), PROXY_SYMBOLS));

// ---- longer periods ---------------------------------------------------------

// Three bar sizes cover every period: hourly for the five-day chart, daily up
// to a year, weekly beyond that.
const HISTORY = {
  hour: { interval: '1H', daysBack: 14, ttlMs: 10 * 60_000 },
  day: { interval: '1D', daysBack: 400, ttlMs: 60 * 60_000 },
  week: { interval: '1W', daysBack: 3700, ttlMs: 6 * 3600_000 },
};
for (const source of Object.values(HISTORY)) {
  source.get = cached(source.ttlMs, () => forEachSymbol(async (symbol) => {
    const bars = await loadBars(CHART_SYMBOL.get(symbol), source.interval, source.daysBack);
    return bars.length ? bars : null;
  }));
}

// Every period is measured from a closing level, counted back from the
// instrument's latest session (see sessionOf):
//   5 days          the close five sessions earlier
//   months, years   the last close on or before the same date that long ago
// `chart` is the bar size of the line drawn since then.
const RANGES = {
  '1w': { sessions: 5, chart: 'hour' },
  '1m': { months: 1, chart: 'day' },
  '3m': { months: 3, chart: 'day' },
  '6m': { months: 6, chart: 'day' },
  '1y': { months: 12, chart: 'day' },
  '5y': { months: 60, chart: 'week' },
  '10y': { months: 120, chart: 'week' },
};

function thin(bars) {
  if (bars.length <= SPARK_MAX_POINTS) return bars;
  const step = Math.ceil(bars.length / SPARK_MAX_POINTS);
  return bars.filter((_, i) => (bars.length - 1 - i) % step === 0);
}

// A bar's date. Daily and weekly bars are stamped at midnight New York time,
// which is the same calendar day in UTC.
const barDate = (bar) => new Date(bar[0]).toISOString().slice(0, 10);

// "2026-03-31" six months back is "2025-09-30": the day is held within the month.
function monthsBefore(date, months) {
  const [year, month, day] = date.split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 1 - months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(day, lastDay));
  return first.toISOString().slice(0, 10);
}

// The day after a date, skipping the weekend.
function nextWeekday(date) {
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
function sessionOf(quote, daily = []) {
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
function referenceBar(spec, session, weekly) {
  if (spec.sessions) return session.closed.at(-spec.sessions);
  const target = monthsBefore(session.date, spec.months);
  if (spec.chart === 'week') return weekly?.filter((bar) => barDate([bar[0] + 5 * DAY_MS]) <= target).at(-1);
  return session.closed.filter((bar) => barDate(bar) <= target).at(-1);
}

async function loadRange(range) {
  const spec = RANGES[range];
  const [daily, weekly, charted] = await Promise.all([
    HISTORY.day.get(),
    spec.chart === 'week' ? HISTORY.week.get() : null,
    HISTORY[spec.chart].get(),
  ]);
  const sparks = {};
  for (const symbol of SYMBOLS) {
    const session = sessionOf(lastQuotes[symbol], daily.value[symbol]);
    // Where the history is shorter than the period, the line starts at the
    // first bar there is. (The change over the period is a separate matter:
    // see loadBases, which reports none in that case.)
    const reference = referenceBar(spec, session, weekly?.value[symbol])
      ?? (spec.sessions ? null : charted.value[symbol]?.[0]);
    if (!reference) continue;
    // The line starts at the reference close and runs through everything since.
    const since = (bars) => (bars ?? []).filter((bar) => barDate(bar) > barDate(reference));
    let line = since(charted.value[symbol]);
    let step = spec.chart;
    // Some instruments have no hourly bars; draw their five days from daily closes.
    if (step === 'hour' && line.length < 2) { line = since(daily.value[symbol]); step = 'day'; }
    const series = thin([reference, ...line]);
    sparks[symbol] = { t: series.map((bar) => bar[0]), c: series.map((bar) => bar[1]), base: reference[1], step };
  }
  return { value: sparks, at: charted.at, error: charted.error || daily.error || weekly?.error || null };
}

// The closing level each period is measured from, for every row: what the
// change columns, the tiles and the detail panel calculate their figures
// against. A period the history does not reach back to has no entry.
async function loadBases() {
  const [daily, weekly] = await Promise.all([HISTORY.day.get(), HISTORY.week.get()]);
  const bases = Object.fromEntries(Object.keys(RANGES).map((range) => [range, {}]));
  for (const symbol of SYMBOLS) {
    const session = sessionOf(lastQuotes[symbol], daily.value[symbol]);
    for (const [range, spec] of Object.entries(RANGES)) {
      const reference = referenceBar(spec, session, weekly.value[symbol]);
      if (reference) bases[range][symbol] = reference[1];
    }
  }
  const incomplete = Boolean(daily.value[INCOMPLETE] || weekly.value[INCOMPLETE]);
  return { value: bases, at: Math.min(daily.at, weekly.at), error: daily.error || weekly.error, incomplete };
}

// Fetches every period's history once at start-up, one bar size at a time, so
// the first switch to a longer period does not wait on sixty-odd requests.
async function warmUp() {
  for (const get of [getQuotes, getProxyBars, getIntraday, ...Object.values(HISTORY).map((source) => source.get)]) {
    await get().catch(() => {});
  }
}

// ---- http -----------------------------------------------------------------

const getQuotes = cached(QUOTE_TTL_MS, loadQuotes);
const getIntraday = cached(SPARK_TTL_MS, () => forEachSymbol(loadSpark));
const getSparks = (range) => (RANGES[range] ? loadRange(range) : getIntraday());

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function sendData(res, key, get) {
  try {
    const { value, at, error, incomplete } = await get();
    sendJson(res, 200, { [key]: value, fetchedAt: at, error, incomplete: incomplete || Boolean(value?.[INCOMPLETE]) });
  } catch (err) {
    sendJson(res, 502, { error: err.message });
  }
}

async function sendStatic(res, pathname) {
  const file = path.join(PUBLIC_DIR, path.normalize(pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

http
  .createServer((req, res) => {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    if (pathname === '/api/config') return sendJson(res, 200, { sections: SECTIONS, markets: MARKETS, overview: OVERVIEW });
    if (pathname === '/api/quotes') return sendData(res, 'quotes', getQuotes);
    if (pathname === '/api/index') return sendData(res, 'detail', () => getIndexDetail(searchParams.get('symbol'), searchParams.get('range')));
    if (pathname === '/api/bases') return sendData(res, 'bases', loadBases);
    if (pathname === '/api/sparks') return sendData(res, 'sparks', () => getSparks(searchParams.get('range')));
    return sendStatic(res, decodeURIComponent(pathname));
  })
  .listen(PORT, HOST, () => {
    console.log(`Global Dashboard running at http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}`);
    warmUp();
  });
