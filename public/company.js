// The company panel: one constituent of an index, or any share found with the
// search box, with its price chart and P/E, its key figures from the quote
// feed and its financial statements as filed with the SEC. From an index it
// opens on top of the index panel and closes back to it.
import { chartFigure } from './figure.js';
import { changeText, lineView } from './periods.js';
import { $, el, fmt, getJson, renderExtended, signed, timeLabel } from './util.js';

const dialog = $('#company');
const chart = chartFigure($('.d-chart', dialog), (period) => { if (open) showChart(period); });
let open = null; // the company on show: { index (null from the search box), row, data, error, view, period, lines (by period) }
let request = null; // its requests, dropped if another company is opened

// The statements, line by line. `eps` is per share; a margin is one line over
// revenue, worked out here.
const STATEMENTS = [
  ['Income statement', [
    ['revenue', 'Revenue'],
    ['grossProfit', 'Gross profit'],
    ['operatingIncome', 'Operating income'],
    ['netIncome', 'Net income'],
    ['eps', 'Earnings per share', 'perShare'],
    ['grossMargin', 'Gross margin', 'percent'],
    ['operatingMargin', 'Operating margin', 'percent'],
    ['netMargin', 'Net margin', 'percent'],
  ]],
  ['Cash flow', [
    ['operatingCashFlow', 'Cash from operations'],
    ['capex', 'Capital expenditure'],
    ['freeCashFlow', 'Free cash flow'],
  ]],
  ['Balance sheet', [
    ['cash', 'Cash and equivalents'],
    ['assets', 'Total assets'],
    ['liabilities', 'Total liabilities'],
    ['equity', "Shareholders' equity"],
    ['debt', 'Long-term debt'],
  ]],
];
const MARGINS = { grossMargin: 'grossProfit', operatingMargin: 'operatingIncome', netMargin: 'netIncome' };

// The valuation measures in Yahoo's order; `money` ones are amounts, the rest ratios.
const MEASURES = [
  ['marketCap', 'Market cap', 'money'],
  ['enterpriseValue', 'Enterprise value', 'money'],
  ['pe', 'Trailing P/E'],
  ['forwardPe', 'Forward P/E'],
  ['peg', 'PEG ratio · next year'],
  ['priceToSales', 'P/S · TTM'],
  ['priceToBook', 'P/B'],
  ['evToRevenue', 'EV / revenue · TTM'],
  ['evToEbitda', 'EV / EBITDA · TTM'],
];
const VIEWS = { annual: 'Annual', quarterly: 'Quarterly' };

// The P/E line is drawn from six months up. Earnings change once a quarter,
// so over a shorter period it would mostly retrace the price.
const PE_FROM = new Set(['6m', '1y', '5y', '10y']);
// A twelve-month figure stands until the next report; one whose year ended
// longer ago than this (a company that has stopped filing) gives no P/E.
const EARNINGS_KEPT_MS = 550 * 24 * 3600_000;

// 4,913,000,000,000 reads 4.91T.
function large(value) {
  if (value == null) return null;
  const size = Math.abs(value);
  const [unit, letter] = size >= 1e12 ? [1e12, 'T'] : size >= 1e9 ? [1e9, 'B'] : size >= 1e6 ? [1e6, 'M'] : [1, ''];
  return `${figure(value / unit, letter ? 2 : 0)}${letter}`;
}

// A figure with a true minus sign, as elsewhere on the dashboard.
const figure = (value, dp) => (value < 0 ? `−${fmt(-value, dp)}` : fmt(value, dp));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "2025-09-27" as "Sep 2025" and as "27 Sep 2025".
const monthOf = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const longDate = (iso) => `${Number(iso.slice(8, 10))} ${monthOf(iso)}`;

// The twelve months' earnings per share known at a time: from the last report
// filed by then (see trailingEarnings in edgar.js), while it is recent enough.
function earningsAt(trailing, time) {
  let known = null;
  for (const entry of trailing) {
    if (Date.parse(entry.at) > time) break;
    known = entry;
  }
  return known && time - Date.parse(known.end) <= EARNINGS_KEPT_MS ? known : null;
}

// The P/E at a time and price; none while the twelve months show a loss.
function peAt(trailing, time, price) {
  const known = earningsAt(trailing, time);
  return known && known.eps > 0 ? price / known.eps : null;
}

// The query naming the company: from an index's panel, with the index.
const asked = ({ index, row }) => `${index ? `index=${encodeURIComponent(index.symbol)}&` : ''}symbol=${encodeURIComponent(row.symbol)}`;

