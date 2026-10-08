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
// crosshair and probe shown on hover.
export function lineSvg(className = 'spark') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('role', 'img');
  svg.innerHTML = '<line class="base"/><path class="line"/><circle class="end" r="3"/><line class="cross" hidden/><circle class="probe" r="3.5" hidden/>';
  svg.setAttribute('hidden', ''); // SVG elements have no .hidden property
  svg.addEventListener('pointermove', onHover);
  svg.addEventListener('pointerleave', onLeave);
  return svg;
}

// Draws a series into a chart made by lineSvg. `series` is { t, c, base, move,
// step, dp }: times, values, the level the change is measured from, the
// direction that colours the line, and the bar size ('minute', 'hour', 'day'
// or 'week'). Returns the value range drawn, or null when there is no line.
export function plotLine(svg, series, { w, h, pad }) {
  const { t, c, base, move = 0 } = series;
  if (!c || c.length < 2) {
    svg.setAttribute('hidden', '');
    svg.plot = null;
    return null;
  }

  let lo = Math.min(...c);
  let hi = Math.max(...c);
  const span = hi - lo || Math.abs(hi) * 0.001 || 1;
  // Keep the reference line only when it does not flatten the line's shape.
  const showBase = base != null && Math.max(hi, base) - Math.min(lo, base) <= span * 4;
  if (showBase) { lo = Math.min(lo, base); hi = Math.max(hi, base); }
  const range = hi - lo || span;

  const x = (i) => pad + (i / (c.length - 1)) * (w - 2 * pad);
  const y = (v) => pad + (1 - (v - lo) / range) * (h - 2 * pad);
  const xs = c.map((_, i) => x(i));
  const ys = c.map(y);

  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  $('.line', svg).setAttribute('d', xs.map((px, i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${ys[i].toFixed(1)}`).join(''));
  const baseLine = $('.base', svg);
  baseLine.toggleAttribute('hidden', !showBase);
  if (showBase) for (const [k, v] of Object.entries({ x1: 0, x2: w, y1: y(base), y2: y(base) })) baseLine.setAttribute(k, v);
  const end = $('.end', svg);
  end.setAttribute('cx', xs.at(-1));
  end.setAttribute('cy', ys.at(-1));

  svg.classList.toggle('up', move > 0);
  svg.classList.toggle('down', move < 0);
  svg.plot = { t, c, xs, ys, base, dp: series.dp, step: series.step, w, h, pad };
  svg.removeAttribute('hidden');
  return { lo, hi };
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
  showTip(`<b>${fmt(value, plot.dp)}</b>${vsBase} · ${pointLabel(plot.t[i], plot.step)}`, box.left + (plot.xs[i] / plot.w) * box.width, box.top);
}

function onLeave(event) {
  $('.cross', event.currentTarget).setAttribute('hidden', '');
  $('.probe', event.currentTarget).setAttribute('hidden', '');
  hideTip();
}
