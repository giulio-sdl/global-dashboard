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
const EPS_YEARS = 12; // enough for the trailing twelve months at the start of a ten-year chart

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
    // Some file only the figure from continuing operations (Shell).
    'ifrs-full': ['DilutedEarningsLossPerShare', 'BasicEarningsLossPerShare', 'DilutedEarningsLossPerShareFromContinuingOperations', 'BasicEarningsLossPerShareFromContinuingOperations'],
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

// What valuing the company at a period's end takes besides the statements
// (see valuation.js). EBITDA is operating income with depreciation and
// amortization added back; for a company that files no operating income (an
// oil major), the profit before tax with interest added back too.
const DEPRECIATION = {
  // Depreciation alone, last, for the few that file nothing broader (Alphabet).
  'us-gaap': ['DepreciationDepletionAndAmortization', 'DepreciationAmortizationAndAccretionNet', 'DepreciationAndAmortization', 'Depreciation'],
  'ifrs-full': ['DepreciationAndAmortisationExpense', 'AdjustmentsForDepreciationAndAmortisationExpense', 'DepreciationAmortisationAndImpairmentLossReversalOfImpairmentLossRecognisedInProfitOrLoss', 'AdjustmentsForDepreciationExpense'],
};
const PRETAX = {
  'us-gaap': ['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments'],
  'ifrs-full': ['ProfitLossBeforeTax'],
};
const INTEREST = { 'us-gaap': ['InterestExpense', 'InterestExpenseNonoperating', 'InterestExpenseDebt'], 'ifrs-full': ['FinanceCosts'] };
// All debt: long-term debt including the part due within a year (else its two
// parts added up), and short-term borrowing besides. IFRS has one total for all of it.
const DEBT = {
  'us-gaap': {
    total: ['LongTermDebt'],
    noncurrent: ['LongTermDebtNoncurrent', 'LongTermDebtAndCapitalLeaseObligations'],
    current: ['LongTermDebtCurrent', 'LongTermDebtAndCapitalLeaseObligationsCurrent'],
    short: ['ShortTermBorrowings', 'CommercialPaper'],
  },
  'ifrs-full': {
    total: ['Borrowings'],
    noncurrent: ['NoncurrentBorrowings', 'LongtermBorrowings', 'NoncurrentPortionOfNoncurrentBorrowings'],
    current: ['CurrentBorrowings', 'ShorttermBorrowings', 'CurrentPortionOfNoncurrentBorrowings'],
    short: [],
  },
};
// Cash with the short-term investments that are as good as cash: the cash
// that enterprise value takes off.
const CASH = {
  'us-gaap': { total: ['CashCashEquivalentsAndShortTermInvestments'], investments: ['MarketableSecuritiesCurrent', 'ShortTermInvestments', 'AvailableForSaleSecuritiesDebtSecuritiesCurrent', 'DebtSecuritiesCurrent'] },
  'ifrs-full': { total: [], investments: ['CurrentInvestments'] },
};
// The number of shares, three ways, by the taxonomy each is filed in: on the
// balance sheet's date, on the report's cover (a few weeks after it), and
// averaged over the period as earnings per share are.
const SHARES = {
  date: { 'us-gaap': ['CommonStockSharesOutstanding'], 'ifrs-full': ['NumberOfSharesOutstanding'] },
  cover: { dei: ['EntityCommonStockSharesOutstanding'] },
  average: { 'us-gaap': ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfSharesOutstandingBasic'], 'ifrs-full': ['AdjustedWeightedAverageShares', 'WeightedAverageShares'] },
};
// The annual and quarterly reports, and their amendments and transition reports.
const REPORTS = /^(10-K|10-Q|20-F|40-F)/;
const VALUED = 5; // the periods valued, besides today
const COVER_DAYS = 120; // a report's cover dates its share count within this many days of the period's end

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

// A figure's filings under each of its tags, the tag with the newest figure first.
function byTag(facts, tags, unit) {
  const newest = (list) => list.reduce((max, fact) => (fact.end > max ? fact.end : max), '');
  return tags
    .map((tag) => facts?.[tag]?.units?.[unit] ?? [])
    .filter((list) => list.length)
    .sort((a, b) => (newest(a) < newest(b) ? 1 : newest(a) > newest(b) ? -1 : 0));
}

// One figure's filed values, the newest filing of each period winning. Tags
// are tried newest figure first; a later tag only adds periods the earlier
// ones lack.
function filed(facts, tags, unit) {
  const lists = byTag(facts, tags, unit);
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

// Every filing of a figure over a period since `since`, not only the newest:
// per-share figures are restated after a stock split, and the filing a value
// comes from says which shares it counts (see trailingEarnings). Kept as
// [start, end, value, filed]. Tags are taken as in `filed`.
function everyFiling(facts, tags, unit, since) {
  const claimed = new Set();
  const all = [];
  for (const list of byTag(facts, tags, unit)) {
    const own = list.filter((fact) => fact.start && fact.end >= since && !claimed.has(`${fact.start}|${fact.end}`));
    for (const fact of own) all.push([fact.start, fact.end, fact.val, fact.filed]);
    for (const fact of own) claimed.add(`${fact.start}|${fact.end}`);
  }
  return all;
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
// `factOn` gives the fact as filed, `onDate` only its value.
function factOn(list, date) {
  return list.find((fact) => fact.end === date)
    ?? list.find((fact) => Math.abs(Date.parse(fact.end) - Date.parse(date)) <= 5 * DAY_MS)
    ?? null;
}

function onDate(list, date) {
  return factOn(list, date)?.val ?? null;
}

// A figure over the twelve months to a period's end: the fiscal year that
// ends then, or the four quarters that do.
function twelveMonths({ annual, quarterly }, end) {
  if (annual.has(end)) return annual.get(end);
  const four = [...quarterly.keys()].filter((q) => q <= end).sort().slice(-4);
  // Four quarters in a row: the first closes about nine months before the last.
  const span = four.length === 4 ? days(four[0], end) : 0;
  return four[3] === end && span >= 260 && span <= 290 ? four.reduce((sum, q) => sum + quarterly.get(q), 0) : null;
}

// The number of shares on a period's end, from a list filed in one of the
// ways SHARES names: the fact as filed, since the day it was filed says
// which shares it counts (see valuation.js).
function sharesOn(kind, list, end) {
  const t = Date.parse(end);
  if (kind === 'date') return factOn(list, end);
  if (kind === 'cover') {
    const covers = list.filter((fact) => Date.parse(fact.end) > t && Date.parse(fact.end) <= t + COVER_DAYS * DAY_MS);
    return covers.length ? covers.reduce((a, b) => (b.end < a.end ? b : a)) : null;
  }
  // The average over the quarter to that day, else over the year: a fourth
  // quarter's is filed only as the year's.
  const over = list.filter((fact) => fact.start && Math.abs(Date.parse(fact.end) - t) <= 5 * DAY_MS);
  return over.find((fact) => isQuarter(days(fact.start, fact.end))) ?? over.find((fact) => isYear(days(fact.start, fact.end))) ?? null;
}

// What valuing the company at the end of each period in `ends` takes (see
// valuation.js): the twelve months' revenue and EBITDA to then, its equity,
// debt and cash on the day, and its number of shares with the day that
// count was filed.
function valuationBasis(company, { standard, currency }, flows, balances, ends) {
  const facts = company.facts[standard];
  const listed = (groups) => Object.fromEntries(Object.entries(groups).map(([part, tags]) => [part, filed(facts, tags, currency)]));
  const [depreciation, pretax, interest] = [DEPRECIATION, PRETAX, INTEREST].map((tags) => overPeriods(filed(facts, tags[standard], currency)));
  const debt = listed(DEBT[standard]);
  const cash = listed(CASH[standard]);

  const ebitdaTo = (end) => {
    const addedBack = twelveMonths(depreciation, end);
    const operating = twelveMonths(flows.operatingIncome, end);
    const beforeTax = twelveMonths(pretax, end);
    if (addedBack == null) return null;
    if (operating != null) return operating + addedBack;
    return beforeTax == null ? null : beforeTax + (twelveMonths(interest, end) ?? 0) + addedBack;
  };
  // Where a company does not tag its long-term debt (a bank, a conglomerate
  // that files it by business), the debt is not known: no figure, not none.
  const debtOn = (end) => {
    const noncurrent = onDate(debt.noncurrent, end);
    const long = onDate(debt.total, end) ?? (noncurrent == null ? null : noncurrent + (onDate(debt.current, end) ?? 0));
    return long == null ? null : long + (onDate(debt.short, end) ?? 0);
  };
  const cashOn = (end) => {
    const own = onDate(balances.cash, end);
    return onDate(cash.total, end) ?? (own == null ? null : own + (onDate(cash.investments, end) ?? 0));
  };
  // Only the changes in the number of shares are used (see valuation.js), so
  // it is counted one way throughout: the way that covers the latest period
  // and the most of the others.
  const counts = Object.entries(SHARES).map(([kind, tags]) => {
    const [taxonomy, names] = Object.entries(tags).find(([name]) => name === 'dei' || name === standard) ?? [];
    const list = names ? filed(company.facts[taxonomy], names, 'shares') : [];
    return ends.map((end) => sharesOn(kind, list, end));
  });
  const covered = (count) => count.filter((n) => n != null).length;
  const shares = counts.filter((count) => count[0] != null).reduce((best, count) => (!best || covered(count) > covered(best) ? count : best), null);

  return ends.map((end, i) => ({
    end,
    revenue: twelveMonths(flows.revenue, end),
    ebitda: ebitdaTo(end),
    equity: onDate(balances.equity, end),
    debt: debtOn(end),
    cash: cashOn(end),
    shares: shares?.[i]?.val ?? null,
    sharesFiled: shares?.[i]?.filed ?? null,
  }));
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

  // One row of figures per line item for the periods ending on `ends`, a
  // figure over a period taken by `over`: its fiscal year, its quarter, or
  // the twelve months to its end.
  const lines = (ends, over) => {
    const rows = {};
    for (const [name, flow] of Object.entries(flows)) rows[name] = ends.map((end) => over(flow, end));
    for (const [name, list] of Object.entries(balances)) rows[name] = ends.map((end) => onDate(list, end));
    // Not every company files a gross profit; revenue less its cost is the same figure.
    rows.grossProfit = rows.grossProfit.map((value, i) => value ?? (rows.revenue[i] != null && rows.costOfRevenue[i] != null ? rows.revenue[i] - rows.costOfRevenue[i] : null));
    delete rows.costOfRevenue;
    // Total liabilities are not always filed as such; assets less equity is the same figure.
    rows.liabilities = rows.liabilities.map((value, i) => value ?? (rows.assets[i] != null && rows.equity[i] != null ? rows.assets[i] - rows.equity[i] : null));
    rows.freeCashFlow = ends.map((_, i) => (rows.operatingCashFlow[i] != null && rows.capex[i] != null ? rows.operatingCashFlow[i] - rows.capex[i] : null));
    return rows;
  };
  const table = (kind, count) => {
    // The periods are those the company reported a profit for.
    const periods = [...flows.netIncome[kind].keys()].sort().reverse().slice(0, count);
    return { periods, rows: lines(periods, (flow, end) => flow[kind].get(end) ?? null) };
  };

  // The filing the newest figures come from.
  const annual = table('annual', YEARS_SHOWN);
  const quarterly = table('quarterly', QUARTERS_SHOWN);
  // A foreign filer reports once a year; the odd quarter it tagged years ago
  // is not a quarterly record. Quarters are shown only if they run up to date.
  const current = quarterly.periods.length > 0 && (!annual.periods.length || Date.parse(quarterly.periods[0]) > Date.parse(annual.periods[0]) - 100 * DAY_MS);
  // The years lead with the twelve months to the latest quarter, where that
  // ends after the last fiscal year: flows over the last four quarters, the
  // balance sheet of that quarter.
  const ttmEnd = current && (!annual.periods.length || quarterly.periods[0] > annual.periods[0]) ? quarterly.periods[0] : null;
  const ttm = ttmEnd && { end: ttmEnd, rows: Object.fromEntries(Object.entries(lines([ttmEnd], twelveMonths)).map(([name, [value]]) => [name, value])) };
  // Valued at the ends of the latest quarters, or of the latest years for a
  // company that reports once a year.
  const valued = (current ? quarterly : annual).periods.slice(0, VALUED);

  // The filing the newest figures come from. It repeats last year's for
  // comparison, so within it the latest period is the one it reports. A proxy
  // statement or an 8-K may repeat a year's profit after the report itself
  // (Microsoft's does); those are not reports, unless there is nothing else.
  const profits = byTag(facts, OVER_A_PERIOD.netIncome[basis.standard], basis.currency).flat();
  const reports = profits.filter((fact) => REPORTS.test(fact.form ?? ''));
  const newest = (reports.length ? reports : profits)
    .reduce((a, b) => (!a || b.filed > a.filed || (b.filed === a.filed && b.end > a.end) ? b : a), null);

  return {
    entity: company.entityName.split('/')[0].trim(),
    cik: company.cik,
    url: filingsUrl(company.cik),
    standard: basis.standard === 'us-gaap' ? 'US GAAP' : 'IFRS',
    currency: basis.currency,
    latest: newest && { form: newest.form, filed: newest.filed, period: newest.end },
    annual,
    ttm,
    quarterly: current ? quarterly : { periods: [], rows: {} },
    valuation: { kind: current ? 'quarter' : 'year', periods: valuationBasis(company, basis, flows, balances, valued) },
    // Earnings per share as filed, for the P/E line (see trailingEarnings).
    eps: everyFiling(facts, OVER_A_PERIOD.eps[basis.standard], perShare, new Date(Date.now() - EPS_YEARS * 366 * DAY_MS).toISOString().slice(0, 10)),
  };
}

// ---- earnings per share over twelve months ---------------------------------------

// Decimals a figure was filed with: 0.17 has two.
const places = (value) => (String(value).split('.')[1] ?? '').length;

// The earnings per share of the last twelve months, as each report made them
// known: `at` is the day a period was first filed, `end` the day it closed.
// A fiscal year is its own figure; any other twelve months are the last four
// quarters added up. `eps` is the list distill keeps.
//
// A stock split changes what one share is. A filing counts in the shares of
// its own day, and the filings after a split restate earlier figures in the
// new ones, so every value is first brought to today's shares: divided by
// `splitFactor(filed)`, how many of today's shares one share was on the day it
// was filed (10 for NVIDIA before its split of June 2024, 1 after it). Prices
// on the charts count today's shares too, so the two can be divided.
export function trailingEarnings(eps, splitFactor) {
  const periods = new Map();
  for (const [start, end, raw, filed] of eps) {
    const key = `${start}|${end}`;
    periods.set(key, [...(periods.get(key) ?? []), { start, end, raw, filed, val: raw / splitFactor(filed) }]);
  }
  // The newest filing of a period wins, as in the statements, but an older
  // one that it only rounds is more exact: NVIDIA's earnings for 2022 were
  // filed as 1.74 a share before its split and as 0.17 after it, not 0.174.
  const chosen = [...periods.values()].map((filings) => {
    const newest = filings.reduce((a, b) => (b.filed > a.filed ? b : a));
    const rounding = 0.5 * 10 ** -places(newest.raw) + 1e-9;
    return filings
      .filter((fact) => Math.abs(fact.val - newest.val) <= rounding)
      .reduce((best, fact) => (Math.abs(fact.raw) > Math.abs(best.raw) ? fact : best), newest);
  });
  const flow = overPeriods(chosen);
  const firstFiled = new Map();
  for (const [, end, , filed] of eps) if (!firstFiled.has(end) || filed < firstFiled.get(end)) firstFiled.set(end, filed);

  const trailing = [];
  for (const end of [...new Set([...flow.annual.keys(), ...flow.quarterly.keys()])].sort()) {
    const value = twelveMonths(flow, end);
    if (value != null) trailing.push({ at: firstFiled.get(end), end, eps: Number(value.toFixed(4)) });
  }
  // A period filed late (an amendment, a first report covering several years)
  // does not take the place of a newer one already known.
  trailing.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.end < b.end ? -1 : 1));
  return trailing.filter((entry, i) => trailing.slice(0, i).every((before) => before.end < entry.end));
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
      if (!res.ok) throw Object.assign(new Error(`${new URL(url).hostname} responded ${res.status}`), { status: res.status });
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
    // Kept before earnings per share, or valuation figures with the day each share count was filed, were.
    if (!kept.statements.eps || !kept.statements.valuation?.periods.every((period) => 'sharesFiled' in period)) return true;
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
      if (err.status === 404) return null; // a registrant with no figures filed at all (a fund, a trust)
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
