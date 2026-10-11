// Company financial statements from SEC EDGAR, the filing system of the US
// Securities and Exchange Commission. Every figure a company tags in its
// 10-K, 10-Q, 20-F or 40-F is published as JSON; this reads the ones a
// summary needs and lays them out by year and by quarter.
//
// EDGAR covers companies registered with the SEC: all US-listed ones, and
// foreign ones that file there (Novartis, SAP, Toyota). A company that is not
// registered has no entry, and that is reported rather than guessed around.
//
// The SEC asks every program to name a contact in its requests and to stay
// under ten requests a second. A company's statements change once a quarter,
// so they are fetched when its page is first opened, kept on disk, and
// fetched again only when a new report is due.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const factsUrl = (cik) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`;
const filingsUrl = (cik) => `https://www.sec.gov/edgar/browse/?CIK=${cik}`;

const DAY_MS = 24 * 3600_000;
const TICKERS_TTL_MS = 30 * DAY_MS;
const QUARTER_MS = 91 * DAY_MS;
const RECHECK_MS = 7 * DAY_MS;
const RETRY_MS = 3600_000;
const REQUEST_GAP_MS = 150; // well inside the SEC's ten a second
const YEARS_SHOWN = 5;
const QUARTERS_SHOWN = 6;

// The tags a figure may be filed under, per accounting standard. Companies
// differ, and change tags over the years; the tag with the newest figure
// leads, and the others fill in the periods it lacks.
const OVER_A_PERIOD = {
  revenue: {
    // Total revenues first: for a bank, an insurer or a conglomerate the contract-revenue tags are only part of it.
    'us-gaap': ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet', 'RevenuesNetOfInterestExpense'],
    'ifrs-full': ['Revenue', 'RevenueFromContractsWithCustomers', 'RevenueFromSaleOfGoods', 'RevenueAndOperatingIncome'],
  },
  grossProfit: { 'us-gaap': ['GrossProfit'], 'ifrs-full': ['GrossProfit'] },
  costOfRevenue: { 'us-gaap': ['CostOfRevenue', 'CostOfGoodsAndServicesSold'], 'ifrs-full': ['CostOfSales'] },
  operatingIncome: { 'us-gaap': ['OperatingIncomeLoss'], 'ifrs-full': ['ProfitLossFromOperatingActivities'] },
  netIncome: { 'us-gaap': ['NetIncomeLoss', 'ProfitLoss'], 'ifrs-full': ['ProfitLossAttributableToOwnersOfParent', 'ProfitLoss'] },
  eps: {
    'us-gaap': ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted', 'EarningsPerShareBasic'],
    'ifrs-full': ['DilutedEarningsLossPerShare', 'BasicEarningsLossPerShare'],
  },
  operatingCashFlow: {
    'us-gaap': ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
    'ifrs-full': ['CashFlowsFromUsedInOperatingActivities'],
  },
  capex: {
    'us-gaap': ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
    'ifrs-full': ['PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities'],
  },
};
const AT_A_DATE = {
  cash: {
    'us-gaap': ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'],
    'ifrs-full': ['CashAndCashEquivalents'],
  },
  assets: { 'us-gaap': ['Assets'], 'ifrs-full': ['Assets'] },
  liabilities: { 'us-gaap': ['Liabilities'], 'ifrs-full': ['Liabilities'] },
  equity: {
    'us-gaap': ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
    'ifrs-full': ['EquityAttributableToOwnersOfParent', 'Equity'],
  },
  debt: { 'us-gaap': ['LongTermDebt', 'LongTermDebtNoncurrent'], 'ifrs-full': ['NoncurrentPortionOfNoncurrentBorrowings', 'Borrowings'] },
};

const days = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
const isQuarter = (length) => length >= 80 && length <= 100;
const isYear = (length) => length >= 350 && length <= 380;

// ---- reading the filed figures ------------------------------------------------

