// The line chart used for row sparklines and for the larger chart in the
// detail panel, plus the tooltip they share.
import { $, fmt, signed } from './util.js';

// ---- tooltip ----------------------------------------------------------------

const tip = $('#tip');

export function showTip(html, x, y) {
  // An open dialog sits in the browser's top layer; the tooltip has to live
  // inside it to be drawn above it.
  const host = $('dialog[open]') || document.body;
  if (tip.parentNode !== host) host.append(tip);
  tip.innerHTML = html;
  tip.hidden = false;
  const box = tip.getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(x - box.width / 2, innerWidth - box.width - 8))}px`;
  tip.style.top = `${y - box.height - 10 < 8 ? y + 18 : y - box.height - 10}px`;
}

export function hideTip() {
  tip.hidden = true;
}

// ---- line chart -------------------------------------------------------------

// An empty chart: reference line, the line itself, an end marker, and the
// crosshair and probe shown on hover. `second` makes room for a second line
// laid over the first (see plotLine).
export function lineSvg(className = 'spark', second = false) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('role', 'img');
  svg.innerHTML = `<line class="base"/>${second ? '<path class="line2"/>' : ''}<path class="line"/><circle class="end" r="3"/><line class="cross" hidden/><circle class="probe" r="3.5" hidden/>${second ? '<circle class="probe2" r="3.5" hidden/>' : ''}`;
  svg.setAttribute('hidden', ''); // SVG elements have no .hidden property
  svg.addEventListener('pointermove', onHover);
  svg.addEventListener('pointerleave', onLeave);
  return svg;
}

// A second line rebased to start where the first does: at the first point
// both have, it is multiplied up or down to the first line's value there.
function rebase(c, values) {
  const start = values.findIndex((value, i) => value > 0 && c[i] > 0);
  if (start < 0) return null;
  const scale = c[start] / values[start];
  return values.map((value) => (value == null ? null : value * scale));
}

// Where a list peaks and bottoms out, nulls aside: [index of the high, of the low].
function extremes(list) {
  let high = -1;
  let low = -1;
  list.forEach((value, i) => {
    if (value == null) return;
    if (high < 0 || value > list[high]) high = i;
    if (low < 0 || value < list[low]) low = i;
  });
  return [high, low];
}

// Draws a series into a chart made by lineSvg. `series` is { t, c, base, move,
// step, dp }: times, values, the level the change is measured from, the
// direction that colours the line, and the bar size ('minute', 'hour', 'day'
// or 'week'). Returns the value range drawn, or null when there is no line.
//
// `series.second` lays another measure over it, { c, dp, label }: a value at
// each point, or null where it has none (a P/E while there are losses). The
// two then share one ratio scale: the second is rebased to start where the
// first does, and the same change in percent moves either line as far, so
// where they part the ratio between them has changed. Neither line can then be
// read off the edges of the plot, so the range returned has `levels` instead:
// each line's high and low, { value, y } with y a fraction of the height down.
export function plotLine(svg, series, { w, h, pad }) {
  const { t, c, base, move = 0, second } = series;
  if (!c || c.length < 2) {
    svg.setAttribute('hidden', '');
    svg.plot = null;
    return null;
  }

  const rebased = second && rebase(c, second.c);
  const at = rebased ? Math.log : (value) => value;
  const main = c.map(at);
  const other = rebased ? rebased.map((value) => (value == null ? null : at(value))) : [];
  let lo = Math.min(...main, ...other.filter((value) => value != null));
  let hi = Math.max(...main, ...other.filter((value) => value != null));
  const span = hi - lo || Math.abs(hi) * 0.001 || 1;
  // Keep the reference line only when it does not flatten the line's shape.
  const showBase = base != null && (!rebased || base > 0) && Math.max(hi, at(base)) - Math.min(lo, at(base)) <= span * 4;
  if (showBase) { lo = Math.min(lo, at(base)); hi = Math.max(hi, at(base)); }
  const range = hi - lo || span;

  const x = (i) => pad + (i / (c.length - 1)) * (w - 2 * pad);
  const y = (v) => pad + (1 - (v - lo) / range) * (h - 2 * pad);
  const xs = c.map((_, i) => x(i));
  const ys = main.map(y);

  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  $('.line', svg).setAttribute('d', xs.map((px, i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${ys[i].toFixed(1)}`).join(''));
  const baseLine = $('.base', svg);
  baseLine.toggleAttribute('hidden', !showBase);
  if (showBase) for (const [k, v] of Object.entries({ x1: 0, x2: w, y1: y(at(base)), y2: y(at(base)) })) baseLine.setAttribute(k, v);
  const end = $('.end', svg);
  end.setAttribute('cx', xs.at(-1));
  end.setAttribute('cy', ys.at(-1));

  // The second line breaks where it has no value.
  const ys2 = rebased ? other.map((value) => (value == null ? null : y(value))) : null;
  $('.line2', svg)?.setAttribute('d', ys2 ? ys2.map((py, i) => (py == null ? '' : `${ys2[i - 1] == null ? 'M' : 'L'}${xs[i].toFixed(1)},${py.toFixed(1)}`)).join('') : '');

  svg.classList.toggle('up', move > 0);
  svg.classList.toggle('down', move < 0);
  svg.plot = { t, c, xs, ys, base, dp: series.dp, step: series.step, w, h, pad, second: rebased && { ...second, ys: ys2 } };
  svg.removeAttribute('hidden');
  if (!rebased) return { lo, hi };
  const levels = (values, raw) => extremes(values).map((i) => ({ value: raw[i], y: y(values[i]) / h }));
  return { lo: Math.exp(lo), hi: Math.exp(hi), levels: { main: levels(main, c), second: levels(other, second.c) } };
}

