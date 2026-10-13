// Zero-dependency server: serves the dashboard and proxies market data so the
// browser never talks to the data provider directly.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cached, forEachSymbol, INCOMPLETE, markIncomplete } from './cache.js';
import { createEdgar } from './edgar.js';
import { loadFredSeries, standIn } from './fred.js';
import { loadHoldings } from './holdings.js';
import { MARKETS, OVERVIEW, SECTIONS } from './instruments.js';
import { barDate, lineFor, monthsBefore, RANGES, referenceBar, sessionOf, thin } from './periods.js';
import { awaitingOpen, normalizeQuote, restoreLastSession } from './quote.js';
import { betweenDailyCloses, HOUR_BAR_MS, MINUTE_BAR_MS, momentBefore, priceAt, rangeSince } from './rolling.js';
import { sinceClose } from './sinceclose.js';

const PORT = Number(process.env.PORT) || 5177;
// Only this computer can reach the server unless HOST says otherwise; a
// hosting service sets HOST=0.0.0.0 to accept visitors.
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

// Settings for this computer only, kept out of the repository: the contact
// address the SEC asks every program to give (see edgar.js). SEC_CONTACT in
// the environment does the same on a hosting service.
const SETTINGS = await readFile(path.join(ROOT, 'settings.local.json'), 'utf8').then(JSON.parse).catch((err) => {
  // No file is the normal case; one that does not parse is worth a line in the log, not a stopped server.
  if (err.code !== 'ENOENT') console.error(`settings.local.json was not read: ${err.message}`);
  return {};
});
const edgarFinancials = createEdgar({ contact: process.env.SEC_CONTACT || SETTINGS.secContact, cacheDir: path.join(ROOT, '.cache', 'edgar') });

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
const FRED_TTL_MS = 6 * 3600_000; // FRED adds one figure a day
const REFERENCE_CONCURRENCY = 16; // several hundred small requests per index and period
const SPARK_TTL_MS = 180_000;
const SPARK_CONCURRENCY = 8;
const SESSION_GAP_MS = 3 * 3600_000; // a longer pause than this starts a new session
const SPARK_MAX_SPAN_MS = 24 * 3600_000;
const SPARK_MIN_BARS = 6;
const DAY_MS = 24 * 3600_000;

const SYMBOLS = [...new Set(SECTIONS.flatMap((s) => s.cards.flatMap((c) => c.groups.flatMap((g) => g.items.map((i) => i.symbol)))).filter(Boolean))];

// Where each row's chart history comes from: its own symbol, unless it names another.
const CHART_SYMBOL = new Map(SECTIONS.flatMap((s) => s.cards.flatMap((c) => c.groups.flatMap((g) =>
  g.items.filter((item) => item.symbol).map((item) => [item.symbol, item.chart ?? item.symbol])))));

// Rows with a second source for their history: the FRED series each one names.
const FRED_SERIES = new Map(SECTIONS.flatMap((s) => s.cards.flatMap((c) => c.groups.flatMap((g) =>
  g.items.filter((item) => item.fred).map((item) => [item.symbol, item.fred])))));

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

// ---- quotes ---------------------------------------------------------------