// The standard a company reports under, and the currency it reports in: taken
// from wherever its newest profit figure is.
function reporting(facts) {
  let best = null;
  for (const [standard, tags] of Object.entries(OVER_A_PERIOD.netIncome)) {
    for (const tag of tags) {
      for (const [unit, list] of Object.entries(facts[standard]?.[tag]?.units ?? {})) {
        const newest = list.reduce((max, fact) => (fact.end > max ? fact.end : max), '');
        if (!best || newest > best.newest) best = { standard, currency: unit, newest };
      }
    }
  }
  return best;
}

// One figure's filed values, the newest filing of each period winning. Tags
// are tried newest figure first; a later tag only adds periods the earlier
// ones lack.
function filed(facts, tags, unit) {
  const newest = (list) => list.reduce((max, fact) => (fact.end > max ? fact.end : max), '');
  const lists = tags
    .map((tag) => facts?.[tag]?.units?.[unit] ?? [])
    .filter((list) => list.length)
    .sort((a, b) => (newest(a) < newest(b) ? 1 : newest(a) > newest(b) ? -1 : 0));
  const periods = new Map();
  for (const list of lists) {
    const own = new Map();
    for (const fact of list) {
      const key = `${fact.start ?? ''}|${fact.end}`;
      if (!own.has(key) || fact.filed > own.get(key).filed) own.set(key, fact);
    }
    for (const [key, fact] of own) if (!periods.has(key)) periods.set(key, fact);
  }
  return [...periods.values()];
}

// A figure measured over a period, by fiscal year and by quarter. Companies
// file some quarters only as running totals (cash flow always, the fourth
// quarter of everything): those are worked out by subtraction.
function overPeriods(filedFacts) {
  // A figure over a period has a start; anything without one does not belong here.
  const list = filedFacts.filter((fact) => fact.start);
  const annual = new Map();
  const quarterly = new Map();
  for (const fact of list) {
    const length = days(fact.start, fact.end);
    if (isYear(length)) annual.set(fact.end, fact.val);
    else if (isQuarter(length)) quarterly.set(fact.end, fact.val);
  }
  // Totals running from the same start: each less the one before is a quarter.
  const chains = new Map();
  for (const fact of list) chains.set(fact.start, [...(chains.get(fact.start) ?? []), fact]);
  for (const chain of chains.values()) {
    chain.sort((a, b) => (a.end < b.end ? -1 : 1));
    for (let i = 1; i < chain.length; i++) {
      if (!quarterly.has(chain[i].end) && isQuarter(days(chain[i - 1].end, chain[i].end) - 1)) quarterly.set(chain[i].end, chain[i].val - chain[i - 1].val);
    }
  }
  // A year with three quarters filed and no nine-month total: the fourth is the rest.
  for (const fact of list) {
    if (!isYear(days(fact.start, fact.end)) || quarterly.has(fact.end)) continue;
    const within = [...quarterly].filter(([end]) => end > fact.start && end < fact.end);
    if (within.length === 3) quarterly.set(fact.end, fact.val - within.reduce((sum, [, value]) => sum + value, 0));
  }
  return { annual, quarterly };
}

// A balance-sheet figure on a date; the filing may date it a few days off.
function onDate(list, date) {
  const exact = list.find((fact) => fact.end === date);
  if (exact) return exact.val;
  const near = list.find((fact) => Math.abs(Date.parse(fact.end) - Date.parse(date)) <= 5 * DAY_MS);
  return near ? near.val : null;
}

