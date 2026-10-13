// The arithmetic that turns filed figures into years and quarters (edgar.js),
// on a made-up company.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { distill, nameKey } from '../edgar.js';

// A figure over a period, and one at a date, as EDGAR files them.
const f = (start, end, val, form = '10-Q', filed = end) => ({ start, end, val, form, filed });
const at = (end, val, form = '10-Q') => ({ end, val, form, filed: end });
const usd = (list) => ({ units: { USD: list } });

// The fiscal year is the calendar year. 2025: quarters of 10, 12, 14 and (the
// year being 50) 14. 2026: 16 and 18 so far.
const revenue = [
  f('2024-01-01', '2024-12-31', 40, '10-K'),
  f('2025-01-01', '2025-03-31', 10), f('2025-04-01', '2025-06-30', 12), f('2025-01-01', '2025-06-30', 22),
  f('2025-07-01', '2025-09-30', 14), f('2025-01-01', '2025-09-30', 36), f('2025-01-01', '2025-12-31', 50, '10-K', '2026-02-01'),
  f('2026-01-01', '2026-03-31', 16), f('2026-04-01', '2026-06-30', 18, '10-Q', '2026-07-30'), f('2026-01-01', '2026-06-30', 34, '10-Q', '2026-07-30'),
  // the same quarter repeated a year later as a comparison, restated
  f('2025-04-01', '2025-06-30', 12.5, '10-Q', '2026-07-30'),
];
// Cash flow is only ever filed as a running total.
const cashFlow = [
  f('2025-01-01', '2025-03-31', 3), f('2025-01-01', '2025-06-30', 7), f('2025-01-01', '2025-09-30', 12), f('2025-01-01', '2025-12-31', 18, '10-K'),
  f('2026-01-01', '2026-03-31', 5), f('2026-01-01', '2026-06-30', 11),
];
const capex = cashFlow.map((x) => ({ ...x, val: x.val / 2 }));
// Profit: three quarters and the year, no nine-month total.
const profit = [
  f('2025-01-01', '2025-03-31', 1), f('2025-04-01', '2025-06-30', 2), f('2025-07-01', '2025-09-30', 3), f('2025-01-01', '2025-12-31', 10, '10-K', '2026-02-01'),
  f('2026-01-01', '2026-03-31', 4), f('2026-04-01', '2026-06-30', 5, '10-Q', '2026-07-30'), f('2025-04-01', '2025-06-30', 2, '10-Q', '2026-07-30'),
  f('2024-01-01', '2024-12-31', 8, '10-K'),
];

const statements = distill({
  cik: 1,
  entityName: 'EXAMPLE CORP /DE/',
  facts: { 'us-gaap': {
    Revenues: usd([f('2023-01-01', '2023-12-31', 33, '10-K')]), // an old tag, dropped after 2023
    RevenueFromContractWithCustomerExcludingAssessedTax: usd(revenue),
    CostOfRevenue: usd(revenue.map((x) => ({ ...x, val: x.val * 0.6 }))),
    NetIncomeLoss: usd([...profit, f('2023-01-01', '2023-12-31', 6, '10-K')]),
    NetCashProvidedByUsedInOperatingActivities: usd(cashFlow),
    PaymentsToAcquirePropertyPlantAndEquipment: usd(capex),
    Assets: usd([at('2025-12-31', 100, '10-K'), at('2026-06-30', 120), at('2024-12-31', 90, '10-K')]),
    StockholdersEquity: usd([at('2025-12-31', 40, '10-K'), at('2026-06-28', 55)]), // dated two days off
  } },
});

// A foreign filer: one annual report a year, and a stray quarter from years ago.
const foreign = distill({ cik: 2, entityName: 'Example AG', facts: { 'ifrs-full': {
  ProfitLoss: { units: { CHF: [f('2025-01-01', '2025-12-31', 9, '20-F', '2026-03-01'), f('2024-01-01', '2024-12-31', 8, '20-F'), f('2019-04-01', '2019-06-30', 2, '6-K')] } },
  RevenueFromSaleOfGoods: { units: { CHF: [f('2025-01-01', '2025-12-31', 90, '20-F', '2026-03-01'), f('2024-01-01', '2024-12-31', 80, '20-F')] } },
} } });

const tenth = (v) => (v == null ? null : Math.round(v * 10) / 10);

describe('a US company', () => {
  const cases = [
    ['entity name loses the state suffix', () => statements.entity, 'EXAMPLE CORP'],
    ['latest report: newest filing, and its own period not the comparison', () => statements.latest, { form: '10-Q', filed: '2026-07-30', period: '2026-06-30' }],
    ['fiscal years, newest first', () => statements.annual.periods, ['2025-12-31', '2024-12-31', '2023-12-31']],
    ['annual revenue, an older tag filling the year the new one lacks', () => statements.annual.rows.revenue, [50, 40, 33]],
    ['quarters, newest first', () => statements.quarterly.periods, ['2026-06-30', '2026-03-31', '2025-12-31', '2025-09-30', '2025-06-30', '2025-03-31']],
    ['quarterly revenue: Q4 = year less nine months; restated Q2 wins', () => statements.quarterly.rows.revenue, [18, 16, 14, 14, 12.5, 10]],
    ['quarterly profit: Q4 = year less its three quarters', () => statements.quarterly.rows.netIncome, [5, 4, 4, 3, 2, 1]],
    ['cash flow by quarter, from running totals', () => statements.quarterly.rows.operatingCashFlow, [6, 5, 6, 5, 4, 3]],
    ['free cash flow = cash from operations less capital expenditure', () => statements.quarterly.rows.freeCashFlow, [3, 2.5, 3, 2.5, 2, 1.5]],
    ['gross profit where only the cost is filed', () => statements.annual.rows.grossProfit.map(tenth), [20, 16, null]],
    ['balance sheet on the period\'s date, or within a few days of it', () => statements.quarterly.rows.equity.slice(0, 3), [55, null, 40]],
    ['total liabilities = assets less equity when not filed', () => statements.quarterly.rows.liabilities.slice(0, 3), [65, null, 60]],
  ];
  for (const [label, got, want] of cases) test(label, () => assert.deepEqual(got(), want));
});

describe('other filers', () => {
  test('foreign filer: standard, currency and revenue under its own tag', () => {
    assert.deepEqual([foreign.standard, foreign.currency, foreign.annual.rows.revenue], ['IFRS', 'CHF', [90, 80]]);
  });
  test('...and its stray old quarter is not shown as a quarterly record', () => {
    assert.deepEqual(foreign.quarterly.periods, []);
  });
  test('nothing tagged as profit: no statements', () => {
    assert.equal(distill({ cik: 3, entityName: 'Empty', facts: { 'us-gaap': {} } }), null);
  });
  test('names match across spellings', () => {
    assert.deepEqual(
      ['The Coca-Cola Company', 'COCA COLA CO', 'TOYOTA MOTOR CORP/', 'TOYOTA MOTOR CORPORATION', 'AT&T Inc.'].map(nameKey),
      ['COCA COLA CO', 'COCA COLA CO', 'TOYOTA MOTOR CORP', 'TOYOTA MOTOR CORP', 'AT AND T INC'],
    );
  });
});