// Quotes for any list of symbols, fetched in batches, a few batches at a time.
// Symbols the feed does not know are simply absent from the result.
async function fetchQuotes(symbols, withStats = false) {
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
        const q = normalizeQuote(raw, withStats);
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

// The same, falling back on what the source gave last time: a refresh in
// progress must not make the figures built on it come and go.
function steady(get) {
  let last = null;
  return async () => {
    last = (await soon(get)) ?? last;
    return last;
  };
}

async function loadQuotes() {
  const fresh = await fetchQuotes([...new Set([...SYMBOLS, ...PROXY_SYMBOLS])]);
  if (!Object.keys(fresh).length) throw new Error('quote feed returned no data');
  // If a batch was lost even after the retry, its symbols keep their last quote.
  const quotes = { ...lastQuotes, ...fresh };
  lastQuotes = quotes;
  // A round-the-clock row's change is over the last 24 hours, not from the
  // feed's "previous close", and its range is that of the same 24 hours.
  for (const [symbol, { refs, day }] of Object.entries(await rollingRefs())) {
    const q = quotes[symbol];
    const ago = refs['1d'];
    Object.assign(q, { rolling: true, prevClose: ago, change: q.last - ago, changePct: (q.last / ago - 1) * 100 });
    if (day) Object.assign(q, { high: Math.max(day.high, q.last), low: Math.min(day.low, q.last) });
  }
  // Just after start-up the daily history is still loading. Do not hold the
  // first prices back for it; the next refresh applies what depends on it.
  const history = await dailyHistory();
  if (history) {
    for (const symbol of SYMBOLS) {
      const q = quotes[symbol];
      if (!q) continue;
      if (!q.rolling && awaitingOpen(q)) restoreLastSession(q, history[symbol]);
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
    if (!loaders.has(key)) loaders.set(key, cached(ttlMs, (known) => load(...args, known)));
    return loaders.get(key)();
  };
}

const holdingsOf = keyed(HOLDINGS_TTL_MS, (item) => loadHoldings(item.holdings.fund));

// An index's holdings, each with the symbol it is quoted under and its live quote.
const pricedOf = keyed(CONSTITUENT_TTL_MS, async (item) => {
  const { value: holdings } = await holdingsOf(item.symbol, item);
  const quotes = await fetchQuotes(holdings.items.flatMap((h) => h.symbols), true);
  // The feed occasionally drops a symbol from a batch; ask once more for the gaps.
  const missed = holdings.items.filter((h) => !h.symbols.some((s) => quotes[s])).flatMap((h) => h.symbols);
  if (missed.length) Object.assign(quotes, await fetchQuotes(missed, true).catch(() => ({})));
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
const referencesOf = keyed(REFERENCE_TTL_MS, async (item, range, known) => {
  const spec = RANGES[range];
  const [{ value: priced }, daily] = await Promise.all([pricedOf(item.symbol, item), HISTORY.day.get().catch(() => null)]);
  const session = sessionOf(lastQuotes[item.symbol], daily?.value[item.symbol]);
  const start = spec.sessions
    // Without the index's history, five sessions are taken to be a week.
    ? session.closed.at(-spec.sessions)?.[0] ?? Date.parse(session.date) - 7 * DAY_MS
    : Date.parse(monthsBefore(session.date, spec.months));
  const target = barDate([start]);
  return forEachSymbol(async (symbol) => {
    // The feed repeats an empty answer to a request it has just been sent, so
    // the end of the window moves by up to a minute to make each one new.
    const bars = await loadBarsBetween(symbol, '1D', start - 12 * DAY_MS, start + 2 * DAY_MS + (Date.now() % 60_000));
    // No bars is either the feed struggling or a share that did not trade
    // yet; it cannot be told which, so it is asked for again a few times.
    if (!bars.length) throw new Error('no bars');
    return bars.filter((bar) => barDate(bar) <= target).at(-1)?.[1];
  }, priced.rows.filter((row) => row.quote).map((row) => row.symbol), REFERENCE_CONCURRENCY, known);
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
        symbol: quoted,
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
  const result = (value) => ({ value, at: priced.at, error: priced.error, incomplete: Boolean(references?.[INCOMPLETE]) });
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

// One constituent of an index as a company: its price and key figures from
// the quote feed, its financial statements from the SEC. A share listed in
// the US is quoted under its bare ticker; elsewhere the symbol ends in a
// country code, which decides how the SEC's registrant is looked up.
async function constituent(indexSymbol, symbol) {
  const item = INDEX_ITEMS.get(indexSymbol);
  if (!item) throw new Error('no constituent data for this index');
  const priced = await pricedOf(indexSymbol, item);
  const row = priced.value.rows.find((candidate) => candidate.symbol === symbol);
  if (!row?.quote) throw new Error('not a constituent of this index');
  return { item, priced, ...row };
}

async function getCompany(indexSymbol, symbol) {
  const { item, priced, holding, quote } = await constituent(indexSymbol, symbol);
  const filings = await edgarFinancials({ ticker: holding.ticker, names: [quote.fullName, holding.name].filter(Boolean), us: !/-[A-Z]{2}$/.test(symbol) });
  const company = { symbol, ticker: holding.ticker, name: quote.fullName || holding.name, sector: holding.sector, weight: holding.weight, index: item.name, quote, filings };
  return { value: company, at: priced.at, error: priced.error };
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

// The latest session of anything the feed charts, in ten-minute bars.
async function intraday(symbol) {
  // Two days covers a normal weekday; widen for weekends and holidays.
  let bars = await loadBars(symbol, '10M', 2);
  if (bars.length < 2) bars = await loadBars(symbol, '10M', 7);
  return lastSession(bars);
}

const loadSpark = (symbol) => intraday(CHART_SYMBOL.get(symbol));

const dailyHistory = steady(() => HISTORY.day.get());

const getProxyBars = cached(SPARK_TTL_MS, () => forEachSymbol((symbol) => loadBars(symbol, '10M', PROXY_DAYS_BACK), PROXY_SYMBOLS, SPARK_CONCURRENCY));

// ---- longer periods ---------------------------------------------------------

// Three bar sizes cover every period: hourly for the five-day chart, daily up
// to a year, weekly beyond that.
const HISTORY = {
  hour: { interval: '1H', daysBack: 14, ttlMs: 10 * 60_000 },
  day: { interval: '1D', daysBack: 400, ttlMs: 60 * 60_000 },
  week: { interval: '1W', daysBack: 3700, ttlMs: 6 * 3600_000 },
};
for (const source of Object.values(HISTORY)) {
  // When the feed is struggling it answers some requests with no bars at all.
  // That is not the same as an instrument having none: every one has daily
  // and weekly bars, and hourly ones if it has had them before. So an empty
  // answer counts as a failed request and is asked for again.
  const charted = new Map(); // when the feed last had bars for each symbol
  source.get = cached(source.ttlMs, async (known) => {
    const loaded = await forEachSymbol(async (symbol) => {
      const bars = await loadBars(CHART_SYMBOL.get(symbol), source.interval, source.daysBack);
      if (bars.length) {
        charted.set(symbol, Date.now());
        return bars;
      }
      if (source === HISTORY.hour && !charted.has(symbol)) return null;
      throw new Error('no bars');
    }, SYMBOLS, SPARK_CONCURRENCY, known).catch((err) => ({ outage: err }));
    // With the feed's history down altogether, the stand-in is all there is.
    const result = await standIn(loaded.outage ? markIncomplete({}, [...SYMBOLS], SYMBOLS.length) : loaded, source, charted, fredLookups);
    if (loaded.outage && !Object.keys(result).length) throw loaded.outage;
    return result;
  });
}

// Where the feed has had no history for a Treasury yield for half a day,
// FRED's official series stands in (see standIn in fred.js). This is where it
// looks things up: the series a row names, that series' daily closes, and the
// row's latest quote.
const fredSeries = keyed(FRED_TTL_MS, (id) => loadFredSeries(id));
const fredLookups = {
  seriesOf: (symbol) => FRED_SERIES.get(symbol),
  load: (id) => fredSeries(id, id).then((series) => series.value),
  quoteOf: (symbol) => lastQuotes[symbol],
};

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
    const line = lineFor(spec, session, daily.value[symbol], weekly?.value[symbol], charted.value[symbol]);
    if (line) sparks[symbol] = line.spark;
  }
  for (const [symbol, entry] of Object.entries(await rollingRefs())) {
    const line = rollingLine(range, entry, daily.value[symbol], weekly?.value[symbol]);
    if (line) sparks[symbol] = line;
  }
  return { value: sparks, at: charted.at, error: charted.error || daily.error || weekly?.error || null };
}

// The same for one constituent of an index, for the chart in its company
// panel: its line over a period and the close that period is measured from.
// Fetched when the chart is asked for and kept as long as the intraday lines.
const chartOf = keyed(SPARK_TTL_MS, async (indexSymbol, symbol, range) => {
  const spec = RANGES[range];
  if (!spec) return { spark: await intraday(symbol), from: null };
  // The quote is looked up on every load: the session it belongs to moves on
  // from day to day, and the period is counted back from it.
  const { quote } = await constituent(indexSymbol, symbol);
  const source = HISTORY[spec.chart];
  const [daily, charted] = await Promise.all([
    loadBars(symbol, HISTORY.day.interval, HISTORY.day.daysBack),
    spec.chart === 'day' ? null : loadBars(symbol, source.interval, source.daysBack),
  ]);
  // An empty answer is the feed struggling (see the history loaders): better
  // no chart now and another try than a blank one kept for minutes.
  if (!daily.length || (spec.chart === 'week' && !charted.length)) throw new Error('no chart history just now');
  const line = lineFor(spec, sessionOf(quote, daily), daily, spec.chart === 'week' ? charted : null, charted ?? daily);
  return line ?? { spark: null, from: null };
});

async function getChart(indexSymbol, symbol, range) {
  await constituent(indexSymbol, symbol); // only an index's own constituents are charted
  const period = RANGES[range] ? range : '1d';
  return chartOf(`${indexSymbol}|${symbol}|${period}`, indexSymbol, symbol, period);
}

// ---- markets that never close -------------------------------------------------

// Crypto is priced round the clock, so its periods are spans of the clock and
// not counted from a close (see rolling.js): the last 24 hours, the last 120,
// the same time of day so many months back. `read` is where the price at that
// moment comes from: ten-minute bars reach a week back, hourly ones about
// three months, and beyond that there are only daily closes to place it between.
const ROLLING = SECTIONS.flatMap((s) => s.cards.flatMap((c) => c.groups.flatMap((g) =>
  g.items.filter((item) => item.rolling).map((item) => item.symbol))));
const SPANS = {
  '1d': { hours: 24, read: 'minutes' },
  '1w': { hours: 120, read: 'minutes' },
  '1m': { months: 1, read: 'hours' },
  '3m': { months: 3, read: 'hours' },
  '6m': { months: 6, read: 'days' },
  '1y': { months: 12, read: 'days' },
  '5y': { months: 60, read: 'years' },
  '10y': { months: 120, read: 'years' },
};
const MINUTE_DAYS = 6; // five days and a margin
const MOMENTS_TTL_MS = 10 * 60_000;

// Ten-minute bars of the last six days: the prices 24 hours and 5 days ago,
// the range of the day, and the lines since.
//
// A row quoted under one symbol and charted under another (XRP) has two series
// that sit a little apart. `scale` is the quote over the newest bar as both
// stood when the bars were fetched: it brings the charted prices to the
// quote's level before the two are compared.
const getMinutes = cached(SPARK_TTL_MS, (known) => forEachSymbol(async (symbol) => {
  const bars = await loadBars(CHART_SYMBOL.get(symbol), '10M', MINUTE_DAYS);
  if (!bars.length) throw new Error('no bars');
  const quoted = CHART_SYMBOL.get(symbol) === symbol ? null : (await getQuotes().catch(() => null))?.value[symbol]?.last;
  return { bars, scale: quoted ? quoted / bars.at(-1)[1] : 1 };
}, ROLLING, SPARK_CONCURRENCY, known));

// The few bars either side of the moments further back: hourly ones for one
// and three months ago, daily ones for five and ten years ago. (Six months
// and a year are read from the daily history every row has.)
//
// An empty answer is usually the feed struggling, so it counts as a failed
// request and is asked for again. `young` says a row may truly have nothing
// that far back (a coin under five years old): then only nothing at all does.
function barsAround(ranges, interval, reachMs, ttlMs, young = false) {
  return cached(ttlMs, (known) => forEachSymbol(async (symbol) => {
    const around = {};
    for (const range of ranges) {
      const moment = momentBefore(Date.now(), SPANS[range]);
      around[range] = await loadBarsBetween(CHART_SYMBOL.get(symbol), interval, Math.floor((moment - reachMs) / 3600_000) * 3600_000, moment + reachMs);
    }
    const empty = Object.values(around).filter((bars) => !bars.length).length;
    if (young ? empty === ranges.length : empty > 0) throw new Error('no bars');
    return around;
  }, ROLLING, SPARK_CONCURRENCY, known));
}
// The feed reads the times it is asked for as New York time, four or five
// hours off, so the window is a day either side and not a few hours.
const getHoursBack = barsAround(['1m', '3m'], '1H', DAY_MS, MOMENTS_TTL_MS);
const getYearsBack = barsAround(['5y', '10y'], '1D', 3 * DAY_MS, HISTORY.day.ttlMs, true);

// For each round-the-clock row, as of this moment: its price a span ago for
// every period (`refs`), the range of the last 24 hours (`day`), and its
// ten-minute bars. A row whose bars are not at hand, or do not reach back 24
// hours, is left out: it is measured from closes like the rest until they do.
const rollingSources = [getMinutes, getHoursBack, () => HISTORY.day.get(), getYearsBack].map(steady);

async function rollingRefs() {
  const [minutes, hours, days, years] = await Promise.all(rollingSources.map((source) => source()));
  const now = Date.now();
  const rows = {};
  for (const symbol of ROLLING) {
    if (!minutes?.[symbol] || !lastQuotes[symbol]) continue;
    const { bars, scale } = minutes[symbol];
    const read = {
      minutes: (moment) => priceAt(bars, MINUTE_BAR_MS, moment),
      hours: (moment, range) => priceAt(hours?.[symbol]?.[range], HOUR_BAR_MS, moment),
      days: (moment) => betweenDailyCloses(days?.[symbol], moment),
      years: (moment, range) => betweenDailyCloses(years?.[symbol]?.[range], moment),
    };
    const refs = {};
    for (const [range, span] of Object.entries(SPANS)) {
      const price = read[span.read](momentBefore(now, span), range);
      if (price != null) refs[range] = price * scale;
    }
    if (refs['1d'] == null) continue;
    const day = rangeSince(bars, MINUTE_BAR_MS, momentBefore(now, SPANS['1d']));
    rows[symbol] = { refs, bars, scale, now, day: day && { high: day.high * scale, low: day.low * scale } };
  }
  return rows;
}

// A round-the-clock row's line over a period: from its price a span ago
// through every bar that has ended since. Null when that price is not known.
function rollingLine(range, { refs, bars, scale, now }, daily, weekly) {
  if (refs[range] == null) return null;
  const moment = momentBefore(now, SPANS[range]);
  // Each bar is placed where it ends: a daily one at its 4 p.m. New York close, a weekly one at Friday's.
  const [source, endsAfterMs, step] = SPANS[range].read === 'minutes' ? [bars, MINUTE_BAR_MS, range === '1d' ? undefined : 'hour']
    : RANGES[range].chart === 'week' ? [weekly, 5 * DAY_MS + 16 * 3600_000, 'week']
      : [daily, 16 * 3600_000, 'day'];
  const since = thin((source ?? []).filter((bar) => bar[0] + endsAfterMs > moment));
  if (range === '1d') return since.length < 2 ? null : { t: since.map((bar) => bar[0] + endsAfterMs), c: since.map((bar) => bar[1] * scale) };
  return { t: [moment, ...since.map((bar) => bar[0] + endsAfterMs)], c: [refs[range], ...since.map((bar) => bar[1] * scale)], base: refs[range], step };
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
  // A round-the-clock row is measured from its price a span ago instead.
  for (const [symbol, { refs }] of Object.entries(await rollingRefs())) {
    for (const range of Object.keys(RANGES)) if (refs[range] != null) bases[range][symbol] = refs[range];
  }
  const incomplete = Boolean(daily.value[INCOMPLETE] || weekly.value[INCOMPLETE]);
  // Rows whose history is another source's for now, and which one.
  const backup = Object.fromEntries(SYMBOLS.map((symbol) => [symbol, daily.value[symbol]?.source ?? weekly.value[symbol]?.source]).filter(([, source]) => source));
  return { value: bases, at: Math.min(daily.at, weekly.at), error: daily.error || weekly.error, incomplete, backup };
}

// Fetches every period's history once at start-up, one bar size at a time, so
// the first switch to a longer period does not wait on sixty-odd requests.
async function warmUp() {
  for (const get of [getQuotes, getProxyBars, getIntraday, getMinutes, ...Object.values(HISTORY).map((source) => source.get), getHoursBack, getYearsBack]) {
    await get().catch(() => {});
  }
}

// ---- http -----------------------------------------------------------------

const getQuotes = cached(QUOTE_TTL_MS, loadQuotes);
const getIntraday = cached(SPARK_TTL_MS, () => forEachSymbol(loadSpark, SYMBOLS, SPARK_CONCURRENCY));
// The lines of the day: each row's latest session, and the last 24 hours for a
// round-the-clock row.
async function loadDay() {
  const sessions = await getIntraday();
  const value = { ...sessions.value };
  for (const [symbol, entry] of Object.entries(await rollingRefs())) {
    const line = rollingLine('1d', entry);
    if (line) value[symbol] = line;
  }
  if (sessions.value[INCOMPLETE]) markIncomplete(value, sessions.value[INCOMPLETE]);
  return { ...sessions, value };
}

const getSparks = (range) => (RANGES[range] ? loadRange(range) : loadDay());

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function sendData(res, key, get) {
  try {
    const { value, at, error, incomplete, ...more } = await get();
    sendJson(res, 200, { [key]: value, fetchedAt: at, error, incomplete: incomplete || Boolean(value?.[INCOMPLETE]), ...more });
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
    if (pathname === '/api/company') return sendData(res, 'company', () => getCompany(searchParams.get('index'), searchParams.get('symbol')));
    if (pathname === '/api/chart') return sendData(res, 'chart', () => getChart(searchParams.get('index'), searchParams.get('symbol'), searchParams.get('range')));
    if (pathname === '/api/bases') return sendData(res, 'bases', loadBases);
    if (pathname === '/api/sparks') return sendData(res, 'sparks', () => getSparks(searchParams.get('range')));
    return sendStatic(res, decodeURIComponent(pathname));
  })
  .listen(PORT, HOST, () => {
    console.log(`Global Dashboard running at http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}`);
    warmUp();
  });
