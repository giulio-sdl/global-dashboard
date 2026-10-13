// Checks a running dashboard against its sources, row by row. It is not part
// of `npm test`: it needs the network and the server, and what it reads moves
// while it runs.
//
//   node scripts/live-check.js                          the dashboard on localhost:5177 (or PORT)
//   node scripts/live-check.js http://localhost:5199    one at another address
//
// Three checks, each worked out here from the raw feed and not with the
// server's own code:
//   1. every row's price and 1-day change, against the quote feed asked at the same moment
//   2. every row's 5-day reference close, against the feed's daily bars
//   3. the round-the-clock rows' changes, against the feed's bars and against CoinGecko
// It takes a minute or two, and exits with 1 if anything is out.

const APP = (process.argv[2] || `http://localhost:${process.env.PORT || 5177}`).replace(/\/$/, '');
const QUOTE_URL = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol';
const BARS_URL = 'https://ts-api.cnbc.com/harmony/app/bars';
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/coins/markets';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const COINGECKO_ID = { 'BTC.CM=': 'bitcoin', 'ETH.CM=': 'ethereum', 'XRP=': 'ripple', 'BNB.CM=': 'binancecoin', 'SOL.CM=': 'solana', 'TRX=': 'tron', 'SUI=': 'sui' };

const MINUTE_MS = 60_000;
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
const QUOTE_CACHE_MS = 10_000; // how long the server keeps its quotes
const CONCURRENCY = 8;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = async (url, options) => (await fetch(url, { signal: AbortSignal.timeout(60_000), ...options })).json();
const app = (path) => json(`${APP}${path}`);
const feed = (url) => json(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });

// The feed's figures as numbers: "7,765.36", "-0.47%" and "UNCH".
function num(text) {
  if (text == null) return null;
  const t = String(text).replace(/[,%+]/g, '').trim();
  if (/^unch$/i.test(t)) return 0;
  const n = Number(t);
  return Number.isFinite(n) && t !== '' ? n : null;
}

const stamp = (ms) => new Date(ms).toISOString().replace(/\D/g, '').slice(0, 14);

// A symbol's bars straight from the feed, as { t, date, close }. When the feed
// is struggling it answers with nothing, and repeats that answer to the same
// request, so it is asked again with the end of the window moved a second on.
async function rawBars(symbol, interval, from, to) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const data = await feed(`${BARS_URL}/${encodeURIComponent(symbol)}/${interval}/${stamp(from)}/${stamp(to + attempt * 1000)}/adjusted/GMT.json`);
      const bars = (data?.barData?.priceBars ?? [])
        .map((b) => ({ t: Number(b.tradeTimeinMills), date: `${b.tradeTime.slice(0, 4)}-${b.tradeTime.slice(4, 6)}-${b.tradeTime.slice(6, 8)}`, close: Number(b.close) }))
        .filter((b) => b.close > 0);
      if (bars.length) return bars;
    } catch { /* asked again */ }
    await wait(1500);
  }
  return [];
}

// Daily bars for the last ten weeks. The feed's daily history has gaps that
// differ from one request to the next (a recent close missing, most often), so
// it is asked three times and the answers are put together.
async function dailyBars(symbol, now) {
  const byDate = new Map();
  for (const later of [0, 20_000, 40_000]) {
    for (const bar of await rawBars(symbol, '1D', Math.floor((now - 70 * DAY_MS) / HOUR_MS) * HOUR_MS, now + DAY_MS + later)) byDate.set(bar.date, bar);
  }
  return [...byDate.values()].sort((a, b) => a.t - b.t);
}

// `work` for every item, a few at a time; the results by the item's symbol.
async function forEach(items, work) {
  const results = {};
  const queue = [...items];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let item; (item = queue.shift()); ) results[item.symbol] = await work(item);
  }));
  return results;
}

