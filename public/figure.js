// The larger chart of a panel, with its period buttons: an index's and a
// company's are the same figure. Beside its caption it states the change over
// the period on show.
import { lineSvg, plotLine, pointLabel } from './chart.js';
import { changeText, PERIOD_NAME, PERIOD_SHORT, PERIODS } from './periods.js';
import { $, el, fmt } from './util.js';

const SIZE = { h: 170, pad: 10 };

// Sets up a <figure class="d-chart"> and returns the means to drive it.
// `onPeriod` is told which period button was pressed.
export function chartFigure(figure, onPeriod) {
  const svg = lineSvg('spark big');
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
  return {
    plot,
    select(period) {
      for (const button of buttons.children) button.setAttribute('aria-pressed', String(button.dataset.period === period));
    },
    loading(on) {
      busy = on;
      plot.classList.toggle('loading', on);
      if (shown) this.draw(shown);
    },
    // Draws a period's line and writes what it shows: the change over the
    // period, the high and the low, the first and the last date. `change` is
    // in percent, or in basis points for a yield; null when it is not known.
    draw(what) {
      shown = what;
      const { view, period, name, dp, change, isYield = false } = what;
      const drawn = plotLine(svg, { ...view, dp }, { w: Math.max(240, plot.clientWidth), ...SIZE });
      svg.setAttribute('aria-label', `${name}, ${PERIOD_NAME[period]} chart`);
      const moved = changeText(change, isYield);
      $('figcaption', figure).replaceChildren(
        drawn ? `Price, ${PERIOD_NAME[period].toLowerCase()}` : busy ? 'Loading the chart…' : 'No chart data for this period',
        el('span', { class: `chip ${moved.dir}`, title: period === '1d' ? 'Change on the day' : `Change over ${PERIOD_NAME[period].toLowerCase()}`, text: moved.text }),
      );
      $('.d-hi', figure).textContent = drawn ? fmt(drawn.hi, dp) : '';
      $('.d-lo', figure).textContent = drawn ? fmt(drawn.lo, dp) : '';
      $('.d-from', figure).textContent = drawn ? pointLabel(view.t[0], view.step) : '';
      $('.d-to', figure).textContent = drawn ? pointLabel(view.t.at(-1), view.step) : '';
    },
  };
}
