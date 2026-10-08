import { hideTip, lineSvg, plotLine, showTip } from './chart.js';
import { initDetail, openDetail, renderDetail } from './detail.js';
import { changeOver, changeText, lineView, MODES, PERIOD_NAME, PERIOD_SHORT, PERIODS, setChange } from './periods.js';
import { $, el, fmt, getJson, signed, store, timeLabel } from './util.js';

const SPARK_REFRESH_MS = 180_000;
const BASES_REFRESH_MS = 600_000;
const SPARK = { w: 76, h: 30, pad: 4 };
const TILE_SPARK = { w: 200, h: 40, pad: 4 };
const FLASH_MS = 700;
// Shift lights on each tile: six per side, lit by the first change of the
// view. This is the move (in %) that lights all six.
const REV_LEDS = 6;
const REV_FULL = { '1d': 2, '6m': 25 };

// `mode` is the view (short or long term). `sparks` are the trend lines for
// `sparksFor`, the line period of the view they were loaded for. `bases` are
// the closing levels every period is measured from.
const state = { config: null, quotes: {}, sparks: {}, sparksFor: null, bases: {}, mode: 'short', lineRequest: 0, fetchedAt: null, intervalMs: 30_000, timer: null };

function duration(minutes) {
  const m = Math.max(0, Math.round(minutes));
  if (m >= 2880) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  if (m >= 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  return `${m}m`;
}

// ---- market sessions --------------------------------------------------------

const toMinutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

function zonedNow(tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    clock: `${parts.hour}:${parts.minute}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
  };
}

function minutesUntilOpen(now, open) {
  let days = 0;
  let dow = now.dow;
  const opensLaterToday = dow >= 1 && dow <= 5 && now.minutes < open;
  if (!opensLaterToday) {
    do { days++; dow = (dow + 1) % 7; } while (dow === 0 || dow === 6);
  }
  return days * 1440 + open - now.minutes;
}

function marketStatus(market, refQuote) {
  const now = zonedNow(market.tz);
  const sessions = market.sessions.map(([a, b]) => [toMinutes(a), toMinutes(b)]);
  const open = sessions[0][0];
  const close = sessions.at(-1)[1];
  const m = now.minutes;
  const weekday = now.dow >= 1 && now.dow <= 5;
  const closed = (detail) => ({ state: 'closed', label: 'Closed', detail, clock: now.clock });

  if (!weekday) return closed(`opens in ${duration(minutesUntilOpen(now, open))}`);
  // The reference index has not traded today well after the open: exchange holiday.
  if (refQuote?.date && refQuote.date < now.date && m >= open + 30) return closed('no session today');

  if (sessions.some(([a, b]) => m >= a && m < b)) return { state: 'open', label: 'Open', detail: `closes in ${duration(close - m)}`, clock: now.clock };
  if (m >= open && m < close) {
    const next = sessions.find(([a]) => a > m)[0];
    return { state: 'break', label: 'Lunch break', detail: `resumes in ${duration(next - m)}`, clock: now.clock };
  }
  if (market.pre && m >= toMinutes(market.pre[0]) && m < open) return { state: 'ext', label: 'Pre-market', detail: `opens in ${duration(open - m)}`, clock: now.clock };
  if (market.post && m >= close && m < toMinutes(market.post[1])) return { state: 'ext', label: 'After-hours', detail: `ends in ${duration(toMinutes(market.post[1]) - m)}`, clock: now.clock };
  return closed(`opens in ${duration(minutesUntilOpen(now, open))}`);
}

const statusOf = (id) => marketStatus(state.config.markets[id], state.quotes[state.config.markets[id].ref]);

// The move since the close, for an index whose exchange is shut: read by the
// server from a future or ETF that is still trading. Null while the exchange
// is open, or when that instrument has not traded since the bell.
function afterView(item, q) {
  if (!item.proxy || !item.market || !q?.after) return null;
  const { state: session } = statusOf(item.market);
  if (session === 'open' || session === 'break') return null;
  return { ...q.after, tag: item.proxy.tag, source: item.proxy.name };
}

function renderPills() {
  for (const pill of document.querySelectorAll('.pill')) {
    const market = state.config.markets[pill.dataset.market];
    const status = marketStatus(market, state.quotes[market.ref]);
    pill.dataset.state = status.state;
    pill.title = `${market.label} · ${status.clock} local time`;
    $('b', pill).textContent = market.short ? `${market.short}: ${status.label}` : status.label;
    $('.detail', pill).textContent = status.detail;
  }
  for (const tile of document.querySelectorAll('.tile[data-market]')) {
    const market = state.config.markets[tile.dataset.market];
    const status = marketStatus(market, state.quotes[market.ref]);
    tile.dataset.state = status.state;
    $('.dot', tile).title = `${status.label} · ${status.detail}`;
  }
}

// ---- building the page (once) -----------------------------------------------

// Every table shows four changes side by side: those of the selected view.
// Their headers are filled in by showMode. A yield moves in basis points
// rather than percent, and country tables trade the 52-week range for the
// move since the close.
const CHANGE_COLUMNS = [0, 1, 2, 3].map((slot) => ['', slot ? 'c-pct c-more' : 'c-pct', slot]);
const YIELD_DP = 3;
const columnsFor = (group) => [
  [group.yields ? 'Yield' : 'Last', 'c-last'],
  ...CHANGE_COLUMNS,
  ['', 'c-spark'],
  group.markets ? ['Since close', 'c-ext'] : ['52-wk range', 'c-range'],
];

function buildRow(item, sinceClose) {
  const tr = el('tr', { 'data-sym': item.symbol });
  tr.item = item;
  // The whole row opens the detail panel; the name is a real button so the
  // keyboard can reach it too.
  tr.addEventListener('click', () => openDetail(item));
  tr.append(
    el('th', { scope: 'row' },
      el('button', { type: 'button', class: 'nm open', text: item.name }),
      el('span', { class: 'sub', text: item.note || '' }),
      // Figures that move under the name where the card is too narrow for their columns.
      el('span', { class: 'sub oh' }),
      el('span', { class: 'sub multi' }),
    ),
    el('td', { class: 'c-last last', text: '—' }),
    ...CHANGE_COLUMNS.map(([, cls]) => el('td', { class: cls }, el('span', { class: 'chip na', text: '—' }))),
    el('td', { class: 'c-spark' }, lineSvg()),
  );
  if (sinceClose) {
    tr.append(el('td', { class: 'c-ext' }, el('span', { class: 'nm xp', text: '—' }), el('span', { class: 'sub xc' })));
  } else {
    const range = el('span', { class: 'range', tabindex: '0', role: 'img' }, el('i'));
    range.hidden = true;
    for (const type of ['pointerenter', 'focus']) range.addEventListener(type, onRangeShow);
    for (const type of ['pointerleave', 'blur']) range.addEventListener(type, hideTip);
    tr.append(el('td', { class: 'c-range' }, range));
  }
  return tr;
}

function buildPills(markets = []) {
  const pills = el('div', { class: 'pills' });
  for (const id of markets) {
    pills.append(el('span', { class: 'pill', 'data-market': id }, el('span', { class: 'dot' }), el('b'), el('span', { class: 'detail' })));
  }
  return pills;
}

function buildTable(group, repeatHeader) {
  // A country group names itself in a heading above the table, next to its
  // exchange status, so its header row only repeats the column labels.
  const headed = Boolean(group.markets);
  const silent = headed && repeatHeader;
  const head = el('tr', {}, el('th', { scope: 'col' }, el('span', { class: silent ? 'sr-only' : '', text: headed ? 'Index' : group.label })));
  for (const [label, cls, slot] of columnsFor(group)) {
    // Repeated column labels within a card stay available to screen readers only.
    const text = el('span', { class: repeatHeader ? 'sr-only' : '', text: label });
    if (slot != null) text.dataset.slot = slot;
    head.append(el('th', { scope: 'col', class: cls }, text));
  }
  const body = el('tbody');
  for (const item of group.items) body.append(buildRow(item, headed));
  const table = el('table', { class: headed ? 'quote after' : group.yields ? 'quote yields' : 'quote' }, el('thead', { class: silent ? 'silent' : '' }, head), body);
  if (!headed) return table;
  const fragment = document.createDocumentFragment();
  fragment.append(el('div', { class: 'group-head' }, el('h4', { text: group.label }), buildPills(group.markets)), table);
  return fragment;
}

function buildMatrix(group) {
  const head = el('tr', {}, el('th', { scope: 'col' }, el('span', { class: 'sr-only', text: 'Currency' })));
  const body = el('tbody');
  for (const row of group.items) {
    head.append(el('th', { scope: 'col', text: row.code, title: row.name }));
    const tr = el('tr', {}, el('th', { scope: 'row', text: row.code, title: row.name }));
    for (const col of group.items) tr.append(el('td', { class: row === col ? 'na' : '', text: row === col ? '1' : '—' }));
    body.append(tr);
  }
  const table = el('table', { class: 'matrix' }, el('caption', { text: group.label }), el('thead', {}, head), body);
  table.group = group;
  return el('div', { class: 'scroll' }, table);
}

// A headline instrument at the top of the page: name, value, change, trend.
function buildTile(item) {
  const revs = el('span', { class: 'revs', 'aria-hidden': 'true' });
  for (let i = 0; i < REV_LEDS * 2; i++) revs.append(el('i'));
  const tile = el('button', { type: 'button', class: 'tile', 'data-sym': item.symbol },
    revs,
    el('span', { class: 't-head' }, el('span', { class: 't-name', text: item.name }), el('span', { class: 'dot' })),
    el('span', { class: 't-value', text: '—' }),
    // The four changes of the selected view, each under its own label.
    el('span', { class: 't-moves' }, ...CHANGE_COLUMNS.map(() => el('span', { class: 't-move' }, el('small'), el('b', { class: 'na', text: '—' })))),
    el('span', { class: 't-after' }),
    lineSvg(),
  );
  tile.item = item;
  if (item.market) tile.dataset.market = item.market;
  tile.addEventListener('click', () => openDetail(item));
  return tile;
}

function build(config) {
  const main = $('#main');
  const items = new Map();
  for (const section of config.sections) {
    const cards = el('div', { class: 'cards' });
    for (const card of section.cards) {
      const article = el('article', { class: 'card' }, el('div', { class: 'card-head' }, el('h3', { text: card.title }), buildPills(card.markets)));
      card.groups.forEach((group, i) => {
        // What the detail panel and the overview need to know about each instrument.
        for (const item of group.items) {
          if (!item.symbol) continue;
          Object.assign(item, { index: Boolean(group.markets), market: item.market ?? group.markets?.[0], yield: Boolean(group.yields) });
          if (!items.has(item.symbol)) items.set(item.symbol, item);
        }
        article.append(group.kind === 'matrix' ? buildMatrix(group) : buildTable(group, i > 0));
      });
      cards.append(article);
    }
    main.append(el('section', { id: section.id }, el('h2', { text: section.title }), cards));
  }
  $('#tiles').append(...config.overview.filter((symbol) => items.has(symbol)).map((symbol) => buildTile(items.get(symbol))));
}

// ---- rendering quotes -------------------------------------------------------

function renderRow(tr) {
  const q = state.quotes[tr.dataset.sym];
  if (!q) return;
  const item = tr.item;
  const cells = tr.children;

  $('.sub', cells[0]).textContent = [item.note, q.contract, item.unit, timeLabel(q.time)].filter(Boolean).join(' · ');
  cells[0].title = q.fullName || '';
  flashOnChange(cells[1], q.last);
  cells[1].textContent = item.yield ? `${fmt(q.last, YIELD_DP)}%` : fmt(q.last, q.dp);
  const { periods } = MODES[state.mode];
  const moves = changesFor(item, q, periods);
  // The yield table's header carries the "bp", so its figures go without.
  moves.forEach((move, i) => setChange(cells[2 + i].firstChild, move, item.yield, true));
  // On a narrow card only the first change keeps its column; the rest sit under the name.
  $('.multi', cells[0]).replaceChildren(...moves.slice(1).flatMap((move, i) => {
    const { text, dir } = changeText(move, item.yield);
    return [i ? ' · ' : '', `${PERIOD_SHORT[periods[i + 1]]} `, el('b', { class: dir, text })];
  }));
  tr.pct = moves[0];
  tr.classList.toggle('is-up', cells[2].firstChild.classList.contains('up'));
  tr.classList.toggle('is-down', cells[2].firstChild.classList.contains('down'));

  if (cells[7].classList.contains('c-ext')) {
    const after = afterView(item, q);
    const { text, dir } = signed(after?.pct, 2, '%');
    const figure = $('.xp', cells[7]);
    figure.textContent = text;
    figure.className = `nm xp ${dir}`;
    $('.xc', cells[7]).replaceChildren(...(after ? [el('span', { class: 'badge', text: after.tag }), timeLabel(after.time) ?? ''] : []));
    cells[7].title = after
      ? `Since the close, read from ${after.source}. Implies about ${fmt(after.level, q.dp)}.`
      : 'Shown once the exchange has closed and its future or ETF has traded since';
    $('.oh', cells[0]).replaceChildren(...(after ? ['Since close ', el('b', { class: dir, text: text }), ` · ${after.tag}`] : []));
  } else {
    const range = $('.range', cells[7]);
    const valid = q.yrLow != null && q.yrHigh != null && q.yrHigh > q.yrLow;
    range.hidden = !valid;
    if (valid) {
      const pos = Math.min(1, Math.max(0, (q.last - q.yrLow) / (q.yrHigh - q.yrLow)));
      $('i', range).style.left = `calc(5px + ${pos.toFixed(4)} * (100% - 10px))`;
      range.dataset.tip = `52-wk low <b>${fmt(q.yrLow, q.dp)}</b> · high <b>${fmt(q.yrHigh, q.dp)}</b>`;
      range.setAttribute('aria-label', `52-week range ${fmt(q.yrLow, q.dp)} to ${fmt(q.yrHigh, q.dp)}, now at ${Math.round(pos * 100)}% of the range`);
    }
  }
  renderLine($('.spark', tr), q, SPARK);
}

// An instrument's change over each of the given periods.
function changesFor(item, q, periods) {
  return periods.map((period) => changeOver(period, q, state.bases[period]?.[item.symbol], item.yield));
}

// Draws the view's trend line for a quote. While the lines of a newly
// selected view are still loading, the old ones stay in place.
function renderLine(svg, q, size) {
  const { line } = MODES[state.mode];
  if (state.sparksFor !== line) return;
  const symbol = svg.closest('[data-sym]').dataset.sym;
  const view = lineView(line, state.sparks[symbol], q, state.fetchedAt);
  if (!plotLine(svg, { ...view, dp: q.dp }, size)) return;
  svg.setAttribute('aria-label', `${PERIOD_NAME[line]} trend, ${view.move > 0 ? 'up' : view.move < 0 ? 'down' : 'unchanged'} over the period`);
}

// Briefly tints a price cell when its value moves between refreshes.
function flashOnChange(cell, value) {
  const previous = cell.shown;
  cell.shown = value;
  if (previous == null || previous === value) return;
  cell.classList.remove('tick-up', 'tick-down');
  void cell.offsetWidth; // restart the animation if the last one is still running
  cell.classList.add(value > previous ? 'tick-up' : 'tick-down');
  setTimeout(() => cell.classList.remove('tick-up', 'tick-down'), FLASH_MS);
}

// Lights the strip outward from the centre: right for a gain, left for a loss.
// A move beyond the scale for the period turns the outermost light purple.
function renderRevs(strip, pct) {
  const full = REV_FULL[MODES[state.mode].periods[0]];
  const lit = pct ? Math.min(REV_LEDS, Math.ceil((Math.abs(pct) / full) * REV_LEDS)) : 0;
  const over = Math.abs(pct ?? 0) > full;
  [...strip.children].forEach((led, i) => {
    // Distance from the centre: 1 for the two middle lights, up to REV_LEDS at the ends.
    const step = i < REV_LEDS ? REV_LEDS - i : i - REV_LEDS + 1;
    const on = step <= lit && (pct > 0) === (i >= REV_LEDS);
    led.className = !on ? '' : over && step === REV_LEDS ? 'on-max' : pct > 0 ? 'on-up' : 'on-down';
  });
}

function renderTile(tile) {
  const q = state.quotes[tile.dataset.sym];
  if (!q) return;
  const item = tile.item;
  const value = $('.t-value', tile);
  flashOnChange(value, q.last);
  value.textContent = fmt(q.last, q.dp);
  const { periods } = MODES[state.mode];
  const moves = changesFor(item, q, periods);
  [...$('.t-moves', tile).children].forEach((slot, i) => {
    slot.firstChild.textContent = PERIOD_SHORT[periods[i]];
    setChange(slot.lastChild, moves[i], item.yield);
  });
  renderRevs($('.revs', tile), moves[0]);
  const after = afterView(item, q);
  const moved = signed(after?.pct, 2, '%');
  $('.t-after', tile).replaceChildren(...(after ? ['Since close ', el('b', { class: moved.dir, text: moved.text })] : []));
  $('.t-after', tile).title = after ? `Read from ${after.source}` : '';
  renderLine($('.spark', tile), q, TILE_SPARK);
}

const rateFormat = new Intl.NumberFormat('en-US', { minimumSignificantDigits: 5, maximumSignificantDigits: 5 });

function renderMatrix(table) {
  const currencies = table.group.items;
  // Value of one unit of each currency in dollars.
  const usd = currencies.map((c) => {
    if (!c.symbol) return 1;
    const last = state.quotes[c.symbol]?.last;
    if (!last) return null;
    return c.perUsd ? 1 / last : last;
  });
  [...table.tBodies[0].rows].forEach((tr, r) => {
    currencies.forEach((col, c) => {
      if (r === c) return;
      const cell = tr.cells[c + 1];
      const known = usd[r] != null && usd[c] != null;
      cell.textContent = known ? rateFormat.format(usd[r] / usd[c]) : '—';
      cell.title = known ? `1 ${currencies[r].code} = ${cell.textContent} ${col.code}` : '';
    });
  });
}

function render() {
  for (const tr of document.querySelectorAll('tr[data-sym]')) renderRow(tr);
  for (const tile of document.querySelectorAll('.tile')) renderTile(tile);
  for (const table of document.querySelectorAll('table.quote')) markBest(table);
  for (const table of document.querySelectorAll('table.matrix')) renderMatrix(table);
  renderPills();
  renderDetail();
}

// Purple marks the best gainer in each table, like the fastest lap on a timing screen.
function markBest(table) {
  const rows = [...table.tBodies[0].rows];
  // A rising yield is not a "best performer", so yield tables are left alone.
  const best = rows.length > 1 && !table.classList.contains('yields') ? rows.reduce((a, b) => ((b.pct ?? -Infinity) > (a.pct ?? -Infinity) ? b : a)) : null;
  for (const tr of rows) {
    const chip = $('.chip', tr);
    const isBest = tr === best && chip.classList.contains('up');
    chip.classList.toggle('best', isBest);
    chip.title = isBest ? 'Best performer in this table' : '';
  }
}

// What the detail panel needs to know about an instrument right now.
function detailContext(item) {
  const quote = state.quotes[item.symbol];
  return { quote, changes: quote && changesFor(item, quote, PERIODS), after: afterView(item, quote), mode: state.mode, fetchedAt: state.fetchedAt };
}

function onRangeShow(event) {
  const box = event.currentTarget.getBoundingClientRect();
  showTip(event.currentTarget.dataset.tip, box.left + box.width / 2, box.top);
}

// ---- data refresh -----------------------------------------------------------

// The dot beside the "Updated" time: live, paused, or showing old data.
function setStatus(text) {
  const status = $('#updated');
  status.dataset.state = text ? (state.intervalMs ? 'live' : 'paused') : 'stale';
  if (text) $('span', status).textContent = text;
}

function showBanner(message) {
  const banner = $('#banner');
  banner.hidden = !message;
  banner.textContent = message || '';
}

async function refreshQuotes() {
  try {
    const data = await getJson('/api/quotes');
    // A symbol missing from this refresh keeps its last known quote.
    state.quotes = { ...state.quotes, ...data.quotes };
    state.fetchedAt = data.fetchedAt;
    showBanner(data.error ? `Showing the last quotes received. The data provider is not responding (${data.error}).` : null);
    render();
    setStatus(`${data.error ? 'Last update' : 'Updated'} ${new Date(data.fetchedAt).toLocaleTimeString([], { hourCycle: 'h23' })}`);
    if (data.error) setStatus(null);
  } catch (err) {
    showBanner(`Could not load quotes (${err.message}). Retrying automatically.`);
    setStatus(null);
  }
}

// Loads the trend lines for the current view. Until they arrive the previous
// lines stay on screen, dimmed.
async function loadLines({ quiet = false } = {}) {
  const request = ++state.lineRequest;
  const { line } = MODES[state.mode];
  if (!quiet) document.body.classList.add('loading');
  try {
    const data = await getJson(`/api/sparks?range=${line}`);
    if (request !== state.lineRequest) return;
    state.sparks = data.sparks;
    state.sparksFor = line;
    render();
  } catch (err) {
    // A background refresh can fail silently; the quote banner already reports provider trouble.
    if (!quiet && request === state.lineRequest) showBanner(`Could not load the ${PERIOD_NAME[line]} trend lines (${err.message}).`);
  } finally {
    if (request === state.lineRequest) document.body.classList.remove('loading');
  }
}

// Switches between the short-term and long-term view. The figures change at
// once (their reference levels are already loaded); the lines follow.
function showMode(mode) {
  state.mode = mode;
  store('mode', mode);
  const { periods, line } = MODES[mode];
  for (const button of document.querySelectorAll('#modes button')) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  for (const label of document.querySelectorAll('thead [data-slot]')) {
    const bp = label.closest('table').classList.contains('yields') ? ' bp' : '';
    label.textContent = PERIOD_SHORT[periods[label.dataset.slot]] + bp;
  }
  for (const label of document.querySelectorAll('thead .c-spark span')) label.textContent = PERIOD_NAME[line];
  render();
  loadLines();
}

// The closing levels behind every change. On a cold start the server is
// still collecting them, so try again shortly.
async function refreshBases() {
  try {
    state.bases = (await getJson('/api/bases')).bases;
    render();
  } catch {
    if (!state.bases['1w']) setTimeout(refreshBases, 15_000);
  }
}

function schedule() {
  clearTimeout(state.timer);
  if (!state.intervalMs) return;
  state.timer = setTimeout(async () => {
    if (!document.hidden) await refreshQuotes();
    schedule();
  }, state.intervalMs);
}

// ---- controls ---------------------------------------------------------------

const THEMES = ['auto', 'light', 'dark'];

function applyTheme(theme) {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  $('#theme').textContent = `Theme: ${theme}`;
  store('theme', theme === 'auto' ? null : theme);
}

// Highlights the section in view in the navigation bar: the last one whose
// heading has passed the top third of the window, or the final section once
// the page is scrolled to the end (it may be too short to get that high).
function initTabs() {
  const links = [...document.querySelectorAll('.tabs a')];
  const sections = [...document.querySelectorAll('#main > section')];
  let queued = false;
  const mark = () => {
    queued = false;
    const atEnd = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
    const passed = sections.filter((section) => section.getBoundingClientRect().top <= innerHeight / 3);
    const current = atEnd ? sections.at(-1) : passed.at(-1) ?? sections[0];
    for (const link of links) {
      if (link.hash === `#${current.id}`) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    }
  };
  addEventListener('scroll', () => {
    if (!queued) requestAnimationFrame(mark);
    queued = true;
  }, { passive: true });
  mark();
}