const pct = (now, then) => (now == null || then == null ? null : (now / then - 1) * 100);
const signed = (value) => (value == null ? 'n/a' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`).padStart(9);
const heading = (text) => console.log(`\n${text}\n${'-'.repeat(text.length)}`);

// ---- 1. prices and 1-day changes ---------------------------------------------

async function checkRows(rows) {
  heading('1. Price and 1-day change of every row, against the quote feed');
  const symbols = [...new Set(rows.map((row) => row.symbol))];
  // Ask once and wait out the server's quote cache, so that its next answer
  // is fetched at the same moment as the raw one.
  await app('/api/quotes');
  await wait(QUOTE_CACHE_MS + 1000);
  const batches = [];
  for (let i = 0; i < symbols.length; i += 45) batches.push(symbols.slice(i, i + 45));
  const [{ quotes, error, incomplete }, ...answers] = await Promise.all([
    app('/api/quotes'),
    ...batches.map((batch) => feed(`${QUOTE_URL}?${new URLSearchParams({ symbols: batch.join('|'), requestMethod: 'itv', noform: '1', partnerId: '2', fund: '1', exthrs: '1', output: 'json', events: '1' })}`)),
  ]);
  const raw = Object.fromEntries(answers.flatMap((data) => [].concat(data?.FormattedQuoteResult?.FormattedQuote ?? [])).map((q) => [q.symbol, q]));

  let matching = 0;
  const cleared = [];
  const derived = [];
  const rolling = [];
  const problems = [];
  for (const row of rows) {
    const theirs = raw[row.symbol];
    const ours = quotes[row.symbol];
    if (!theirs || theirs.code !== 0 || !ours) { problems.push(`${row.symbol}: missing from the ${!theirs || theirs.code !== 0 ? 'feed' : 'dashboard'}`); continue; }
    const last = num(theirs.last);
    const change = num(theirs.change) ?? 0;
    const stated = num(theirs.change_pct);
    // Prices move in the moment between the two answers, and some are delayed.
    if (Math.abs(ours.last / last - 1) > 0.004) { problems.push(`${row.symbol}: last ${ours.last} against the feed's ${last}`); continue; }
    // A round-the-clock row is measured over 24 hours, not from the feed's previous close: see check 3.
    if (ours.rolling) { rolling.push(row.symbol); continue; }
    // Ahead of the open the feed clears the day's figures, and the dashboard shows the last session instead.
    const wasCleared = change === 0 && !(num(theirs.high) > 0) && !(num(theirs.low) > 0);
    if (wasCleared && ours.change !== 0) { cleared.push(row.symbol); continue; }
    const implied = last - change ? (change / (last - change)) * 100 : null;
    const out = row.yields ? Math.abs(ours.change - change) > 0.012 : Math.abs(ours.changePct - (stated ?? implied)) > 0.02;
    if (!out) { matching++; continue; }
    // Where the feed rounds its own percentage too coarsely, the one its price and change imply is shown.
    if (!row.yields && implied != null && Math.abs(ours.changePct - implied) < 0.02) derived.push(`${row.symbol} (feed ${theirs.change_pct}, shown ${ours.changePct.toFixed(2)}%)`);
    else problems.push(`${row.symbol}: 1-day ${row.yields ? ours.change : ours.changePct?.toFixed(3)} against the feed's ${row.yields ? change : stated}`);
  }
  console.log(`quotes served: ${Object.keys(quotes).length}, error: ${error}, incomplete: ${incomplete}`);
  console.log(`${rows.length} rows: ${matching} match the feed's price and 1-day change`);
  console.log(`${rolling.length} measured round the clock, price matches (changes in check 3): ${rolling.join(' ')}`);
  console.log(`${cleared.length} cleared by the feed ahead of the open, shown with their last session instead: ${cleared.join(' ')}`);
  console.log(`${derived.length} shown with the percentage derived from price and change: ${derived.join(', ')}`);
  return problems;
}

// ---- 2. the 5-day reference --------------------------------------------------

