// The company panel: one constituent of an index, with its price chart, its
// key figures from the quote feed and its financial statements as filed with
// the SEC. It opens on top of the index panel and closes back to it.
import { chartFigure } from './figure.js';
import { changeText, lineView } from './periods.js';
import { $, el, fmt, getJson, signed, timeLabel } from './util.js';

const dialog = $('#company');
const chart = chartFigure($('.d-chart', dialog), (period) => { if (open) showChart(period); });
let open = null; // the company on show: { index, row, data, error, view, period, lines (by period) }
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
const VIEWS = { annual: 'Annual', quarterly: 'Quarterly' };

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
// the index panel was showing.
export async function openCompany(index, row, period = '1d') {
  request?.abort();
  request = new AbortController();
  const mine = { index, row, data: null, error: null, view: 'annual', period, lines: {}, waiting: new Set() };
  open = mine;
  chart.select(period);
  chart.loading(true);
  $('#company-title').textContent = row.name;
  // On a phone the button only says "Back", to leave the name its room.
  $('#company-close').replaceChildren('Back', el('span', { class: 'c-wide', text: ` to ${index.name}` }));
  render();
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  try {
    const { company } = await getJson(`/api/company?index=${encodeURIComponent(index.symbol)}&symbol=${encodeURIComponent(row.symbol)}`, request.signal);
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
    const answer = await getJson(`/api/chart?index=${encodeURIComponent(mine.index.symbol)}&symbol=${encodeURIComponent(mine.row.symbol)}&range=${period}`, request.signal);
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
  chart.draw({ view: q ? lineView(period, line?.spark, q, Date.now()) : {}, period, name: row.name, dp: q?.dp ?? row.dp, change });
}

function stat(label, value) {
  return el('div', {}, el('dt', { text: label }), el('dd', { text: value }));
}

// The figures of a share's summary page, as far as the feed has them.
function keyFigures(q) {
  const s = q.stats ?? {};
  const money = (value) => (value == null ? null : `${large(value)} ${q.currency ?? ''}`.trim());
  const percent = (value) => (value == null ? null : `${figure(value, 2)}%`);
  const plain = (value) => (value == null ? null : figure(value, 2));
  const range = (low, high) => (low != null && high != null ? `${fmt(low, q.dp)} – ${fmt(high, q.dp)}` : null);
  return [
    ['Market cap', money(s.marketCap)],
    ['P/E', plain(s.pe)],
    ['Forward P/E', plain(s.forwardPe)],
    ['EPS · 12 months', plain(s.eps)],
    ['Dividend', s.dividend == null ? null : `${fmt(s.dividend, 2)}${s.dividendYield == null ? '' : ` (${fmt(s.dividendYield, 2)}%)`}`],
    ['Revenue · 12 months', money(s.revenue)],
    ['EBITDA · 12 months', money(s.ebitda)],
    ['Gross margin', percent(s.grossMargin)],
    ['Net margin', percent(s.netMargin)],
    ['Return on equity', percent(s.returnOnEquity)],
    ['Debt / equity', percent(s.debtToEquity)],
    ['P/S', plain(s.priceToSales)],
    ['Beta', plain(s.beta)],
    ['Shares outstanding', large(s.sharesOutstanding)],
    ['Volume', s.volume == null ? null : `${large(s.volume)}${s.averageVolume == null ? '' : ` (10-day average ${large(s.averageVolume)})`}`],
    ['Previous close', fmt(q.prevClose, q.dp)],
    ['Day range', range(q.low, q.high)],
    ['52-week range', range(q.yrLow, q.yrHigh)],
  ].filter(([, value]) => value != null).map(([label, value]) => stat(label, value));
}

// One view of the statements as a table: a column per period, newest first.
function statementTable(filings, view) {
  const { periods, rows } = filings[view];
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
    ...periods.map((end) => el('th', { scope: 'col', title: `${view === 'annual' ? 'Fiscal year' : 'Quarter'} to ${longDate(end)}`, text: monthOf(end) })));
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
  const source = el('p', { class: 'd-note' },
    `As filed with the SEC by ${filings.entity} under ${filings.standard}. The latest report is a ${latest.form} filed on ${longDate(latest.filed)} for the period to ${longDate(latest.period)}. Where a company files a quarter only as part of a running total, it is worked out by subtraction. Checked for a new report once a quarter. `,
    el('a', { href: filings.url, target: '_blank', rel: 'noopener', text: 'All filings at the SEC' }), '.');
  return [el('div', { class: 'c-head' }, toggle), el('div', { class: 'c-scroll' }, statementTable(filings, open.view)), source];
}

function render() {
  if (!open) return;
  const { row, index, data, error } = open;
  const q = data?.quote;
  $('.d-sub', dialog).textContent = [row.ticker, q?.stats?.exchange, row.sector, `${fmt(row.weight, 2)}% of ${index.name}`].filter(Boolean).join(' · ');
  $('.dq-last', dialog).textContent = fmt(q?.last ?? row.last, row.dp);
  const move = changeText(q?.changePct ?? null, false);
  const moved = $('.dq-chg', dialog);
  moved.textContent = q ? `${signed(q.change, q.dp).text} (${move.text})` : '';
  moved.className = `dq-chg ${move.dir}`;
  $('.dq-time', dialog).textContent = q ? [q.currency, 'latest session', timeLabel(q.time)].filter(Boolean).join(' · ') : '';

  drawChart();
  const body = $('#c-body');
  if (error) return body.replaceChildren(el('p', { class: 'd-note warn', text: `Could not load this company (${error}).` }));
  if (!data) return body.replaceChildren(el('p', { class: 'd-note', text: 'Loading the company\'s figures…' }));
  return body.replaceChildren(
    el('h3', { text: 'Key figures' }),
    el('dl', { class: 'd-stats' }, ...keyFigures(q)),
    el('p', { class: 'd-note', text: 'From the quote feed.' }),
    el('h3', { text: 'Financial statements' }),
    ...statements(data.filings),
  );
}