export function initCompany() {
  $('#company-close').addEventListener('click', () => dialog.close());
  // A click on the backdrop lands on the dialog element itself.
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    request?.abort();
    open = null;
  });
  new ResizeObserver(() => { if (open) drawChart(); }).observe(chart.plot);
}

// `index` is the row of the dashboard the company was reached from, `row` its
// line among that index's constituents. The chart opens on `period`: the one
// the index panel was showing. From the search box `index` is null and `row`
// the result picked, { symbol, name, type, exchange }.
export async function openCompany(index, row, period = '1d') {
  request?.abort();
  request = new AbortController();
  const mine = { index, row, data: null, error: null, view: 'annual', period, lines: {}, waiting: new Set() };
  open = mine;
  chart.select(period);
  chart.loading(true);
  $('#company-title').textContent = row.name;
  // On a phone the button only says "Back", to leave the name its room.
  $('#company-close').replaceChildren(...(index ? ['Back', el('span', { class: 'c-wide', text: ` to ${index.name}` })] : ['Close']));
  render();
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  try {
    const { company } = await getJson(`/api/company?${asked(mine)}`, request.signal);
    if (open !== mine) return;
    mine.data = company;
  } catch (err) {
    if (open !== mine) return;
    mine.error = err.message;
  }
  render();
  if (mine.data) showChart(mine.period);
  else chart.loading(false);
}

// Switches the chart to a period, fetching its line the first time.
async function showChart(period) {
  const mine = open;
  mine.period = period;
  chart.select(period);
  drawChart();
  // Busy only while the period on show is the one being fetched: another
  // period's answer arriving first must not say this one has no data.
  chart.loading(!mine.lines[period] && !mine.error);
  if (!mine.data || mine.lines[period] || mine.waiting.has(period)) return;
  mine.waiting.add(period);
  try {
    const answer = await getJson(`/api/chart?${asked(mine)}&range=${period}`, request.signal);
    mine.lines[period] = answer.chart;
  } catch {
    // The chart area says there is no data; pressing the period again asks once more.
  }
  mine.waiting.delete(period);
  if (open !== mine) return;
  chart.loading(mine.waiting.has(mine.period));
  drawChart();
}

// The line of the period on show, and the change over it: the day's from the
// quote, a longer one against the close the period is measured from.
function drawChart() {
  const { row, period } = open;
  const q = open.data?.quote;
  const line = open.lines[period];
  const change = !q ? null : period === '1d' ? q.changePct : line?.from != null ? (q.last / line.from - 1) * 100 : null;
  const view = q ? lineView(period, line?.spark, q, Date.now()) : {};
  chart.draw({ view, period, name: row.name, dp: q?.dp ?? row.dp, change, second: peLine(view, period) });
}

// The P/E over the line on show, a figure for each point: the price there over
// the twelve months' earnings per share known by then. Prices and earnings are
// both in today's shares, so a stock split is no break in it.
function peLine(view, period) {
  const earnings = open.data?.earnings;
  if (earnings?.status !== 'ok') return null;
  const { trailing } = earnings;
  const values = PE_FROM.has(period) && view.c ? view.c.map((price, i) => peAt(trailing, view.t[i], price)) : null;
  const now = earningsAt(trailing, Date.now());
  return {
    label: 'P/E',
    values,
    now: peAt(trailing, Date.now(), open.data.quote.last),
    dp: 1,
    note: !now ? 'no recent report' : now.eps <= 0 ? 'none: a loss over 12 months' : values ? 'ratio scale, both from the same start' : 'line from 6M up',
  };
}

