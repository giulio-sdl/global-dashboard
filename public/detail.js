// The panel that opens when a row or tile is clicked: the instrument's own
// figures, its change over every period, a larger chart whose period can be
// chosen and, for an index whose weights are available, what its
// constituents did in the latest session.
import { lineSvg, plotLine, pointLabel } from './chart.js';
import { changeText, lineView, PERIOD_NAME, PERIOD_SHORT, PERIODS } from './periods.js';
import { $, el, fmt, getJson, signed, timeLabel } from './util.js';

const REFRESH_MS = 60_000;
const LINES_TTL_MS = 180_000;
// The chart opens on the shortest period of the dashboard's current view.
const FIRST_CHART = { short: '1d', long: '6m' };
const MOVERS_SHOWN = 8;
const ROWS_SHOWN = 25;
const CHART = { h: 170, pad: 10 };

// The rev counter sweeps 240 degrees, from the 52-week low to the high.
const TACH_SWEEP = 240;
const TACH_REDLINE = 0.85;

const dialog = $('#detail');
const chart = lineSvg('spark big');
const tach = buildTach();
let getContext = () => ({});
let open = null; // the instrument on show: { item, period, detail, error, sort, showAll }
let timer = null;
const lines = new Map(); // chart period → { at, sparks }: the lines fetched for the chart

// A point on the dial: `at` runs 0 to 1 along the sweep, `r` is the radius.
function dialPoint(at, r) {
  const angle = ((at - 0.5) * TACH_SWEEP * Math.PI) / 180;
  return [100 + r * Math.sin(angle), 100 - r * Math.cos(angle)].map((n) => n.toFixed(1));
}

