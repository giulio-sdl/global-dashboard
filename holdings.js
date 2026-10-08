// Index constituents and their weights. No free feed publishes index weights
// directly, so they are read from the daily holdings file of an iShares ETF
// that tracks the index (fund weights match index weights to within cash drag).

const HOLDINGS_URL = (fundId) =>
  `https://www.ishares.com/ch/individual/en/products/${fundId}/fund/1495092304805.ajax?fileType=csv&fileName=holdings&dataType=fund`;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// The quote feed names non-US listings TICKER-CC. US listings carry no suffix.
const EXCHANGE_SUFFIX = {
  'New York Stock Exchange Inc.': '',
  NASDAQ: '',
  'Cboe BZX': '',
  'Nyse Mkt Llc': '',
  'London Stock Exchange': '-GB',
  Xetra: '-DE',
  'Deutsche Boerse Xetra': '-DE',
  'Boerse Berlin': '-DE',
  'Nyse Euronext - Euronext Paris': '-FR',
  'Euronext Amsterdam': '-NL',
  'Nyse Euronext - Euronext Brussels': '-BE',
  'Nyse Euronext - Euronext Lisbon': '-PT',
  'Borsa Italiana': '-IT',
  'Bolsa De Madrid': '-ES',
  'SIX Swiss Exchange': '-CH',
  'Nasdaq Omx Nordic': '-SE',
  'Nasdaq Omx Helsinki Ltd.': '-FI',
  'Omx Nordic Exchange Copenhagen A/S': '-DK',
  'Oslo Bors Asa': '-NO',
  'Wiener Boerse Ag': '-AT',
  'Irish Stock Exchange - All Market': '-IE',
  'Warsaw Stock Exchange/Equities/Main Market': '-PL',
  'Athens Exchange S.A. Cash Market': '-GR',
  'Tokyo Stock Exchange': '.T-JP',
};
// Used when the file leaves the exchange blank (mostly London investment trusts).
const CURRENCY_SUFFIX = { USD: '', GBP: '-GB', CHF: '-CH', SEK: '-SE', NOK: '-NO', DKK: '-DK', PLN: '-PL', JPY: '.T-JP' };
const COUNTRY_SUFFIX = { Netherlands: '-NL', Germany: '-DE', France: '-FR', Italy: '-IT', Spain: '-ES', Belgium: '-BE', Finland: '-FI', Ireland: '-IE', Austria: '-AT', Portugal: '-PT' };

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// The symbols a holding might be quoted under, most likely first.
function quoteSymbols({ ticker, exchange, currency, location }) {
  const suffix = EXCHANGE_SUFFIX[exchange] ?? CURRENCY_SUFFIX[currency];
  if (suffix == null) return [];
  const parts = ticker.split(/\s+/);
  // Share classes are written "VOLV B" in the file and VOLV.B or NDAFI in the feed.
  const forms = [parts.join('.'), parts.join('')];
  // SIX registered shares: the feed keeps NESN as is but writes LOGN as LOG.N.
  if (suffix === '-CH' && /^[A-Z]{3,}N$/.test(ticker)) forms.push(`${ticker.slice(0, -1)}.N`);
  const symbols = forms.map((form) => form + suffix);
  // A company listed away from home (DSM-Firmenich on SIX) may only be quoted on its home exchange.
  const home = COUNTRY_SUFFIX[location];
  if (home && home !== suffix) symbols.push(parts.join('.') + home);
  return [...new Set(symbols)];
}

const titleCase = (text) => text.toLowerCase().replace(/(^|[\s\-.&/(])([a-z])/g, (_, lead, letter) => lead + letter.toUpperCase());

export async function loadHoldings(fundId) {
  const res = await fetch(HOLDINGS_URL(fundId), { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`holdings file responded ${res.status}`);
  const rows = parseCsv((await res.text()).replace(/^﻿/, ''));
  const head = rows.findIndex((row) => row[0] === 'Ticker');
  if (head < 0) throw new Error('holdings file has an unexpected format');
  const col = Object.fromEntries(rows[head].map((name, i) => [name, i]));

  const items = rows
    .slice(head + 1)
    .filter((row) => row[col['Asset Class']] === 'Equity')
    .map((row) => {
      const holding = {
        ticker: row[col.Ticker].trim(),
        name: titleCase(row[col.Name].trim()),
        sector: row[col.Sector] || 'Other',
        weight: Number(row[col['Weight (%)']]),
        exchange: row[col.Exchange],
        currency: row[col['Market Currency']],
        location: row[col.Location],
      };
      return { ...holding, symbols: quoteSymbols(holding) };
    })
    .filter((holding) => holding.weight > 0)
    .sort((a, b) => b.weight - a.weight);
  if (!items.length) throw new Error('holdings file lists no equities');

  // First line reads: Fund Holdings as of,"29/Sept/2026"
  const asOf = rows[0]?.[1]?.replaceAll('/', ' ') || null;
  return { asOf, items };
}
