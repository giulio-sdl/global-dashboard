// The search box in the header: type a symbol or a name, pick a match, and
// it opens in the company panel with its chart, P/E and financials. Enter
// opens the highlighted match, else the first, else the text as a symbol. "/"
// anywhere on the page puts the cursor in the box. A search the server could
// not answer is said to have failed, not to have found nothing, and is asked
// again while the box is in use.
import { openCompany } from './company.js';
import { $, el, getJson } from './util.js';

const WAIT_MS = 150; // typing pauses this long before the server is asked
const RETRY_MS = 5_000; // a failed search is asked again after this
const OPENS_ON = '5y'; // long enough for the P/E line to say something
const TYPES = { STOCK: 'Share', CSRT: 'Share', ETF: 'ETF', ETN: 'ETN', FUND: 'Fund', INDEX: 'Index', DERIVATIVE: 'Future', WT: 'Warrant' };

const input = $('#search');
const list = $('#search-results');
let results = [];
let searched = ''; // the text the results are for
let failed = false; // the server could not answer for `searched`
let active = -1; // the highlighted match
let timer = null;
let request = null;

export function initSearch() {
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(find, WAIT_MS);
  });
  input.addEventListener('keydown', onKey);
  input.addEventListener('focus', () => {
    if (failed) find();
    else if (results.length) show(true);
  });
  input.addEventListener('blur', () => show(false));
  // A press on a match must not take the focus from the box first.
  list.addEventListener('pointerdown', (event) => event.preventDefault());
  list.addEventListener('click', (event) => {
    const option = event.target.closest('[role="option"]');
    if (option) pick(results[Number(option.dataset.i)]);
  });
  document.addEventListener('keydown', (event) => {
    const typing = event.target.closest?.('input, select, textarea, [contenteditable]');
    if (event.key !== '/' || typing || event.metaKey || event.ctrlKey || event.altKey || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    input.focus();
    input.select();
  });
}

async function find() {
  const text = input.value.trim();
  clearTimeout(timer);
  request?.abort();
  if (!text) {
    results = [];
    searched = '';
    failed = false;
    render();
    return;
  }
  request = new AbortController();
  try {
    const answer = await getJson(`/api/search?q=${encodeURIComponent(text)}`, request.signal);
    if (input.value.trim() !== text) return; // typed on since
    results = answer.results;
    failed = false;
  } catch (err) {
    if (err.name === 'AbortError' || input.value.trim() !== text) return;
    results = [];
    failed = true;
  }
  searched = text;
  render();
  if (failed && document.activeElement === input) timer = setTimeout(find, RETRY_MS);
}

function render() {
  active = -1;
  list.replaceChildren(...results.map((result, i) => el('li', { role: 'option', id: `search-${i}`, 'data-i': String(i), 'aria-selected': 'false' },
    el('b', { text: result.symbol }),
    el('span', { text: result.name }),
    el('small', { text: [TYPES[result.type] ?? null, result.exchange].filter(Boolean).join(' · ') }))));
  // Nothing found is said, so Enter's meaning (the text as a symbol) is clear.
  const typed = input.value.trim();
  if (!results.length && typed) list.append(el('li', { class: 'none', text: `${failed ? 'The search is not answering just now.' : 'No matches.'} Enter opens ${typed.toUpperCase()} as a symbol.` }));
  show(document.activeElement === input);
}

function show(on) {
  const open = on && list.children.length > 0;
  list.hidden = !open;
  input.setAttribute('aria-expanded', String(open));
}

function highlight(i) {
  active = i;
  for (const option of list.querySelectorAll('[role="option"]')) option.setAttribute('aria-selected', String(Number(option.dataset.i) === i));
  const option = $(`#search-${i}`);
  if (option) {
    input.setAttribute('aria-activedescendant', option.id);
    option.scrollIntoView({ block: 'nearest' });
  } else input.removeAttribute('aria-activedescendant');
}

function onKey(event) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!results.length) return;
    event.preventDefault();
    show(true);
    // Round the matches and back to the text as typed (-1).
    const count = results.length + 1;
    highlight(((active + 1 + (event.key === 'ArrowDown' ? 1 : -1) + count) % count) - 1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    enter();
  } else if (event.key === 'Escape') {
    if (!list.hidden) {
      event.preventDefault();
      show(false);
    } else if (input.value) {
      event.preventDefault();
      input.value = '';
      results = [];
      render();
    }
  }
}

// Enter opens the highlighted match, else the first, else the text as a
// symbol. Matches for what was typed before do not count: those for the text
// now are waited for.
async function enter() {
  const text = input.value.trim();
  if (!text) return;
  if (active < 0 && searched !== text) {
    clearTimeout(timer);
    await find();
    if (input.value.trim() !== text) return;
  }
  pick(results[active] ?? results[0] ?? { symbol: text.toUpperCase(), name: text.toUpperCase() });
}

function pick(result) {
  clearTimeout(timer);
  request?.abort();
  show(false);
  input.blur();
  openCompany(null, result, OPENS_ON);
}