// The statements laid out for the page: the latest fiscal years and quarters,
// newest first, one row of figures per line item.
export function distill(company) {
  const basis = reporting(company.facts);
  if (!basis) return null;
  const facts = company.facts[basis.standard];
  const perShare = `${basis.currency}/shares`;

  const flows = {};
  for (const [name, tags] of Object.entries(OVER_A_PERIOD)) {
    flows[name] = overPeriods(filed(facts, tags[basis.standard], name === 'eps' ? perShare : basis.currency));
  }
  const balances = {};
  for (const [name, tags] of Object.entries(AT_A_DATE)) balances[name] = filed(facts, tags[basis.standard], basis.currency);

  const table = (kind, count) => {
    // The periods are those the company reported a profit for.
    const periods = [...flows.netIncome[kind].keys()].sort().reverse().slice(0, count);
    const rows = {};
    for (const [name, flow] of Object.entries(flows)) rows[name] = periods.map((end) => flow[kind].get(end) ?? null);
    for (const [name, list] of Object.entries(balances)) rows[name] = periods.map((end) => onDate(list, end));
    // Not every company files a gross profit; revenue less its cost is the same figure.
    rows.grossProfit = rows.grossProfit.map((value, i) => value ?? (rows.revenue[i] != null && rows.costOfRevenue[i] != null ? rows.revenue[i] - rows.costOfRevenue[i] : null));
    delete rows.costOfRevenue;
    // Total liabilities are not always filed as such; assets less equity is the same figure.
    rows.liabilities = rows.liabilities.map((value, i) => value ?? (rows.assets[i] != null && rows.equity[i] != null ? rows.assets[i] - rows.equity[i] : null));
    rows.freeCashFlow = periods.map((_, i) => (rows.operatingCashFlow[i] != null && rows.capex[i] != null ? rows.operatingCashFlow[i] - rows.capex[i] : null));
    return { periods, rows };
  };

  // The filing the newest figures come from.
  const annual = table('annual', YEARS_SHOWN);
  const quarterly = table('quarterly', QUARTERS_SHOWN);
  // A foreign filer reports once a year; the odd quarter it tagged years ago
  // is not a quarterly record. Quarters are shown only if they run up to date.
  const current = quarterly.periods.length > 0 && (!annual.periods.length || Date.parse(quarterly.periods[0]) > Date.parse(annual.periods[0]) - 100 * DAY_MS);

  // The filing the newest figures come from. It repeats last year's for
  // comparison, so within it the latest period is the one it reports.
  const newest = filed(facts, OVER_A_PERIOD.netIncome[basis.standard], basis.currency)
    .reduce((a, b) => (!a || b.filed > a.filed || (b.filed === a.filed && b.end > a.end) ? b : a), null);

  return {
    entity: company.entityName.split('/')[0].trim(),
    cik: company.cik,
    url: filingsUrl(company.cik),
    standard: basis.standard === 'us-gaap' ? 'US GAAP' : 'IFRS',
    currency: basis.currency,
    latest: newest && { form: newest.form, filed: newest.filed, period: newest.end },
    annual,
    quarterly: current ? quarterly : { periods: [], rows: {} },
  };
}

// ---- finding the company ---------------------------------------------------------

const tickerKey = (ticker) => String(ticker).toUpperCase().replace(/[^A-Z0-9]/g, '');

const SHORT_FORMS = { CORPORATION: 'CORP', INCORPORATED: 'INC', COMPANY: 'CO', LIMITED: 'LTD' };

