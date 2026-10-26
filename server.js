// Zero-dependency server: serves the dashboard and proxies market data so the
// browser never talks to the data provider directly.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEdgar, trailingEarnings } from './edgar.js';
import { loadFredSeries, weekly as weeklyBars } from './fred.js';
import { loadHoldings } from './holdings.js';
import { MARKETS } from './instruments.js';
import { openLayout, Refusal } from './layout.js';
import { nameMatch, nameParts, typedName } from './names.js';
import { betweenDailyCloses, HOUR_BAR_MS, MINUTE_BAR_MS, momentBefore, priceAt, rangeSince } from './rolling.js';
import { sinceClose } from './sinceclose.js';
import { valuationMeasures } from './valuation.js';

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
const edgar = createEdgar({ contact: process.env.SEC_CONTACT || SETTINGS.secContact, cacheDir: path.join(ROOT, '.cache', 'edgar') });

const QUOTE_URL = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol';
const BARS_URL = 'https://ts-api.cnbc.com/harmony/app/bars';
const LOOKUP_URL = 'https://symlookup.cnbc.com/symservice/symlookup.do';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const QUOTE_TTL_MS = 10_000;
const QUOTE_BATCH = 50;
const QUOTE_TIMEOUT_MS = 6_000;
const QUOTE_CONCURRENCY = 4;
const CONSTITUENT_TTL_MS = 60_000;
const HOLDINGS_TTL_MS = 12 * 3600_000;
const REFERENCE_TTL_MS = 30 * 60_000;
const FRED_TTL_MS = 6 * 3600_000; // FRED adds one figure a day
const BACKUP_AFTER_MS = 12 * 3600_000;
const REFERENCE_CONCURRENCY = 16; // several hundred small requests per index and period
const SPARK_TTL_MS = 180_000;
const SPARK_CONCURRENCY = 8;
const SESSION_GAP_MS = 3 * 3600_000; // a longer pause than this starts a new session
const SPARK_MAX_SPAN_MS = 24 * 3600_000;
const SPARK_MIN_BARS = 6;
const SPARK_MAX_POINTS = 300;
const DAY_MS = 24 * 3600_000;

// What the page shows: the defaults in instruments.js with the changes made
// from the page, kept in layout.local.json (see layout.js). The lists below
// are drawn from it, and drawn again whenever it changes; everything that
// reads them does so when it runs, so a row added from the page is picked up.
const LAYOUT = await openLayout(path.join(ROOT, 'layout.local.json'));
let layoutVersion; // changes with every edit, so that open pages know to fetch the layout again

let SYMBOLS;
let CHART_SYMBOL; // where each row's chart history comes from: its own symbol, unless it names another
let FRED_SERIES; // rows with a second source for their history: the FRED series each one names
let PROXIED; // indexes whose move since the close is read from a future or ETF that keeps trading
let PROXY_SYMBOLS;
let INDEX_ITEMS; // indexes whose constituents the detail panel shows
let ROLLING; // rows priced round the clock (see "markets that never close")

function applyLayout() {
  const rows = LAYOUT.current().sections.flatMap((s) => s.cards.flatMap((c) => c.groups.flatMap((g) =>
    g.items.filter((item) => item.symbol).map((item) => ({ ...item, market: item.market ?? g.markets?.[0] })))));
  SYMBOLS = [...new Set(rows.map((item) => item.symbol))];
  CHART_SYMBOL = new Map(rows.map((item) => [item.symbol, item.chart ?? item.symbol]));
  FRED_SERIES = new Map(rows.filter((item) => item.fred).map((item) => [item.symbol, item.fred]));
  PROXIED = rows.filter((item) => item.proxy).map((item) => ({ symbol: item.symbol, market: item.market, proxy: item.proxy.symbol }));
  PROXY_SYMBOLS = [...new Set(PROXIED.map((p) => p.proxy))];
  INDEX_ITEMS = new Map(rows.filter((item) => item.holdings).map((item) => [item.symbol, item]));
  ROLLING = rows.filter((item) => item.rolling).map((item) => item.symbol);
  layoutVersion = Math.max(Date.now(), (layoutVersion ?? 0) + 1);
}
applyLayout();

const PROXY_DAYS_BACK = 7; // far enough to reach the last close across a long weekend

// The Mac's own resolver now and then says one of the feed's hosts does not
// exist, for a minute or so at a time, while the DNS server answers for it as
// usual: on 2026-10-23 symlookup.cnbc.com, the search box's lookup, failed
// that way while quote.cnbc.com, on the same address, did not. Such a request
// is made again with the host's address asked of the DNS server directly.
const UNRESOLVED = new Set(['ENOTFOUND', 'EAI_AGAIN']);

async function fetchJson(url, timeoutMs = 12_000) {
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (!UNRESOLVED.has(err.cause?.code)) throw err;
    return getJsonResolvedDirectly(url, headers, timeoutMs);
  }
  if (!res.ok) throw new Error(`${new URL(url).hostname} responded ${res.status}`);
  return res.json();
}

// dns.lookup's answer, from the DNS server instead of the system resolver.
function resolveDirectly(hostname, options, callback) {
  dns.resolve4(hostname, (err, addresses) => {
    if (err) callback(err);
    else if (options.all) callback(null, addresses.map((address) => ({ address, family: 4 })));
    else callback(null, addresses[0], 4);
  });
}