// What the P/E line is, or why there is none. `valued` says whether the
// valuation measures are shown.
function peNote(data, valued) {
  const { earnings, filings } = data;
  if (earnings.status === 'ok') {
    const latest = earnings.trailing.at(-1);
    // The valuation measures take today's P/E from this line, unless they are
    // only the feed's: the latest filings are too old (Toyota's), or the feed
    // gave no market cap to carry back.
    const elsewhere = data.valuation.source === 'filings' ? 'Today\'s is the trailing P/E among the valuation measures.'
      : valued ? 'The trailing P/E among the valuation measures is the quote feed\'s.'
        : 'The P/E among the key figures is the quote feed\'s.';
    return el('p', { class: 'd-note' },
      `P/E: the price over the twelve months' diluted earnings per share as filed with the SEC (${figure(latest.eps, 2)} ${earnings.currency} for the twelve months to ${longDate(latest.end)}), `
      + 'each report from the day it was filed, and earlier ones in today\'s shares across stock splits. '
      + 'Both lines start together on a ratio scale, so where they part, earnings have changed. Hover the chart for the P/E on any day. '
      + `There is no P/E while the twelve months show a loss. ${elsewhere}`);
  }
  const why = {
    currency: () => `${data.name} reports its earnings in ${earnings.reported}, and this listing is priced in ${earnings.quoted}.`,
    shares: () => `the company files its earnings per ordinary share, and this listing's shares look to stand for a different number of them (the filings give a P/E of ${fmt(earnings.pe, 1)}, the quote feed ${fmt(earnings.feeds, 1)}).`,
    error: () => `${earnings.message}. It is tried again when the panel is next opened.`,
    none: () => (filings.status === 'ok' ? 'the company\'s filings with the SEC carry no earnings per share for recent years.' : null),
  }[earnings.status]?.();
  return why && el('p', { class: 'd-note' }, `No P/E line: ${why}`);
}

function stat(label, value) {
  return el('div', {}, el('dt', { text: label }), el('dd', { text: value }));
}

// The figures of a share's summary page, as far as the feed has them. Those
// among the valuation measures are left out when the measures are shown.
function keyFigures(q, valued) {
  const s = q.stats ?? {};
  const money = (value) => (value == null ? null : `${large(value)} ${q.currency ?? ''}`.trim());
  const percent = (value) => (value == null ? null : `${figure(value, 2)}%`);
  const plain = (value) => (value == null ? null : figure(value, 2));
  const range = (low, high) => (low != null && high != null ? `${fmt(low, q.dp)} – ${fmt(high, q.dp)}` : null);
  const unlessValued = (value) => (valued ? null : value);
  return [
    ['Market cap', unlessValued(money(s.marketCap))],
    ['P/E', unlessValued(plain(s.pe))],
    ['Forward P/E', unlessValued(plain(s.forwardPe))],
    ['EPS · 12 months', plain(s.eps)],
    ['Dividend', s.dividend == null ? null : `${fmt(s.dividend, 2)}${s.dividendYield == null ? '' : ` (${fmt(s.dividendYield, 2)}%)`}`],
    ['Revenue · 12 months', money(s.revenue)],
    ['EBITDA · 12 months', money(s.ebitda)],
    ['Gross margin', percent(s.grossMargin)],
    ['Net margin', percent(s.netMargin)],
    ['Return on equity', percent(s.returnOnEquity)],
    ['Debt / equity', percent(s.debtToEquity)],
    ['P/S', unlessValued(plain(s.priceToSales))],
    ['Beta', plain(s.beta)],
    ['Shares outstanding', large(s.sharesOutstanding)],
    ['Volume', s.volume == null ? null : `${large(s.volume)}${s.averageVolume == null ? '' : ` (10-day average ${large(s.averageVolume)})`}`],
    ['Previous close', fmt(q.prevClose, q.dp)],
    ['Day range', range(q.low, q.high)],
    ['52-week range', range(q.yrLow, q.yrHigh)],
  ].filter(([, value]) => value != null).map(([label, value]) => stat(label, value));
}

// Yahoo's valuation measures, today's and at the end of each recent period
// (see valuation.js): a table with a row per measure, today first.
function valuationTable({ currency, kind, dates, rows }) {
  const cell = (value, money) => {
    if (value == null) return el('td', { class: 'na', text: '—' });
    return el('td', { class: value < 0 ? 'down' : '', text: money ? large(value) : figure(value, 2) });
  };
  const head = el('tr', {}, el('th', { scope: 'col', text: currency ?? '' }),
    ...dates.map((end) => (end == null
      ? el('th', { scope: 'col', title: 'Today\'s price with the latest figures filed', text: 'Current' })
      : el('th', { scope: 'col', title: `The close on ${longDate(end)}, the end of the ${kind === 'year' ? 'fiscal year' : 'quarter'}, with the figures to that day`, text: monthOf(end) }))));
  const body = el('tbody');
  for (const [name, label, money] of MEASURES) {
    body.append(el('tr', {}, el('th', { scope: 'row', text: label }), ...rows[name].map((value) => cell(value, money))));
  }
  return el('table', { class: 'c-table', style: `--cols: ${dates.length}` }, el('thead', {}, head), body);
}