function initControls() {
  for (const [mode, { label }] of Object.entries(MODES)) {
    $('#modes').append(el('button', { type: 'button', 'data-mode': mode, 'aria-pressed': 'false', text: label }));
  }
  $('#modes').addEventListener('click', (event) => {
    const mode = event.target.closest('button')?.dataset.mode;
    if (mode && mode !== state.mode) showMode(mode);
  });

  const theme = $('#theme');
  applyTheme(document.documentElement.dataset.theme || 'auto');
  theme.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme || 'auto';
    applyTheme(THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]);
  });

  const interval = $('#interval');
  const saved = store('interval');
  if (saved != null && [...interval.options].some((o) => o.value === saved)) interval.value = saved;
  state.intervalMs = Number(interval.value);
  interval.addEventListener('change', () => {
    state.intervalMs = Number(interval.value);
    store('interval', interval.value);
    $('#updated').dataset.state = state.intervalMs ? 'live' : 'paused';
    schedule();
  });

  $('#refresh').addEventListener('click', async () => {
    await refreshQuotes();
    schedule();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.intervalMs) refreshQuotes();
  });
}

async function init() {
  initControls();
  initDetail(detailContext);
  try {
    state.config = await getJson('/api/config');
  } catch (err) {
    showBanner(`Could not reach the dashboard server (${err.message}). Start it with "npm start".`);
    return;
  }
  build(state.config);
  initTabs();
  renderPills();
  await refreshQuotes();
  schedule();
  showMode(store('mode') in MODES ? store('mode') : 'short');
  refreshBases();
  setInterval(() => loadLines({ quiet: true }), SPARK_REFRESH_MS);
  setInterval(refreshBases, BASES_REFRESH_MS);
  setInterval(renderPills, 15_000);
}

init();
