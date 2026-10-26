// Small helpers shared by the dashboard and its panels.

export const $ = (sel, root = document) => root.querySelector(sel);

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

export function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
  return null;
}

export async function getJson(url, signal) {
  const res = await fetch(url, { cache: 'no-store', signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// Sends a change to the server. Sent as JSON, which is also what the server
// checks to know the request came from this page.
export async function postJson(url, payload) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// ---- formatting -------------------------------------------------------------

const formatters = new Map();
export function fmt(value, dp = 2) {
  if (value == null) return '—';
  if (!formatters.has(dp)) formatters.set(dp, new Intl.NumberFormat('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }));
  return formatters.get(dp).format(value);
}

// Direction is judged on the rounded value so "+0.00" never shows as a move.
export function signed(value, dp = 2, suffix = '') {
  if (value == null) return { text: '—', dir: 'na' };
  const rounded = Number(value.toFixed(dp));
  const body = fmt(Math.abs(rounded), dp) + suffix;
  if (rounded > 0) return { text: `+${body}`, dir: 'up' };
  if (rounded < 0) return { text: `−${body}`, dir: 'down' };
  return { text: body, dir: 'flat' };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Provider times look like "7:32 AM EDT" (traded today) or "09/30/26 EDT" (last close).
export function timeLabel(text) {
  if (!text) return null;
  const clock = /^(\d{1,2}):(\d{2}) (AM|PM) (\S+)$/.exec(text);
  if (clock) {
    const hour = (Number(clock[1]) % 12) + (clock[3] === 'PM' ? 12 : 0);
    return `${String(hour).padStart(2, '0')}:${clock[2]} ${clock[4]}`;
  }
  const date = /^(\d{2})\/(\d{2})\/\d{2}/.exec(text);
  if (date) return `${Number(date[2])} ${MONTHS[Number(date[1]) - 1]} close`;
  return text;
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const EXTENDED = { PRE: 'Pre-market', POST: 'After-hours' };

// Pre-market or after-hours trading, under the session's price in a panel's
// heading: the price, its change from where the session left off, and the
// time and volume. Hidden when there is none (see normalizeQuote in server.js).
export function renderExtended(line, q) {
  const ext = q?.ext;
  line.hidden = !ext;
  if (!ext) return;
  const pct = signed(ext.changePct, 2, '%');
  line.replaceChildren(
    el('span', { class: 'dot' }),
    el('b', { text: EXTENDED[ext.type?.split('_')[0]] ?? 'Extended hours' }),
    el('span', { class: 'dx-last', text: fmt(ext.last, q.dp) }),
    el('span', { class: `dx-chg ${pct.dir}`, text: `${signed(ext.change, q.dp).text} (${pct.text})` }),
    el('span', { class: 'dq-time', text: [timeLabel(ext.time), ext.volume != null && `volume ${compact.format(ext.volume)}`].filter(Boolean).join(' · ') }),
  );
}