// What the valuation measures are made of, and what they lack.
function valuationNote(data) {
  const { valuation, filings, earnings } = data;
  const peg = 'The PEG ratio is the feed\'s P/E over the growth in earnings per share that analysts\' estimates expect for the next year; Yahoo\'s uses their five-year growth, which the feed does not carry.';
  if (valuation.source === 'feed') {
    const why = filings.status === 'ok' && filings.currency !== valuation.currency
      ? `${data.name} files its statements in ${filings.currency} and this listing is priced in ${valuation.currency}`
      : 'without recent statements filed with the SEC';
    return el('p', { class: 'd-note', text: `From the quote feed, for today only: ${why}, there are no earlier periods to value it at. ${peg}` });
  }
  // A bank does not tag its debt as such; the odd company its cash.
  const lacks = valuation.lacks ?? [];
  const untagged = lacks.length === 2 ? 'its debt or its cash' : `its ${lacks[0]}`;
  return el('p', { class: 'd-note' },
    'Current is today\'s price with the latest figures filed with the SEC; each earlier column is the close on the period\'s last day with the figures to it. '
    + 'Market cap is the quote feed\'s, carried back by the price and the number of shares the company filed. '
    + 'Enterprise value adds debt and takes off cash and short-term investments. '
    + 'Sales, revenue and EBITDA (operating income with depreciation and amortization added back) are the twelve months\' (TTM), book value is shareholders\' equity on the day. '
    + (earnings.status === 'ok' ? '' : 'The trailing P/E today is the quote feed\'s, and there is none earlier. ')
    + (lacks.length ? `The company does not tag ${untagged} in its filings${lacks.includes('debt') ? ' (as is usual for a bank)' : ''}, so there is no enterprise value. ` : '')
    + `The forward P/E is the quote feed's, from analysts' estimates. ${peg}`);
}

// One view of the statements as a table: a column per period, newest first.
// The years lead with the twelve months to the latest quarter (TTM) where
// that ends after the last fiscal year.
function statementTable(filings, view) {
  const ttm = view === 'annual' ? filings.ttm : null;
  const periods = [...(ttm ? [ttm.end] : []), ...filings[view].periods];
  const rows = Object.fromEntries(Object.entries(filings[view].rows).map(([line, values]) => [line, ttm ? [ttm.rows[line] ?? null, ...values] : values]));
  const all = { ...rows };
  for (const [margin, line] of Object.entries(MARGINS)) {
    all[margin] = periods.map((_, i) => (rows[line]?.[i] != null && rows.revenue?.[i] ? (rows[line][i] / rows.revenue[i]) * 100 : null));
  }
  // Billions for a large company, millions for a small one, by its biggest figure.
  const biggest = Math.max(...['revenue', 'assets'].flatMap((line) => rows[line] ?? []).map((value) => Math.abs(value ?? 0)));
  const [unit, unitName] = biggest >= 1e10 ? [1e9, 'billions'] : [1e6, 'millions'];
  // One number of decimals along a line, set by its largest figure.
  const decimals = (values) => {
    const largest = Math.max(...values.map((value) => Math.abs(value ?? 0))) / unit;
    return largest >= 1000 ? 0 : largest >= 100 ? 1 : 2;
  };
  const cell = (value, kind, dp) => {
    if (value == null) return el('td', { class: 'na', text: '—' });
    const text = kind === 'percent' ? `${figure(value, 1)}%` : kind === 'perShare' ? figure(value, 2) : figure(value / unit, dp);
    return el('td', { class: value < 0 ? 'down' : '', text });
  };

  const head = el('tr', {}, el('th', { scope: 'col', text: `${filings.currency} ${unitName}` }),
    ...periods.map((end, i) => (ttm && i === 0
      ? el('th', { scope: 'col', title: `Twelve months to ${longDate(end)}, with the balance sheet on that day`, text: 'TTM' })
      : el('th', { scope: 'col', title: `${view === 'annual' ? 'Fiscal year' : 'Quarter'} to ${longDate(end)}`, text: monthOf(end) }))));
  const body = el('tbody');
  for (const [title, lines] of STATEMENTS) {
    const filedLines = lines.filter(([line]) => all[line]?.some((value) => value != null));
    if (!filedLines.length) continue;
    body.append(el('tr', { class: 'c-group' }, el('th', { scope: 'rowgroup', colspan: String(periods.length + 1), text: title })));
    for (const [line, label, kind] of filedLines) {
      const dp = decimals(all[line]);
      body.append(el('tr', { class: kind === 'percent' ? 'c-ratio' : '' }, el('th', { scope: 'row', text: label }), ...all[line].map((value) => cell(value, kind, dp))));
    }
  }
  return el('table', { class: 'c-table', style: `--cols: ${periods.length}` }, el('thead', {}, head), body);
}