// "The Coca-Cola Company" and "COCA COLA CO" are the same name.
export function nameKey(name) {
  return String(name)
    .split('/')[0] // the SEC adds a state after a slash: "TOYOTA MOTOR CORP/"
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[.,']/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word, i) => !(i === 0 && word === 'THE'))
    .map((word) => SHORT_FORMS[word] ?? word)
    .join(' ');
}

// ---- the service ---------------------------------------------------------------

// `contact` is the address given to the SEC; without one nothing is requested.
export function createEdgar({ contact, cacheDir }) {
  const headers = { 'User-Agent': `Global Dashboard ${contact}`, 'Accept-Encoding': 'gzip, deflate' };
  let queue = Promise.resolve();

  // One request at a time, spaced out.
  const request = (url) => {
    const run = queue.then(async () => {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(45_000) });
      if (!res.ok) throw new Error(`${new URL(url).hostname} responded ${res.status}`);
      return res.json();
    });
    queue = run.then(() => new Promise((resolve) => setTimeout(resolve, REQUEST_GAP_MS)), () => {});
    return run;
  };

  const read = async (name) => JSON.parse(await readFile(path.join(cacheDir, name), 'utf8').catch(() => 'null'));
  const write = async (name, value) => {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, name), JSON.stringify(value));
  };

  // Every registrant with a ticker, by ticker and by name.
  let registrants = null;
  async function index() {
    if (registrants && Date.now() - registrants.at < TICKERS_TTL_MS) return registrants;
    let kept = await read('tickers.json');
    let at = kept?.at;
    if (!kept || Date.now() - kept.at >= TICKERS_TTL_MS) {
      try {
        kept = { at: Date.now(), list: Object.values(await request(TICKERS_URL)) };
        await write('tickers.json', kept);
        at = kept.at;
      } catch (err) {
        if (!kept) throw err;
        // An out-of-date list still finds nearly everyone: it serves for an
        // hour before the SEC is asked again.
        at = Date.now() - TICKERS_TTL_MS + RETRY_MS;
      }
    }
    const byTicker = new Map();
    const byName = new Map();
    for (const entry of kept.list) {
      const company = { cik: entry.cik_str, title: entry.title };
      if (!byTicker.has(tickerKey(entry.ticker))) byTicker.set(tickerKey(entry.ticker), company);
      const key = nameKey(entry.title);
      // Two different registrants under one name cannot be told apart: neither is used.
      if (byName.has(key) && byName.get(key)?.cik !== company.cik) byName.set(key, null);
      else if (!byName.has(key)) byName.set(key, company);
    }
    registrants = { at, byTicker, byName };
    return registrants;
  }

  // A US-listed share is found by its ticker. A foreign one is not: its home
  // ticker may be someone else's in New York (ROG is Roche in Zurich and
  // Rogers Corp on the NYSE), so only its exact name will do.
  async function find({ ticker, names, us }) {
    const { byTicker, byName } = await index();
    if (us && byTicker.has(tickerKey(ticker))) return byTicker.get(tickerKey(ticker));
    for (const name of names) {
      const company = byName.get(nameKey(name));
      if (company) return company;
    }
    return null;
  }

  // Statements change once a quarter (once a year for a foreign filer with no
  // quarterly reports). They are fetched again when the copy on disk is a
  // quarter old, or weekly once the next report is overdue.
  function due(kept) {
    const age = Date.now() - kept.at;
    if (age > QUARTER_MS) return true;
    const between = kept.statements.quarterly.periods.length ? 100 : 480;
    const last = Date.parse(kept.statements.latest?.period ?? 0);
    return Date.now() - last > between * DAY_MS && age > RECHECK_MS;
  }

  async function statements(cik) {
    const name = `CIK${String(cik).padStart(10, '0')}.json`;
    const kept = await read(name);
    if (kept && !due(kept)) return kept;
    try {
      const fresh = { at: Date.now(), statements: distill(await request(factsUrl(cik))) };
      if (!fresh.statements) return kept ?? fresh;
      await write(name, fresh);
      return fresh;
    } catch (err) {
      if (kept) return kept; // the last copy is better than none
      throw err;
    }
  }

  // What EDGAR has on a company, as { status, ... }. Never throws: a company
  // page still has its price and key figures when the SEC cannot be reached.
  return async function financials(company) {
    if (!contact) return { status: 'unconfigured' };
    try {
      const registrant = await find(company);
      if (!registrant) return { status: 'none' };
      const kept = await statements(registrant.cik);
      if (!kept?.statements) return { status: 'none' };
      return { status: 'ok', fetchedAt: kept.at, ...kept.statements };
    } catch (err) {
      return { status: 'error', message: err.message || String(err) };
    }
  };
}