function getJsonResolvedDirectly(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, lookup: resolveDirectly, signal: AbortSignal.timeout(timeoutMs) }, (res) => {
      if (res.statusCode < 200 || res.statusCode > 299) {
        res.resume();
        reject(new Error(`${new URL(url).hostname} responded ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

// Marks a result as missing some of its symbols and names them, without the
// mark showing up among its entries. When every one of `total` symbols is
// missing, the list is flagged as an outage: the source itself is down (the
// network, or the feed's history service), not one instrument.
const INCOMPLETE = Symbol('incomplete');
const markIncomplete = (results, failed, total = Infinity) => Object.defineProperty(results, INCOMPLETE, {
  value: Object.assign(failed, { outage: failed.outage || failed.length >= total }),
});
const RETRY_INCOMPLETE_MS = 20_000;

// Serves a cached value while fresh, shares one in-flight refresh between
// callers, and falls back to the last good value when the provider fails.
// The provider is sometimes slow (most of all around the US open), so once
// there is a value a caller waits only `patienceMs` for the refresh: after
// that it gets the previous value, and the refresh finishes in the background.
//
// A load can come back incomplete (see forEachSymbol): some symbols failed,
// because the network was not up yet when the computer woke, or because the
// feed is struggling and answers with nothing. Such a result is topped up with
// what was known before, and `load` is called again after
// `RETRY_INCOMPLETE_MS` with the incomplete value, so that it can ask for the
// missing symbols alone. While the very same symbols keep failing, each wait
// is twice the last: a symbol that has no data at all is not asked for
// endlessly. An outage is the exception: when everything is missing the
// source is down, it comes back all at once, and it is asked every time.
// Everything is loaded afresh once the cache time is up, as usual.
function cached(ttlMs, load, patienceMs = 2_500) {
  let value = null;
  let at = 0; // when everything was last loaded
  let retryAt = Infinity; // when an incomplete value is next topped up
  let stuck = 0; // top-ups in a row that the same symbols failed in
  let pending = null;
  const keep = (loaded, everything) => {
    const failed = loaded?.[INCOMPLETE];
    const before = value?.[INCOMPLETE];
    const merged = value && (failed || !everything) ? { ...value, ...loaded } : loaded;
    value = failed ? markIncomplete(merged, failed) : merged;
    if (everything) at = Date.now();
    const same = failed && before && failed.length === before.length && failed.every((symbol) => before.includes(symbol));
    stuck = same && !failed.outage ? stuck + 1 : 0;
    retryAt = failed ? Date.now() + RETRY_INCOMPLETE_MS * 2 ** Math.min(stuck, 10) : Infinity;
  };
  const get = async () => {
    const stale = !value || Date.now() - at >= ttlMs;
    if (!stale && Date.now() < retryAt) return { value, at, error: null };
    pending ??= load(stale ? null : value)
      .then((v) => { keep(v, stale); return null; })
      .catch((err) => {
        if (!stale) retryAt = Date.now() + RETRY_INCOMPLETE_MS;
        return err.message || String(err);
      })
      .finally(() => { pending = null; });
    const slow = new Promise((resolve) => setTimeout(resolve, patienceMs, null));
    const error = await (value ? Promise.race([pending, slow]) : pending);
    if (!value) throw new Error(error || 'no data');
    return { value, at, error };
  };
  // For rows just added to the page: the symbols the value lacks are fetched
  // at once, alone, the way failed ones are topped up, rather than waiting
  // for the next full load. Resolves once they have been asked for. A load
  // already under way began with the old list of rows, so it is let finish first.
  get.include = async (symbols) => {
    while (pending) await pending;
    if (!value) return; // the first load asks for every row anyway
    const absent = symbols.filter((symbol) => !(symbol in value));
    if (!absent.length) return;
    value = markIncomplete({ ...value }, [...new Set([...(value[INCOMPLETE] ?? []), ...absent])]);
    retryAt = 0;
    stuck = 0;
    get().catch(() => {});
    await pending;
  };
  return get;
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
  const millions = amount(raw.enterpriseValue);
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
    enterpriseValue: millions == null ? null : millions * 1e6,
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
function normalizeQuote(raw, withStats = false) {
  const last = num(raw.last);
  if (raw.code !== 0 || last == null) return null;
  const dp = decimals(raw.last, last);
  const date = (raw.last_time || '').slice(0, 10) || null;
  // Pre-market or after-hours trading. Its change is measured from the price
  // the regular session left off at, so while that is still the price quoted
  // it is current; once the regular session trades again it is not (the feed
  // goes on giving the morning's pre-market trade through the day).
  const ext = raw.ExtendedMktQuote;
  const extLast = ext ? num(ext.last) : null;
  const extended = extLast == null ? null : change(extLast, ext.change, ext.change_pct);
  // The feed also goes on giving an evening's after-hours trade through the
  // next day's session, its change worked out afresh from the new price, so
  // it passes the test above (LQD on a Monday, with Friday's): a trade from an
  // earlier day than the regular session's latest is not current either.
  const earlier = Boolean(date && ext?.last_time && ext.last_time.slice(0, 10) < date);
  const current = extended && !earlier && Math.abs(extended.prevClose - last) <= 0.5 * 10 ** -places(ext.last) + 0.5 * 10 ** -dp + 1e-9;
  return {
    last,
    ...change(last, raw.change, raw.change_pct),
    dp,
    high: positive(raw.high),
    low: positive(raw.low),
    yrHigh: positive(raw.yrhiprice),
    yrLow: positive(raw.yrloprice),
    currency: raw.currencyCode || null,
    time: raw.last_timedate || null,
    date,
    realTime: raw.realTime === 'true',
    session: raw.curmktstatus || null,
    contract: /\(([A-Z][a-z]{2})'(\d{2})\)/.exec(raw.name || '')?.slice(1, 3).join(" '") || null,
    fullName: raw.name || null,
    stats: withStats ? companyStats(raw) : undefined,
    ext: !current ? null : {
      type: ext.type || null,
      last: extLast,
      ...extended,
      time: ext.last_timedate || null,
      volume: amount(ext.volume),
    },
  };
}

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
  // For an index whose exchange has closed, the move since then: since the
  // close of the session its quote belongs to. Ahead of the open the feed
  // dates the quote today, and today's close is still to come.
  const proxyBars = await soon(getProxyBars);
  for (const { symbol, market, proxy } of proxyBars ? PROXIED : []) {
    const q = quotes[symbol];
    if (q) q.after = sinceClose({ ...q, date: q.date && sessionOf(q, history?.[symbol]).date }, MARKETS[market], quotes[proxy], proxyBars[proxy]);
  }
  return quotes;
}

// ---- index constituents -----------------------------------------------------

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

// Without an index it is any share, found from the search box.
async function getCompany(indexSymbol, symbol) {
  if (!indexSymbol) return getShare(symbol);
  const { item, priced, holding, quote } = await constituent(indexSymbol, symbol);
  const filings = await edgar.financials({ ticker: holding.ticker, names: [quote.fullName, holding.name].filter(Boolean), us: !/-[A-Z]{2}$/.test(symbol) });
  const company = { symbol, ticker: holding.ticker, name: quote.fullName || holding.name, sector: holding.sector, weight: holding.weight, index: item.name, quote, ...await withEarnings(symbol, quote, filings) };
  return { value: company, at: priced.at, error: priced.error };
}

// ---- any share, found by its symbol or its company's name ---------------------

// The search box takes a symbol or a company's name. It offers, best first:
// the symbol typed, where there is one; companies whose name is the one typed,
// or begins with the words typed; then the rest of what the feed's own symbol
// lookup finds (instruments whose symbol or name starts with the text, in the
// order it ranks them), preferred shares last.
//
// The lookup alone misses many names. It matches the text letter for letter,
// so "coca cola" finds a bottler in Hokkaido and not Coca-Cola, and it gives
// twenty answers in nearly alphabetical order, so "goldman" fills up with
// Goldman Sachs funds before it reaches the bank. Names are therefore also
// looked up, as names.js compares them, among the companies the dashboard
// knows: its indexes' constituents, under the listing their index panel uses,
// and the SEC's registrants, under their US ticker and by their whole name
// only (there are ten thousand of them). Companies that answer alike are
// ranked by market value.
//
// A company listed in several countries comes once: under its index's listing
// when it is a constituent (UniCredit in Milan, not Frankfurt), else under the
// first country the lookup lists it in, passing over one where it trades only
// in Frankfurt or over the counter (Tencent in Hong Kong). Another listing
// comes when its symbol is typed exactly; share classes in one country (BRK.A
// and BRK.B) all come. Answers are kept ten minutes.
const SEARCH_TTL_MS = 10 * 60_000;
const SEARCH_KEPT = 200;
const SEARCH_SHOWN = 10;
const NAMED_TRIED = 8; // companies found by name whose quotes are asked for
const NAMED_SHOWN = 5;
const NAMES_PATIENCE_MS = 1_500; // a list of names still loading is waited for this long
const SECONDARY_VENUE = /frankfurt|over the counter|^otc/i;
const PREFERRED = new Set(['PR', 'CP']);
const searches = new Map(); // what was typed → { at, results }, oldest first

// The market a symbol trades in, from its suffix: UCG-IT is Milan's, CRIN-FF
// Frankfurt's, and one without a suffix is American.
const marketOf = (symbol) => /-([A-Z]{2})$/.exec(symbol)?.[1] ?? 'US';

// Dollars per unit of a currency, for comparing market values. Most pairs are
// quoted in units per dollar (USD/JPY), these in dollars per unit (EUR/USD).
const PER_UNIT_PAIRS = new Set(['EUR', 'GBP', 'AUD', 'NZD']);
const RATE_TTL_MS = 3600_000;
const dollarsPerUnit = keyed(RATE_TTL_MS, async (code) => {
  const rate = (await fetchQuotes([`${code}=`]))[`${code}=`]?.last;
  if (!rate) throw new Error(`the quote feed has no rate for ${code}`);
  return PER_UNIT_PAIRS.has(code) ? rate : 1 / rate;
});

async function inDollars(amount, currency) {
  if (amount == null || !currency) return null;
  const code = currency === 'GBp' ? 'GBP' : currency; // London prices are in pence, its values in pounds
  if (code === 'USD') return amount;
  return dollarsPerUnit(code, code).then(({ value }) => amount * value, () => null);
}

// Every company the dashboard can find by name, its name taken apart once:
// made again when one of the lists changes.
let names = { lists: [], constituents: [], registrants: [] };

async function namesKnown() {
  const lists = await Promise.all([
    ...[...INDEX_ITEMS.values()].map((item) => soon(() => holdingsOf(item.symbol, item), NAMES_PATIENCE_MS)),
    soon(async () => ({ value: await edgar.registered() }), NAMES_PATIENCE_MS),
  ]);
  if (lists.length === names.lists.length && lists.every((list, i) => list === names.lists[i])) return names;
  const holdings = lists.slice(0, -1).filter(Boolean);
  names = {
    lists,
    constituents: holdings.flatMap((list) => list.items)
      .filter((holding) => holding.symbols.length)
      .map((holding) => ({ symbols: holding.symbols, name: holding.name, weight: holding.weight, parts: nameParts(holding.name) })),
    registrants: (lists.at(-1) ?? []).map((registrant) => ({ symbols: [registrant.ticker.replaceAll('-', '.')], name: registrant.title, parts: nameParts(registrant.title) })),
  };
  return names;
}

// The companies whose name answers what was typed (see names.js): a
// constituent by its name or the words it begins with, a registrant by its
// whole name. Each comes once, under its listings in the market where it
// weighs most in the dashboard's indexes. Whole names first.
function companiesNamed(typed, { constituents, registrants }) {
  const byName = new Map(); // a name that answers → the constituents' listings under it
  for (const company of constituents) {
    const match = nameMatch(company.parts, typed);
    if (!match) continue;
    if (!byName.has(company.parts.core)) byName.set(company.parts.core, []);
    byName.get(company.parts.core).push({ ...company, match });
  }
  const listed = [];
  for (const listings of byName.values()) {
    const market = marketOf(listings.reduce((a, b) => (b.weight > a.weight ? b : a)).symbols[0]);
    for (const listing of listings) {
      if (marketOf(listing.symbols[0]) !== market) continue;
      // One listing in several indexes (the S&P 500 and the Nasdaq 100) comes once.
      const same = listed.find((other) => other.symbols[0] === listing.symbols[0]);
      if (same) same.weight = Math.max(same.weight, listing.weight);
      else listed.push(listing);
    }
  }
  listed.sort((a, b) => b.weight - a.weight);
  const registered = [];
  for (const company of registrants) {
    if (registered.length === NAMED_TRIED) break;
    if (nameMatch(company.parts, typed) !== 'name' || byName.has(company.parts.core)) continue;
    byName.set(company.parts.core, []);
    registered.push({ ...company, match: 'name' });
  }
  const whole = listed.filter((company) => company.match === 'name');
  return [...whole, ...registered, ...listed.filter((company) => company.match !== 'name')].slice(0, NAMED_TRIED);
}

// The companies found by name, as offered: each under the first of its
// symbols the feed prices, with the feed's name for it, and the larger
// companies first among those that answer alike.
async function offeredByName(typed) {
  const companies = companiesNamed(typed, await namesKnown());
  if (!companies.length) return [];
  const quotes = await fetchQuotes([...new Set(companies.flatMap((company) => company.symbols))], true).catch(() => ({}));
  const offered = await Promise.all(companies.map(async (company) => {
    const symbol = company.symbols.find((s) => quotes[s]);
    if (!symbol) return null;
    const quote = quotes[symbol];
    return {
      symbol,
      forms: company.symbols,
      name: quote.fullName || company.name,
      type: 'STOCK',
      exchange: quote.stats?.exchange ?? null,
      match: company.match,
      market: marketOf(symbol),
      names: new Set([company.parts.core, nameParts(quote.fullName ?? '').core]),
      value: await inDollars(quote.stats?.marketCap, quote.currency),
    };
  }));
  return offered.filter(Boolean)
    .sort((a, b) => (a.match !== b.match ? (a.match === 'name' ? -1 : 1) : (b.value ?? -1) - (a.value ?? -1)))
    .slice(0, NAMED_SHOWN);
}

async function lookUp(query) {
  const params = new URLSearchParams({ prefix: query, partnerid: '20064', pgok: '1', pgsize: '20' });
  return [].concat((await fetchJson(`${LOOKUP_URL}?${params}`, QUOTE_TIMEOUT_MS)) ?? []).filter((entry) => entry?.symbolName);
}

async function search(text) {
  const query = String(text ?? '').trim().slice(0, 40);
  const key = query.toLowerCase();
  if (!key) return { value: [], at: Date.now(), error: null };
  const kept = searches.get(key);
  if (kept && Date.now() - kept.at < SEARCH_TTL_MS) return { value: kept.results, at: kept.at, error: null };
  const asName = typedName(query);
  const typed = asName.length >= 2 ? asName : null; // a name is two letters at least
  const [lookup, named] = await Promise.all([
    lookUp(query).then((found) => ({ found }), (err) => ({ found: [], err })),
    typed ? offeredByName(typed) : [],
  ]);
  if (lookup.err && !named.length) throw lookup.err;
  const { found } = lookup;

  // Where the lookup would have each company it lists.
  const home = new Map(); // issuer → { country, secondary }
  for (const entry of found) {
    const issuer = entry.issuerId ?? entry.symbolName;
    const secondary = SECONDARY_VENUE.test(entry.exchangeName ?? '');
    if (!home.has(issuer) || (home.get(issuer).secondary && !secondary)) home.set(issuer, { country: entry.countryCode, secondary });
  }
  // A company found by name is at home where its listing is, and the lookup's
  // listings of it elsewhere are left out: those of its issuer, when the
  // lookup says who issued its listing, else those under its name. The
  // lookup may write the listing's symbol another way (NES.N-CH for NESN-CH).
  const namedAs = new Map(); // a way of writing a named company's symbol → the symbol
  const namedIssuers = new Map(); // issuer → market
  const namedNames = new Map(); // name → market
  for (const company of named) {
    for (const form of company.forms) namedAs.set(form, company.symbol);
    const entry = found.find((candidate) => company.forms.includes(candidate.symbolName));
    if (entry?.issuerId != null) namedIssuers.set(entry.issuerId, company.market);
    else for (const name of company.names) namedNames.set(name, company.market);
  }

  const offered = new Map(named.map(({ symbol, name, type, exchange, match }) => [symbol, { symbol, name, type, exchange, rank: match === 'name' ? 1 : 2 }]));
  for (const entry of found) {
    const issuer = entry.issuerId ?? entry.symbolName;
    const parts = nameParts(entry.companyName ?? '');
    const market = marketOf(entry.symbolName);
    const exact = entry.symbolName.toLowerCase() === key;
    const atHome = namedIssuers.has(issuer) ? namedIssuers.get(issuer) === market
      : namedNames.has(parts.core) ? namedNames.get(parts.core) === market
      : home.get(issuer).country === entry.countryCode;
    if (!atHome && !exact) continue;
    const rank = exact ? 0 : nameMatch(parts, typed) === 'name' ? 1 : PREFERRED.has(entry.issueType) ? 4 : 3;
    const known = offered.get(namedAs.get(entry.symbolName) ?? entry.symbolName);
    if (known) {
      known.rank = Math.min(known.rank, rank);
      known.type = entry.issueType || known.type;
    } else {
      offered.set(entry.symbolName, { symbol: entry.symbolName, name: entry.companyName || entry.symbolName, type: entry.issueType || null, exchange: entry.exchangeName || null, rank });
    }
  }
  const shown = [...offered.values()].sort((a, b) => a.rank - b.rank).slice(0, SEARCH_SHOWN).map(({ rank, ...result }) => result);
  // Without the lookup, what was found by name is offered but not kept.
  if (lookup.err) return { value: shown, at: Date.now(), error: lookup.err.message };
  searches.delete(key);
  searches.set(key, { at: Date.now(), results: shown });
  if (searches.size > SEARCH_KEPT) searches.delete(searches.keys().next().value);
  return { value: shown, at: Date.now(), error: null };
}

// A share opened from the search box has the same panel as an index's
// constituent, with its quote and key figures fetched on their own. Any symbol
// the quote feed prices will do.
const SHARE_SYMBOL = /^[^\s|,]{1,24}$/;
const shareQuote = keyed(CONSTITUENT_TTL_MS, async (symbol) => {
  const quote = (await fetchQuotes([symbol], true))[symbol];
  if (!quote) throw new Error(`the quote feed has no price for ${symbol}`);
  return quote;
});

async function quoteOfShare(symbol) {
  if (!SHARE_SYMBOL.test(symbol ?? '')) throw new Error('that is not a symbol');
  return shareQuote(symbol, symbol);
}

async function getShare(symbol) {
  const priced = await quoteOfShare(symbol);
  const quote = priced.value;
  const filings = await edgar.financials({ ticker: symbol, names: [quote.fullName].filter(Boolean), us: !/-[A-Z]{2}$/.test(symbol) });
  const share = { symbol, ticker: symbol, name: quote.fullName || symbol, quote, ...await withEarnings(symbol, quote, filings) };
  return { value: share, at: priced.at, error: priced.error };
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

// Prices are adjusted for stock splits (only for splits: not for dividends);
// `basis` 'unadjusted' gives them as they traded.
async function loadBarsBetween(symbol, interval, start, end, basis = 'adjusted') {
  const url = `${BARS_URL}/${encodeURIComponent(symbol)}/${interval}/${stamp(new Date(start))}/${stamp(new Date(end))}/${basis}/GMT.json`;
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

// Runs `load` for every symbol, a few at a time. Symbols that fail get one
// more try; if any still fail the result names them, so it is not mistaken for
// the full picture. Given an earlier result that was incomplete (`known`),
// only the symbols it lacks are asked for.
async function forEachSymbol(load, symbols = SYMBOLS, concurrency = SPARK_CONCURRENCY, known = null) {
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
  const failed = await run(await run(known?.[INCOMPLETE] ?? symbols));
  if (!known && symbols.length && failed.length === symbols.length) throw new Error('chart feed unavailable');
  return failed.length ? markIncomplete(results, failed, symbols.length) : results;
}

const dailyHistory = steady(() => HISTORY.day.get());

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
    const result = await standIn(loaded.outage ? markIncomplete({}, [...SYMBOLS], SYMBOLS.length) : loaded, source, charted);
    if (loaded.outage && !Object.keys(result).length) throw loaded.outage;
    return result;
  });
}

// Where the feed has had no history for a Treasury yield for half a day,
// FRED's official series stands in (see fred.js). It has daily and weekly
// closes but nothing within the day, so the hourly history goes without.
// The bars are marked with their source, for the page to say so.
const fredSeries = keyed(FRED_TTL_MS, (id) => loadFredSeries(id));

async function standIn(loaded, source, charted) {
  if (source === HISTORY.hour) return loaded;
  for (const symbol of loaded[INCOMPLETE] ?? []) {
    const id = FRED_SERIES.get(symbol);
    if (!id || Date.now() - (charted.get(symbol) ?? 0) < BACKUP_AFTER_MS) continue;
    const daily = await fredSeries(id, id).then((series) => series.value, () => null);
    if (!daily) continue;
    const bars = source === HISTORY.week ? weeklyBars(daily) : withYesterday(daily.filter((bar) => bar[0] >= Date.now() - source.daysBack * DAY_MS), lastQuotes[symbol]);
    loaded[symbol] = Object.assign(bars, { source: 'FRED' });
  }
  return loaded;
}

// FRED publishes a day's yield the following afternoon, so through most of a
// session its last close is from two sessions ago, and five sessions back
// would be counted one too far. The close the quote's own change is measured
// from is the missing day's, so it is added. (After a market holiday this adds
// a day that did not trade: the five days then start one session late.)
function withYesterday(daily, quote) {
  if (!daily.length || !quote?.date || quote.prevClose == null || awaitingOpen(quote)) return daily;
  const before = new Date(`${quote.date}T04:00:00Z`);
  do before.setUTCDate(before.getUTCDate() - 1); while (before.getUTCDay() % 6 === 0);
  if (barDate(daily.at(-1)) >= barDate([before.getTime()])) return daily;
  return [...daily, [before.getTime(), quote.prevClose, quote.prevClose, quote.prevClose]];
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

// One instrument's line over a period, and the close the period's change is
// measured from (`from`, null when the history does not reach back that far).
// `charted` holds the bars of the size the period is drawn in.
function lineFor(spec, session, daily, weekly, charted) {
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

// The same for one company, for the chart in its panel: its line over a
// period and the close that period is measured from. Fetched when the chart is
// asked for and kept as long as the intraday lines.
const chartOf = keyed(SPARK_TTL_MS, async (symbol, range, latestQuote) => {
  const spec = RANGES[range];
  if (!spec) return { spark: await intraday(symbol), from: null };
  // The quote is looked up on every load: the session it belongs to moves on
  // from day to day, and the period is counted back from it.
  const quote = await latestQuote();
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

// From an index's panel only its own constituents are charted; any other
// share must be one the quote feed prices.
async function getChart(indexSymbol, symbol, range) {
  const latestQuote = indexSymbol ? async () => (await constituent(indexSymbol, symbol)).quote : async () => (await quoteOfShare(symbol)).value;
  await latestQuote();
  const period = RANGES[range] ? range : '1d';
  return chartOf(`${indexSymbol ?? ''}|${symbol}|${period}`, symbol, period, latestQuote);
}

// ---- the earnings behind the P/E line ---------------------------------------------

// How many of today's shares one share was, week by week: the feed's prices as
// they traded over its split-adjusted ones. That changes only at a split, so
// it is kept as the weeks it changes in, [time, factor]: for NVIDIA 40 up to
// its split of July 2021, 10 up to June 2024, then 1.
const SPLIT_YEARS = 13; // as far back as the earnings kept (see edgar.js), and a year more
const splitsOf = keyed(HISTORY.week.ttlMs, async (symbol) => {
  const end = Date.now() + DAY_MS;
  const start = end - SPLIT_YEARS * 366 * DAY_MS;
  const [adjusted, traded] = await Promise.all([loadBarsBetween(symbol, '1W', start, end), loadBarsBetween(symbol, '1W', start, end, 'unadjusted')]);
  const tradedAt = new Map(traded.map(([t, close]) => [t, close]));
  const steps = [];
  for (const [t, close] of adjusted) {
    const factor = tradedAt.get(t) / close;
    if (Number.isFinite(factor) && (!steps.length || Math.abs(factor / steps.at(-1)[1] - 1) > 0.01)) steps.push([t, factor]);
  }
  if (!steps.length) throw new Error('the price history to find its stock splits in is not loading');
  return steps;
});

// The factor on a date: that of the last week begun by then.
const factorOn = (steps) => (date) => {
  const t = Date.parse(date);
  let factor = steps[0][1];
  for (const [at, value] of steps) {
    if (at > t) break;
    factor = value;
  }
  return factor;
};

// A company's statements for its panel, the trailing earnings per share its
// P/E line is drawn from, and its valuation measures. The filings behind
// those stay here.
async function withEarnings(symbol, quote, { eps, valuation: basis, ...filings }) {
  const earnings = earningsOf(symbol, quote, filings, eps);
  const valuation = valuationOf(symbol, quote, filings, basis, earnings);
  return { filings, earnings: await earnings, valuation: await valuation };
}

// Daily closes back to the earliest period valued, for the price at each
// period's end.
const closesSince = keyed(HISTORY.day.ttlMs, async (symbol, since) => {
  const bars = await loadBarsBetween(symbol, '1D', since, Date.now() + DAY_MS);
  // An empty answer is the feed struggling (see the history loaders).
  if (!bars.length) throw new Error('no price history just now');
  return bars;
});

// Yahoo's valuation measures, today's and at the end of each recent period
// (see valuation.js). Figures filed in another currency than the price are
// not set against it: then there are only the quote feed's own, for today.
async function valuationOf(symbol, quote, filings, basis, earnings) {
  if (filings.status !== 'ok' || !basis?.periods.length || (quote.currency && quote.currency !== filings.currency)) return valuationMeasures({ quote });
  const since = Date.parse(basis.periods.at(-1).end) - 10 * DAY_MS;
  const [closes, steps, { status, trailing }] = await Promise.all([
    closesSince(`${symbol}|${since}`, symbol, since).then((loaded) => loaded.value, () => null),
    splitsOf(symbol, symbol).then((loaded) => loaded.value, () => null),
    earnings.catch(() => ({})),
  ]);
  return valuationMeasures({ quote, basis, trailing: status === 'ok' ? trailing : null, closes, splitFactor: steps && factorOn(steps) });
}

// The twelve months' earnings per share as each report made them known, in
// today's shares (see trailingEarnings in edgar.js), or why there are none.
async function earningsOf(symbol, quote, filings, eps) {
  if (filings.status !== 'ok' || !eps?.length) return { status: 'none' };
  // A price in one currency is not divided by earnings in another: a US
  // company's listing abroad, or a company abroad that reports at home.
  if (quote.currency && quote.currency !== filings.currency) return { status: 'currency', reported: filings.currency, quoted: quote.currency };
  let steps;
  try {
    steps = (await splitsOf(symbol, symbol)).value;
  } catch (err) {
    return { status: 'error', message: err.message || String(err) };
  }
  const trailing = trailingEarnings(eps, factorOn(steps));
  if (!trailing.length) return { status: 'none' };
  // A company abroad files its earnings per ordinary share, and the depositary
  // share quoted in New York may stand for several (two for Shell, six for
  // BP), which no filing states. Where the feed's own P/E is far from this
  // one, that is taken to be the case and the line is left out.
  const pe = quote.last / trailing.at(-1).eps;
  const feeds = quote.stats?.pe;
  if (/^(20|40)-F/.test(filings.latest?.form ?? '') && feeds > 0 && pe > 0 && Math.abs(Math.log(pe / feeds)) > Math.log(1.5)) return { status: 'shares', pe, feeds };
  return { status: 'ok', currency: filings.currency, trailing };
}

// ---- markets that never close -------------------------------------------------

// Crypto is priced round the clock, so its periods are spans of the clock and
// not counted from a close (see rolling.js): the last 24 hours, the last 120,
// the same time of day so many months back. `read` is where the price at that
// moment comes from: ten-minute bars reach a week back, hourly ones about
// three months, and beyond that there are only daily closes to place it between.
// The rows measured this way are `ROLLING`, at the top.
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
const getIntraday = cached(SPARK_TTL_MS, (known) => forEachSymbol(loadSpark, SYMBOLS, SPARK_CONCURRENCY, known));
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

// ---- editing the layout -------------------------------------------------------

// Rows are added, removed and pinned as tiles from the page, but only from
// this computer: on a hosted copy visitors can look and not edit. A change
// must also come from the dashboard's own page and not from another site open
// in the same browser: so it has to be sent as JSON (which another site cannot
// do without this server's leave), any origin it names must be this server,
// and it must be addressed to a local name (a site whose own name is made to
// lead here is turned away).
const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const hostname = (host) => { try { return new URL(`http://${host}`).hostname; } catch { return null; } };

const mayEdit = (req) => LOCAL_ADDRESSES.has(req.socket.remoteAddress) && LOCAL_NAMES.has(hostname(req.headers.host));

const sentFromPage = (req) => mayEdit(req)
  && /^application\/json\b/.test(req.headers['content-type'] ?? '')
  && (!req.headers.origin || req.headers.origin === `http://${req.headers.host}`);

const configFor = (req) => ({ ...LAYOUT.current(), markets: MARKETS, editable: mayEdit(req), version: layoutVersion });

function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) req.destroy(new Refusal('That request is too large.'));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      // A body of `null` is JSON too, and changes nothing.
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') ?? {}); } catch { reject(new Refusal('That request is not JSON.')); }
    });
    req.on('error', reject);
  });
}