function buildTach() {
  const ticks = Array.from({ length: 21 }, (_, i) => {
    const major = i % 2 === 0;
    const [x1, y1] = dialPoint(i / 20, 85);
    const [x2, y2] = dialPoint(i / 20, major ? 72 : 79);
    return `<line class="tick${major ? ' major' : ''}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  }).join('');
  const [rx1, ry1] = dialPoint(TACH_REDLINE, 82);
  const [rx2, ry2] = dialPoint(1, 82);
  const [lx, ly] = dialPoint(0, 58);
  const [hx, hy] = dialPoint(1, 58);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'tach');
  svg.setAttribute('viewBox', '0 0 200 200');
  svg.setAttribute('role', 'img');
  svg.innerHTML = `
    <circle class="bezel" cx="100" cy="100" r="99"/>
    <circle class="face" cx="100" cy="100" r="91"/>
    <path class="redline" d="M${rx1},${ry1} A82,82 0 0 1 ${rx2},${ry2}"/>
    ${ticks}
    <text x="${lx}" y="${ly}">LOW</text>
    <text x="${hx}" y="${hy}">HIGH</text>
    <text class="readout" x="100" y="156"></text>
    <text class="unit" x="100" y="170">OF 52-WK RANGE</text>
    <g class="needle" style="transform: rotate(${-TACH_SWEEP / 2}deg)"><polygon points="100,24 96,100 104,100"/></g>
    <circle class="hub" cx="100" cy="100" r="9"/>`;
  return svg;
}

// Points the needle at where the price sits between its 52-week low and high.
function renderTach(q) {
  const valid = q.yrLow != null && q.yrHigh != null && q.yrHigh > q.yrLow;
  tach.toggleAttribute('hidden', !valid);
  if (!valid) return;
  const at = Math.min(1, Math.max(0, (q.last - q.yrLow) / (q.yrHigh - q.yrLow)));
  $('.needle', tach).style.transform = `rotate(${((at - 0.5) * TACH_SWEEP).toFixed(1)}deg)`;
  $('.readout', tach).textContent = `${Math.round(at * 100)}%`;
  tach.setAttribute('aria-label', `At ${Math.round(at * 100)}% of the 52-week range, ${fmt(q.yrLow, q.dp)} to ${fmt(q.yrHigh, q.dp)}`);
}

export function initDetail(context) {
  getContext = context;
  $('.d-plot', dialog).prepend(chart);
  $('.d-tach', dialog).append(tach);
  $('#detail-close').addEventListener('click', () => dialog.close());
  // A click on the backdrop lands on the dialog element itself.
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    clearInterval(timer);
    open = null;
  });
  new ResizeObserver(() => renderDetail()).observe($('.d-plot', dialog));

  // The chart's own period buttons, independent of the dashboard's view.
  const periods = $('#chart-periods');
  for (const period of PERIODS) periods.append(el('button', { type: 'button', 'data-period': period, 'aria-pressed': 'false', title: PERIOD_NAME[period], text: PERIOD_SHORT[period] }));
  periods.addEventListener('click', (event) => {
    const period = event.target.closest('button')?.dataset.period;
    if (period && open) showChart(period);
  });
}

// Switches the chart to a period, fetching its lines if they are not at hand.
async function showChart(period) {
  open.period = period;
  for (const button of document.querySelectorAll('#chart-periods button')) button.setAttribute('aria-pressed', String(button.dataset.period === period));
  renderDetail();
  if (Date.now() - (lines.get(period)?.at ?? 0) < LINES_TTL_MS) return;
  $('.d-plot', dialog).classList.add('loading');
  try {
    lines.set(period, { at: Date.now(), sparks: (await getJson(`/api/sparks?range=${period}`)).sparks });
  } catch {
    // The chart area says there is no data; the figures above it are unaffected.
  }
  $('.d-plot', dialog).classList.remove('loading');
  renderDetail();
}

export function openDetail(item) {
  open = { item, period: null, detail: null, error: null, sort: { key: 'weight', dir: -1 }, showAll: false };
  $('#detail-title').textContent = item.name || item.symbol;
  dialog.showModal();
  dialog.scrollTop = 0;
  showChart(FIRST_CHART[getContext(item).mode]);
  renderConstituents();
  clearInterval(timer);
  if (item.holdings) {
    loadConstituents();
    timer = setInterval(loadConstituents, REFRESH_MS);
  }
}

async function loadConstituents() {
  const shown = open;
  try {
    const { detail } = await getJson(`/api/index?symbol=${encodeURIComponent(shown.item.symbol)}`);
    if (open !== shown) return;
    shown.detail = analyse(detail);
    shown.error = null;
  } catch (err) {
    if (open !== shown) return;
    shown.error = err.message;
  }
  renderDetail();
  renderConstituents();
}

// ---- the index itself -------------------------------------------------------

function stat(label, value) {
  return el('div', {}, el('dt', { text: label }), el('dd', { text: value }));
}

// Re-drawn on every dashboard refresh, so the panel stays live while open.
export function renderDetail() {
  if (!open) return;
  const { quote: q, changes, after, fetchedAt } = getContext(open.item);
  if (!q) return;

  const names = [q.fullName, open.item.note, open.item.unit].filter((text) => text && text !== open.item.name);
  $('.d-sub', dialog).textContent = names.join(' · ');
  // A yield is quoted in percent, and its move in basis points.
  const isYield = open.item.yield;
  const price = (value) => (isYield && value != null ? `${fmt(value, 3)}%` : fmt(value, q.dp));
  $('.dq-last', dialog).textContent = price(q.last);
  const today = changeText(changes[0], isYield);
  const move = $('.dq-chg', dialog);
  move.textContent = isYield ? today.text : `${signed(q.change, q.dp).text} (${today.text})`;
  move.className = `dq-chg ${today.dir}`;
  $('.dq-time', dialog).textContent = ['latest session', timeLabel(q.time)].filter(Boolean).join(' · ');

  const range = (low, high) => (low != null && high != null ? `${price(low)} – ${price(high)}` : '—');
  const stats = [
    stat('Previous close', price(q.prevClose)),
    stat('Day range', range(q.low, q.high)),
    stat('52-week range', range(q.yrLow, q.yrHigh)),
  ];
  if (after) stats.push(stat(`Since close · ${after.tag}`, `${signed(after.pct, 2, '%').text}, about ${fmt(after.level, q.dp)}`));
  const d = open.detail;
  if (d) {
    stats.push(stat('Ten largest', `${fmt(d.topTen, 1)}% of index`));
    if (d.session !== 'awaiting') {
      stats.push(stat('Rising / falling', `${d.rising} / ${d.falling}`), stat('Constituents, weighted', signed(d.weightedMove, 2, '%').text));
    }
  }
  $('.d-stats', dialog).replaceChildren(...stats);
  renderTach(q);

  // The change over every period, short term to long term.
  $('.d-perf', dialog).replaceChildren(...PERIODS.map((period, i) => {
    const { text, dir } = changeText(changes[i], isYield);
    return el('div', {}, el('dt', { text: PERIOD_SHORT[period] }), el('dd', { class: dir, text }));
  }));

  const plot = $('.d-plot', dialog);
  const view = lineView(open.period, lines.get(open.period)?.sparks[open.item.symbol], q, fetchedAt);
  const drawn = plotLine(chart, { ...view, dp: q.dp }, { w: Math.max(240, plot.clientWidth), ...CHART });
  chart.setAttribute('aria-label', `${open.item.name || open.item.symbol}, ${PERIOD_NAME[open.period]} chart`);
  $('.d-chart figcaption', dialog).textContent = drawn ? `Price, ${PERIOD_NAME[open.period].toLowerCase()}` : 'No chart data for this period';
  $('.d-hi', dialog).textContent = drawn ? fmt(drawn.hi, q.dp) : '';
  $('.d-lo', dialog).textContent = drawn ? fmt(drawn.lo, q.dp) : '';
  $('.d-from', dialog).textContent = drawn ? pointLabel(view.t[0], view.step) : '';
  $('.d-to', dialog).textContent = drawn ? pointLabel(view.t.at(-1), view.step) : '';
}

// ---- its constituents -------------------------------------------------------

// Adds each constituent's contribution to the index move (weight × change, in
// percentage points) and the totals the panel reports.
function analyse(detail) {
  const rows = detail.constituents.map((c) => ({ ...c, contribution: c.changePct == null ? null : (c.weight * c.changePct) / 100 }));
  const quoted = rows.filter((r) => r.contribution != null);
  const sum = (list, key) => list.reduce((total, r) => total + r[key], 0);
  const direction = (r) => signed(r.changePct, 2).dir;

  const sectors = new Map();
  for (const r of rows) {
    const s = sectors.get(r.sector) ?? sectors.set(r.sector, { name: r.sector, weight: 0, contribution: 0 }).get(r.sector);
    s.weight += r.weight;
    s.contribution += r.contribution ?? 0;
  }

  const quotedWeight = sum(quoted, 'weight');
  return {
    ...detail,
    rows,
    rising: quoted.filter((r) => direction(r) === 'up').length,
    falling: quoted.filter((r) => direction(r) === 'down').length,
    topTen: sum(rows.slice(0, 10), 'weight'),
    // Scaled to the quoted share, so missing quotes do not shrink the figure.
    weightedMove: quotedWeight ? (sum(quoted, 'contribution') / quotedWeight) * 100 : null,
    coverage: (quotedWeight / sum(rows, 'weight')) * 100,
    lifted: quoted.filter((r) => r.contribution > 0).sort((a, b) => b.contribution - a.contribution).slice(0, MOVERS_SHOWN),
    dragged: quoted.filter((r) => r.contribution < 0).sort((a, b) => a.contribution - b.contribution).slice(0, MOVERS_SHOWN),
    sectors: [...sectors.values()].sort((a, b) => b.contribution - a.contribution),
  };
}

const points = (value) => `${signed(value, 3).text} pp`;

function moverList(title, rows, scale) {
  const list = el('ol', { class: 'movers' });
  for (const r of rows) {
    const chg = signed(r.changePct, 2, '%');
    const bar = el('i', { class: r.contribution > 0 ? 'up' : 'down' });
    bar.style.width = `${Math.max(1.5, (Math.abs(r.contribution) / scale) * 100)}%`;
    list.append(el('li', {},
      el('span', { class: 'mv-name' }, el('b', { text: r.name }), el('small', { text: `${r.ticker} · ${fmt(r.weight, 2)}% of index` })),
      el('span', { class: `mv-chg ${chg.dir}`, text: chg.text }),
      el('span', { class: 'mv-bar' }, bar),
      el('span', { class: 'mv-val', text: points(r.contribution) }),
    ));
  }
  if (!rows.length) list.append(el('li', { class: 'none', text: 'None in the latest session' }));
  return el('div', {}, el('h4', { text: title }), list);
}

function sectorList(sectors) {
  const scale = Math.max(...sectors.map((s) => Math.abs(s.contribution))) || 1;
  const list = el('ol', { class: 'movers sectors' });
  for (const s of sectors) {
    // Bars grow right of the centre line for a lift, left of it for a drag.
    const bar = el('i', { class: s.contribution >= 0 ? 'up' : 'down' });
    bar.style.width = `${(Math.abs(s.contribution) / scale) * 50}%`;
    list.append(el('li', {},
      el('span', { class: 'mv-name' }, el('b', { text: s.name })),
      el('span', { class: 'mv-chg', text: `${fmt(s.weight, 1)}%` }),
      el('span', { class: 'mv-bar centred' }, bar),
      el('span', { class: 'mv-val', text: points(s.contribution) }),
    ));
  }
  return list;
}

const COLUMNS = [
  { key: 'name', label: 'Constituent', text: true },
  { key: 'sector', label: 'Sector', text: true, cls: 'd-sector' },
  { key: 'weight', label: 'Weight' },
  { key: 'last', label: 'Last', fixed: true, cls: 'd-last' },
  { key: 'changePct', label: 'Chg %' },
  { key: 'contribution', label: 'Contribution' },
];

function constituentTable(d) {
  const { key, dir } = open.sort;
  const sorted = [...d.rows].sort((a, b) => {
    // Constituents without a quote always sink to the bottom.
    if (a[key] == null || b[key] == null) return (a[key] == null) - (b[key] == null);
    return (typeof a[key] === 'string' ? a[key].localeCompare(b[key]) : a[key] - b[key]) * dir;
  });
  const shown = open.showAll ? sorted : sorted.slice(0, ROWS_SHOWN);

  const head = el('tr');
  for (const column of COLUMNS) {
    const active = column.key === key;
    const th = el('th', { scope: 'col', class: column.cls || '', 'aria-sort': active ? (dir > 0 ? 'ascending' : 'descending') : 'none' });
    if (column.fixed) th.textContent = column.label;
    else {
      const button = el('button', { type: 'button', text: `${column.label}${active ? (dir > 0 ? ' ↑' : ' ↓') : ''}` });
      button.addEventListener('click', () => {
        // Text columns start A to Z, numbers start largest first.
        open.sort = { key: column.key, dir: active ? -dir : column.text ? 1 : -1 };
        renderConstituents();
      });
      th.append(button);
    }
    head.append(th);
  }

  const body = el('tbody');
  for (const r of shown) {
    const chg = signed(r.changePct, 2, '%');
    body.append(el('tr', {},
      el('th', { scope: 'row' }, el('span', { class: 'nm', text: r.name }), el('span', { class: 'sub', text: r.ticker })),
      el('td', { class: 'd-sector', text: r.sector }),
      el('td', { text: `${fmt(r.weight, 2)}%` }),
      el('td', { class: 'd-last', text: r.last == null ? '—' : fmt(r.last, r.dp) }),
      el('td', { class: chg.dir, text: chg.text }),
      el('td', { text: r.contribution == null ? '—' : points(r.contribution) }),
    ));
  }

  const parts = [el('table', { class: 'd-table' }, el('thead', {}, head), body)];
  if (d.rows.length > ROWS_SHOWN) {
    const toggle = el('button', { type: 'button', class: 'control', text: open.showAll ? `Show top ${ROWS_SHOWN} only` : `Show all ${d.rows.length}` });
    toggle.addEventListener('click', () => {
      open.showAll = !open.showAll;
      renderConstituents();
    });
    parts.push(toggle);
  }
  return parts;
}

function renderConstituents() {
  const box = $('#d-constituents');
  const note = (text) => box.replaceChildren(el('p', { class: 'd-note', text }));
  if (!open.item.index) return box.replaceChildren(); // only indexes have constituents
  if (!open.item.holdings) return note('Constituents and weights are not available for this index from the data sources this dashboard uses.');
  const d = open.detail;
  if (!d) return note(open.error ? `Could not load the constituents (${open.error}).` : 'Loading constituents…');

  const scale = Math.max(...[...d.lifted, ...d.dragged].map((r) => Math.abs(r.contribution))) || 1;
  // Just before the open the feed clears every stock's change, so there is no session to break down yet.
  const movers = d.session === 'awaiting'
    ? [el('p', { class: 'd-note', text: 'The new session has not started and the data feed has already cleared the previous session\'s changes. The movers will appear once trading begins.' })]
    : [
      el('p', { class: 'd-note', text: `${d.session === 'previous' ? 'Previous session; the new one has not started.' : 'Latest session.'} Contribution is index weight × price change, in percentage points (pp) of the index.` }),
      el('div', { class: 'd-cols' }, moverList('Lifted it most', d.lifted, scale), moverList('Dragged it most', d.dragged, scale)),
      el('h3', { text: 'By sector' }),
      sectorList(d.sectors),
    ];
  box.replaceChildren(
    el('h3', { text: 'What moved the index' }),
    ...movers,
    el('h3', { text: 'Constituents' }),
    ...constituentTable(d),
    el('p', { class: 'd-note', text: `Weights are those of the ${d.etf}, which tracks the index, as of ${d.asOf}. Live quotes cover ${fmt(d.coverage, 1)}% of the index by weight.` }),
  );
}