// Intraday and hourly points carry a time; daily and weekly closes only a date.
export function pointLabel(time, step) {
  const at = new Date(time);
  const sameDay = at.toDateString() === new Date().toDateString();
  if (step === 'minute' || step === 'hour') {
    return at.toLocaleString([], { weekday: sameDay ? undefined : 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  }
  return sameDay ? 'now' : at.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

function onHover(event) {
  const svg = event.currentTarget;
  const plot = svg.plot;
  if (!plot) return;
  const box = svg.getBoundingClientRect();
  const ratio = (event.clientX - box.left) / box.width;
  const n = plot.c.length;
  const i = Math.min(n - 1, Math.max(0, Math.round(((ratio * plot.w - plot.pad) / (plot.w - 2 * plot.pad)) * (n - 1))));

  const cross = $('.cross', svg);
  const probe = $('.probe', svg);
  for (const [k, v] of Object.entries({ x1: plot.xs[i], x2: plot.xs[i], y1: 0, y2: plot.h })) cross.setAttribute(k, v);
  probe.setAttribute('cx', plot.xs[i]);
  probe.setAttribute('cy', plot.ys[i]);
  cross.removeAttribute('hidden');
  probe.removeAttribute('hidden');

  const value = plot.c[i];
  const vsBase = plot.base ? ` ${signed(((value - plot.base) / plot.base) * 100, 2, '%').text}` : '';
  let more = '';
  if (plot.second) {
    const probe2 = $('.probe2', svg);
    const y2 = plot.second.ys[i];
    if (y2 != null) {
      probe2.setAttribute('cx', plot.xs[i]);
      probe2.setAttribute('cy', y2);
    }
    probe2.toggleAttribute('hidden', y2 == null);
    more = ` · ${plot.second.label} <b>${fmt(plot.second.c[i], plot.second.dp)}</b>`;
  }
  showTip(`<b>${fmt(value, plot.dp)}</b>${vsBase}${more} · ${pointLabel(plot.t[i], plot.step)}`, box.left + (plot.xs[i] / plot.w) * box.width, box.top);
}

function onLeave(event) {
  for (const mark of event.currentTarget.querySelectorAll('.cross, .probe, .probe2')) mark.setAttribute('hidden', '');
  hideTip();
}