// Is each row's 5-day reference the close it should be? Judged from the raw
// feed alone: the quote's previous close is looked for among the latest daily
// bars, and five sessions are counted back from there. Where it is not among
// them, or more than one bar carries it, the dates decide.
async function checkReferences(rows) {
  heading('2. The close each 5-day change is measured from, against the feed\'s daily bars');
  let served = await app('/api/bases');
  for (let i = 0; i < 12 && (served.incomplete || !Object.keys(served.bases?.['1w'] ?? {}).length); i++) {
    await wait(5000);
    served = await app('/api/bases');
  }
  const { quotes } = await app('/api/quotes');
  const now = Date.now();
  const unique = [...new Map(rows.map((row) => [row.symbol, row])).values()];
  // Round-the-clock rows are measured from a price 120 hours ago (check 3); a
  // row whose history is FRED's for now has nothing to compare in the feed.
  const closeBased = unique.filter((row) => !quotes[row.symbol]?.rolling && !served.backup?.[row.symbol]);
  const bars = await forEach(closeBased, (row) => dailyBars(row.chart || row.symbol, now));

  let byClose = 0;
  let byDate = 0;
  const problems = [];
  const differs = [];
  for (const { symbol } of closeBased) {
    const q = quotes[symbol];
    const history = bars[symbol];
    if (!q || history.length < 8) { problems.push(`${symbol}: no ${q ? 'daily bars from the feed' : 'quote'}`); continue; }
    const base = served.bases['1w'][symbol];
    const used = history.findLast((bar) => Math.abs(bar.close - base) < 1e-9)?.date;
    const tolerance = 0.75 * 10 ** -q.dp;
    const carrying = history.map((bar, i) => [bar, i]).slice(-3).filter(([bar]) => Math.abs(bar.close - q.prevClose) <= tolerance);
    if (carrying.length === 1) {
      const [found, index] = carrying[0];
      const want = history[index - 4];
      if (want && Math.abs(want.close - base) < 1e-9) byClose++;
      else problems.push(`${symbol.padEnd(9)} quote ${q.date} previous close ${Number(q.prevClose.toFixed(4))} = bar ${found.date}; 5 days should start ${want?.date} (${want?.close}) but the dashboard uses ${base} (${used})`);
    } else {
      const session = q.date > history.at(-1).date ? q.date : history.at(-1).date;
      const want = history.filter((bar) => bar.date < session).at(-5);
      if (want && Math.abs(want.close - base) < 1e-9) byDate++;
      else differs.push(`${symbol.padEnd(9)} quote ${q.date} previous close ${Number(q.prevClose.toFixed(4))} (${carrying.length} bars carry it); by date 5 days should start ${want?.date} (${want?.close}); the dashboard uses ${base} (${used}); bars ${history.slice(-3).map((bar) => `${bar.date.slice(5)}=${bar.close}`).join(' ')}`);
    }
  }
  const onFred = unique.filter((row) => served.backup?.[row.symbol]).map((row) => row.symbol);
  console.log(`${closeBased.length} rows: ${byClose} confirmed by the quote's previous close, ${byDate} by date (the previous close is not among the bars)`);
  if (onFred.length) console.log(`${onFred.length} not checked, their history being FRED's for now: ${onFred.join(' ')}`);
  // Not counted as wrong: without the previous close to go by, this reading is no surer than the server's.
  if (differs.length) console.log(`differs from the date rule, to look at:\n${differs.join('\n')}`);
  // The usual cause, and a known weak spot (see the README): it puts five days one session out.
  if (problems.length) console.log('out (below): often a close the server\'s daily history lacked when it was last loaded; it is loaded again every hour');
  return problems;
}

// ---- 3. round-the-clock rows -------------------------------------------------

// The moment so many months before `now`: the same day of the month (its last
// day, where the month is shorter) at the same time of day.
function monthsBack(now, months) {
  const at = new Date(now);
  const then = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - months, 1, at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds()));
  const lastDay = new Date(Date.UTC(then.getUTCFullYear(), then.getUTCMonth() + 1, 0)).getUTCDate();
  then.setUTCDate(Math.min(at.getUTCDate(), lastDay));
  return then.getTime();
}

// The close of the last bar that had ended by a moment.
const endedBy = (bars, barMs, moment) => bars.filter((bar) => bar.t + barMs <= moment).at(-1)?.close ?? null;

// A daily bar closes at 4 p.m. New York, 16 hours after its stamp: the price
// at a moment is placed between the closes either side of it.
function betweenCloses(days, moment) {
  const before = days.filter((bar) => bar.t + 16 * HOUR_MS <= moment).at(-1);
  const after = days.find((bar) => bar.t + 16 * HOUR_MS > moment);
  if (before && after) return before.close + (after.close - before.close) * ((moment - before.t - 16 * HOUR_MS) / (after.t - before.t));
  return (before ?? after)?.close ?? null;
}

