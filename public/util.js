// Small helpers shared by the dashboard and the index detail panel.

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

export async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
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