function statements(filings) {
  if (filings.status === 'none') {
    return [el('p', { class: 'd-note', text: 'This company files no financial statements with the US Securities and Exchange Commission. The SEC\'s database covers companies registered in the United States, so most shares listed only elsewhere are not in it.' })];
  }
  if (filings.status === 'unconfigured') {
    return [el('p', { class: 'd-note', text: 'Financial statements come from the SEC, which asks for a contact address before it answers. None is set on this computer; the README explains how.' })];
  }
  if (filings.status === 'error') {
    return [el('p', { class: 'd-note warn', text: `The SEC's database could not be read just now (${filings.message}). The key figures above are unaffected.` })];
  }
  const views = Object.keys(VIEWS).filter((view) => filings[view].periods.length);
  if (!views.length) return [el('p', { class: 'd-note', text: 'The SEC has this company on file, but with no income figures to lay out yet.' })];
  if (!views.includes(open.view)) [open.view] = views;

  const toggle = el('div', { class: 'ranges', role: 'group', 'aria-label': 'Statement period' });
  for (const view of views) {
    const button = el('button', { type: 'button', 'aria-pressed': String(view === open.view), text: VIEWS[view] });
    button.addEventListener('click', () => {
      open.view = view;
      render();
    });
    toggle.append(button);
  }
  const { latest } = filings;
  const ttm = open.view === 'annual' && filings.ttm ? `TTM is the twelve months to ${longDate(filings.ttm.end)}: the last four quarters added up, with the balance sheet of the latest. ` : '';
  const source = el('p', { class: 'd-note' },
    `As filed with the SEC by ${filings.entity} under ${filings.standard}. The latest report is a ${latest.form} filed on ${longDate(latest.filed)} for the period to ${longDate(latest.period)}. Where a company files a quarter only as part of a running total, it is worked out by subtraction. ${ttm}Checked for a new report once a quarter. `,
    el('a', { href: filings.url, target: '_blank', rel: 'noopener', text: 'All filings at the SEC' }), '.');
  return [el('div', { class: 'c-head' }, toggle), el('div', { class: 'c-scroll' }, statementTable(filings, open.view)), source];
}

function render() {
  if (!open) return;
  const { row, index, data, error } = open;
  const q = data?.quote;
  $('.d-sub', dialog).textContent = [row.ticker ?? row.symbol, q?.stats?.exchange ?? row.exchange, row.sector, index && `${fmt(row.weight, 2)}% of ${index.name}`].filter(Boolean).join(' · ');
  $('.dq-last', dialog).textContent = fmt(q?.last ?? row.last, q?.dp ?? row.dp);
  const move = changeText(q?.changePct ?? null, false);
  const moved = $('.dq-chg', dialog);
  moved.textContent = q ? `${signed(q.change, q.dp).text} (${move.text})` : '';
  moved.className = `dq-chg ${move.dir}`;
  $('.dq-time', dialog).textContent = q ? [q.currency, 'latest session', timeLabel(q.time)].filter(Boolean).join(' · ') : '';
  renderExtended($('.d-ext', dialog), q);

  drawChart();
  const body = $('#c-body');
  if (error) return body.replaceChildren(el('p', { class: 'd-note warn', text: `Could not load this company (${error}).` }));
  if (!data) return body.replaceChildren(el('p', { class: 'd-note', text: 'Loading the company\'s figures…' }));
  // A fund, an index or a future found with the search box has no statements
  // or valuation to speak of.
  const company = !row.type || ['STOCK', 'CSRT'].includes(row.type) || data.filings.status === 'ok';
  const valued = company && Object.values(data.valuation.rows).some((values) => values.some((value) => value != null));
  return body.replaceChildren(
    ...[peNote(data, valued)].filter(Boolean),
    ...(valued ? [el('h3', { text: 'Valuation measures' }), el('div', { class: 'c-scroll' }, valuationTable(data.valuation)), valuationNote(data)] : []),
    el('h3', { text: 'Key figures' }),
    el('dl', { class: 'd-stats' }, ...keyFigures(q, valued)),
    el('p', { class: 'd-note', text: 'From the quote feed.' }),
    ...(company ? [el('h3', { text: 'Financial statements' }), ...statements(data.filings)] : []),
  );
}