async function checkRolling(rows) {
  heading('3. Round-the-clock rows, against an independent reading of the feed');
  const items = rows.filter((row) => row.rolling);
  // Wait for the server to have what these rows are measured from.
  let quotes;
  let served;
  for (let i = 0; i < 40; i++) {
    quotes = (await app('/api/quotes')).quotes;
    served = await app('/api/bases');
    if (items.every((item) => quotes[item.symbol]?.rolling) && !served.incomplete) break;
    await wait(4000);
  }
  const now = Date.now();
  const problems = rows.filter((row) => !row.rolling && quotes[row.symbol]?.rolling).map((row) => `${row.symbol} should not be measured round the clock`);
  let worst = 0;
  console.log('row             last          24h: shown / own    5d: shown / own     1m: shown / own     3m: shown / own     1y: shown / own');
  for (const item of items) {
    const q = quotes[item.symbol];
    if (!q?.rolling) { problems.push(`${item.symbol}: not measured round the clock`); continue; }
    const charted = item.chart || item.symbol;
    const minutes = await rawBars(charted, '10M', Math.floor((now - 6 * DAY_MS) / HOUR_MS) * HOUR_MS, now + DAY_MS);
    if (!minutes.length) { problems.push(`${item.symbol}: no ten-minute bars from the feed`); continue; }
    // A row charted under another symbol than it is quoted under: the two
    // series sit a little apart, and the charted one is brought to the quote's level.
    const scale = charted === item.symbol ? 1 : q.last / minutes.at(-1).close;
    const own = { '1d': endedBy(minutes, 10 * MINUTE_MS, now - DAY_MS), '1w': endedBy(minutes, 10 * MINUTE_MS, now - 5 * DAY_MS) };
    for (const [range, months] of [['1m', 1], ['3m', 3]]) {
      const moment = monthsBack(now, months);
      own[range] = endedBy(await rawBars(charted, '1H', Math.floor((moment - 2 * DAY_MS) / HOUR_MS) * HOUR_MS, moment + DAY_MS), HOUR_MS, moment);
    }
    const yearAgo = monthsBack(now, 12);
    own['1y'] = betweenCloses(await rawBars(charted, '1D', yearAgo - 3 * DAY_MS, yearAgo + 3 * DAY_MS), yearAgo);

    const cells = ['1d', '1w', '1m', '3m', '1y'].map((range) => {
      const shown = range === '1d' ? q.changePct : pct(q.last, served.bases[range]?.[item.symbol]);
      const mine = pct(q.last, own[range] == null ? null : own[range] * scale);
      if (shown != null && mine != null) {
        const gap = Math.abs(shown - mine);
        worst = Math.max(worst, gap);
        if (gap > (charted === item.symbol ? 0.15 : 0.6)) problems.push(`${item.symbol} ${range}: the dashboard's ${shown.toFixed(2)} against ${mine.toFixed(2)}`);
      } else if ((shown == null) !== (mine == null)) problems.push(`${item.symbol} ${range}: the dashboard's ${shown} against ${mine}`);
      return `${signed(shown)} /${signed(mine)}`;
    });
    console.log(`${item.name.padEnd(15)} ${String(q.last).padEnd(11)} ${cells.join('  ')}`);
  }
  console.log(`largest gap: ${worst.toFixed(2)} points (a price moves in the seconds between the two readings)`);

  // CoinGecko's own rolling changes. Only its 24 hours are the same span as
  // the dashboard's; 30 days against a calendar month is there to be looked at.
  try {
    const coins = await json(`${COINGECKO_URL}?vs_currency=usd&ids=${Object.values(COINGECKO_ID).join(',')}&price_change_percentage=24h,30d,1y`);
    console.log('\nagainst CoinGecko      24h: shown / theirs     1 month / their 30 days    1 year: shown / theirs');
    for (const [symbol, id] of Object.entries(COINGECKO_ID)) {
      const coin = coins.find((c) => c.id === id);
      const q = quotes[symbol];
      if (!coin || !q) continue;
      const theirs = coin.price_change_percentage_24h_in_currency;
      if (q.rolling && theirs != null && Math.abs(q.changePct - theirs) > 0.6) problems.push(`${symbol} 24h: the dashboard's ${q.changePct.toFixed(2)} against CoinGecko's ${theirs.toFixed(2)}`);
      console.log(`${id.padEnd(22)} ${signed(q.changePct)} /${signed(theirs)}     ${signed(pct(q.last, served.bases['1m']?.[symbol]))} /${signed(coin.price_change_percentage_30d_in_currency)}       ${signed(pct(q.last, served.bases['1y']?.[symbol]))} /${signed(coin.price_change_percentage_1y_in_currency)}`);
    }
  } catch (err) {
    console.log(`\nCoinGecko not reachable (${err.message}): that comparison is left out`);
  }
  return problems;
}

// ---- all three ---------------------------------------------------------------

const config = await app('/api/config').catch(() => null);
if (!config) {
  console.error(`No dashboard answers at ${APP}. Start it with "npm start", or give its address: node scripts/live-check.js http://localhost:5199`);
  process.exit(2);
}
console.log(`Checking the dashboard at ${APP}`);
const rows = config.sections.flatMap((section) => section.cards.flatMap((card) => card.groups.flatMap((group) =>
  group.items.filter((item) => item.symbol).map((item) => ({ ...item, yields: Boolean(group.yields) })))));

const problems = [];
for (const check of [checkRows, checkReferences, checkRolling]) problems.push(...await check(rows));

console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n${problems.join('\n')}` : '\nno problems');
process.exitCode = problems.length ? 1 : 0;