const text = (value, max) => (typeof value === 'string' && value.trim().slice(0, max)) || undefined;
const SYMBOL_FORM = /^[A-Z0-9.@=^_-]{1,24}$/;

// The feed's name for an instrument, made to fit a row: "Orange Juice
// (Nov'26)" becomes "Orange Juice", "IBEX 35 Idx" "IBEX 35", and
// "Dogecoin/USD Coin Metrics" "Dogecoin".
const shortName = (fullName) => fullName
  ?.replace(/\s*\([A-Z][a-z]{2}'\d{2}\)$/, '')
  .replace(/\/USD-? Coin Metrics$/, '')
  .replace(/ (Index|Idx|FX Spot Rate|FX Cross Rate)$/i, '')
  .trim() || null;

// Fetches what a row needs that the caches lack: its quote, its lines and
// the closes its changes are measured from. The page waits for this a few
// seconds at most, so that a new row arrives filled in; whatever is slower
// fills in on the page's next refresh.
const FILL_PATIENCE_MS = 8_000;

function fillRows(symbols) {
  const rolling = symbols.filter((symbol) => ROLLING.includes(symbol));
  const sources = [
    [symbols, [getQuotes, getIntraday, ...Object.values(HISTORY).map((source) => source.get)]],
    [rolling, [getMinutes, getHoursBack, getYearsBack]],
  ];
  const filled = Promise.all(sources.flatMap(([list, gets]) => (list.length ? gets.map((get) => get.include(list).catch(() => {})) : [])));
  return Promise.race([filled, new Promise((resolve) => setTimeout(resolve, FILL_PATIENCE_MS))]);
}

const EDITS = {
  // { group, symbol, name?, note?, unit? }: the symbol is checked against the
  // quote feed first, so a mistyped one is not saved. Without a name the
  // feed's own is used.
  async add(body) {
    const symbol = text(body.symbol, 24)?.toUpperCase();
    if (!symbol || !SYMBOL_FORM.test(symbol)) throw new Refusal('That is not a symbol the quote feed uses.');
    let quote;
    try {
      quote = (await fetchQuotes([symbol]))[symbol];
    } catch (err) {
      throw Object.assign(new Error(`The quote feed could not be reached to check ${symbol} (${err.message}).`), { status: 502 });
    }
    if (!quote) throw new Refusal(`The quote feed has no price for ${symbol}.`);
    const item = { symbol, name: text(body.name, 40) ?? shortName(quote.fullName) ?? symbol, note: text(body.note, 60), unit: text(body.unit, 20), added: true };
    // A coin priced by Coin Metrics trades round the clock and is measured like the others.
    if (symbol.endsWith('.CM=')) item.rolling = true;
    await LAYOUT.add(text(body.group, 200), item);
    applyLayout();
    await fillRows([symbol]);
  },
  // { symbol }
  async remove(body) {
    await LAYOUT.remove(text(body.symbol, 24));
    applyLayout();
  },
  // { symbol, pinned }: shows a row as a tile at the top, or stops.
  async tile(body) {
    await LAYOUT.pin(text(body.symbol, 24), body.pinned === true);
    applyLayout();
  },
  // Back to instruments.js as it is.
  async reset() {
    await LAYOUT.reset();
    applyLayout();
    await fillRows(SYMBOLS);
  },
};

async function edit(req, res, action) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Changes are sent with POST.' });
  if (!sentFromPage(req)) return sendJson(res, 403, { error: 'The layout can only be changed from the dashboard on the computer running it.' });
  try {
    await action(await readJson(req));
    sendJson(res, 200, { config: configFor(req) });
  } catch (err) {
    sendJson(res, err instanceof Refusal ? 400 : err.status ?? 500, { error: err.message });
  }
}

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
    // An address that cannot be read (a stray "%" in it, say) is turned away:
    // left to throw, it would stop the server.
    let url;
    let file;
    try {
      url = new URL(req.url, 'http://localhost');
      file = decodeURIComponent(url.pathname);
    } catch {
      return sendJson(res, 400, { error: 'That address cannot be read.' });
    }
    const { pathname, searchParams } = url;
    if (pathname === '/api/config') return sendJson(res, 200, configFor(req));
    // Each refresh says which layout it belongs to, so a page open while the
    // layout was changed elsewhere (the Mac app and a browser) catches up.
    if (pathname === '/api/quotes') return sendData(res, 'quotes', async () => ({ ...(await getQuotes()), layout: layoutVersion }));
    if (pathname.startsWith('/api/layout/') && Object.hasOwn(EDITS, pathname.slice(12))) return edit(req, res, EDITS[pathname.slice(12)]);
    if (pathname === '/api/index') return sendData(res, 'detail', () => getIndexDetail(searchParams.get('symbol'), searchParams.get('range')));
    if (pathname === '/api/company') return sendData(res, 'company', () => getCompany(searchParams.get('index'), searchParams.get('symbol')));
    if (pathname === '/api/chart') return sendData(res, 'chart', () => getChart(searchParams.get('index'), searchParams.get('symbol'), searchParams.get('range')));
    if (pathname === '/api/bases') return sendData(res, 'bases', loadBases);
    if (pathname === '/api/sparks') return sendData(res, 'sparks', () => getSparks(searchParams.get('range')));
    if (pathname === '/api/search') return sendData(res, 'results', () => search(searchParams.get('q')));
    return sendStatic(res, file);
  })
  .listen(PORT, HOST, () => {
    console.log(`Global Dashboard running at http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}`);
    warmUp();
  });
