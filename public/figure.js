// The larger chart of a panel, with its period buttons: an index's and a
// company's are the same figure. Beside its caption it states the change over
// the period on show. A company's also carries its P/E, as a second line with
// a legend that shows or hides it.
import { lineSvg, plotLine, pointLabel } from './chart.js';
import { changeText, PERIOD_NAME, PERIOD_SHORT, PERIODS } from './periods.js';
import { $, el, fmt } from './util.js';

const SIZE = { h: 170, pad: 10 };
const LABEL_H = 14; // the height a scale label takes

// Writes a pair of scale labels, [high, low]. Those given a height (`y`, a
// fraction of the plot's) go there, inside the plot and clear of each other;
// others sit at the top and bottom edges.
function place(high, low, levels, dp) {
  for (const [node, level] of [[high, levels?.[0]], [low, levels?.[1]]]) {
    node.textContent = level ? fmt(level.value, dp) : '';
    node.style.top = '';
    node.style.bottom = '';
  }
  if (levels?.[0].y == null) return;
  const inside = (top) => Math.min(Math.max(top, 1), SIZE.h - LABEL_H);
  let top = inside(levels[0].y * SIZE.h - LABEL_H / 2);
  let bottom = inside(levels[1].y * SIZE.h - LABEL_H / 2);
  if (bottom - top < LABEL_H) {
    top = inside(Math.min(top, bottom - LABEL_H));
    bottom = top + LABEL_H;
  }
  Object.assign(high.style, { top: `${top}px`, bottom: 'auto' });
  Object.assign(low.style, { top: `${bottom}px`, bottom: 'auto' });
}

// Sets up a <figure class="d-chart"> and returns the means to drive it.
// `onPeriod` is told which period button was pressed.
export function chartFigure(figure, onPeriod) {
  const svg = lineSvg('spark big', true);
  const plot = $('.d-plot', figure);
  plot.prepend(svg);
  const buttons = $('.ranges', figure);
  for (const period of PERIODS) buttons.append(el('button', { type: 'button', 'data-period': period, 'aria-pressed': 'false', title: PERIOD_NAME[period], text: PERIOD_SHORT[period] }));
  buttons.addEventListener('click', (event) => {
    const period = event.target.closest('button')?.dataset.period;
    if (period) onPeriod(period);
  });

  let busy = false; // the period's line is being fetched
  let shown = null; // what was last drawn, to draw again when that changes

  // The legend: the price line, and the second line as a button that shows or hides it.
  const legend = el('div', { class: 'd-legend' });
  const mainKey = el('span', { class: 'lg-main' }, el('i'), 'Price');
  const secondValue = el('b');
  const secondKey = el('button', { type: 'button', class: 'lg-second', 'aria-pressed': 'true' }, el('i'), el('span'), secondValue);
  const secondNote = el('span', { class: 'lg-note' });
  legend.append(mainKey, secondKey, secondNote);
  legend.hidden = true;
  $('.d-chart-head', figure).after(legend);
  let showSecond = true;
  secondKey.addEventListener('click', () => {
    showSecond = !showSecond;
    if (shown) draw(shown);
  });

  // Draws a period's line and writes what it shows: the change over the
  // period, the high and the low, the first and the last date. `change` is
  // in percent, or in basis points for a yield; null when it is not known.
  // `span` names the period where its usual name does not fit ("24 hours").
  // `second` is a measure to lay over the price, { label, values, now, dp,
  // note }: `values` one per point of the line (null where it has none), or
  // null where it is not drawn for this period; `now` its latest figure, for
  // the legend.
  function draw(what) {
    shown = what;
    const { view, period, name, dp, change, isYield = false, span = PERIOD_NAME[period].toLowerCase(), second } = what;
    const overlay = second?.values && showSecond ? { c: second.values, dp: second.dp, label: second.label } : null;
    const drawn = plotLine(svg, { ...view, dp, second: overlay }, { w: Math.max(240, plot.clientWidth), ...SIZE });
    const both = Boolean(drawn?.levels);
    svg.setAttribute('aria-label', `${name}, ${PERIOD_NAME[period]} chart${both ? ` with ${second.label}` : ''}`);
    const moved = changeText(change, isYield);
    $('figcaption', figure).replaceChildren(
      drawn ? `${both ? `Price and ${second.label}` : 'Price'}, ${span}` : busy ? 'Loading the chart…' : 'No chart data for this period',
      el('span', { class: `chip ${moved.dir}`, title: span === 'intraday' ? 'Change on the day' : `Change over ${span}`, text: moved.text }),
    );
    // Alone, the price is read off the top and bottom edges; with the P/E,
    // its high and low are marked where they are. The P/E's one figure is the
    // legend's, and the tooltip gives it for any day.
    place($('.d-hi', figure), $('.d-lo', figure), drawn && (drawn.levels ?? [{ value: drawn.hi }, { value: drawn.lo }]), dp);
    $('.d-from', figure).textContent = drawn ? pointLabel(view.t[0], view.step) : '';
    $('.d-to', figure).textContent = drawn ? pointLabel(view.t.at(-1), view.step) : '';

    legend.hidden = !second;
    if (!second) return;
    mainKey.className = `lg-main ${svg.classList.contains('up') ? 'up' : svg.classList.contains('down') ? 'down' : ''}`;
    $('span', secondKey).textContent = `${second.label} `;
    secondValue.textContent = fmt(second.now, second.dp);
    secondKey.setAttribute('aria-pressed', String(showSecond));
    secondKey.title = `${showSecond ? 'Hide' : 'Show'} the ${second.label} line`;
    secondKey.classList.toggle('off', !second.values);
    secondNote.textContent = second.note ?? '';
  }

  return {
    plot,
    select(period) {
      for (const button of buttons.children) button.setAttribute('aria-pressed', String(button.dataset.period === period));
    },
    loading(on) {
      busy = on;
      plot.classList.toggle('loading', on);
      if (shown) draw(shown);
    },
    draw,
  };
}
