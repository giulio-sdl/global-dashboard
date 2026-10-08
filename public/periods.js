// The periods a change is measured over, the two views that group them, and
// the arithmetic both the dashboard and the detail panel use for them.
import { signed } from './util.js';

export const PERIODS = ['1d', '1w', '1m', '3m', '6m', '1y', '5y', '10y'];
export const PERIOD_SHORT = { '1d': '1D', '1w': '5D', '1m': '1M', '3m': '3M', '6m': '6M', '1y': '1Y', '5y': '5Y', '10y': '10Y' };
export const PERIOD_NAME = { '1d': 'Intraday', '1w': '5 days', '1m': '1 month', '3m': '3 months', '6m': '6 months', '1y': '1 year', '5y': '5 years', '10y': '10 years' };

// The two views of the dashboard: the four changes each shows, and the period
// of the trend line drawn beside them (long enough to cover all four).
export const MODES = {
  short: { label: 'Short term', periods: ['1d', '1w', '1m', '3m'], line: '3m' },
  long: { label: 'Long term', periods: ['6m', '1y', '5y', '10y'], line: '10y' },
};

// A quote's change over a period: in percent, or in basis points for a yield.
// `base` is the closing level the period is measured from; one day uses the
// quote's own change. Null when the history does not reach back that far.
export function changeOver(period, q, base, isYield) {
  if (period === '1d') return isYield ? q.change * 100 : q.changePct;
  if (base == null) return null;
  return isYield ? (q.last - base) * 100 : (q.last / base - 1) * 100;
}

// How a change is written. Percentages lose decimals as they grow, and their
// thousands separator beyond that (a ten-year gain reads +13290%), so every
// figure is at most seven characters and fits its column. `bare` leaves the
// "bp" off a yield, for tables whose header already says it.
export function changeText(value, isYield, bare = false) {
  if (isYield) return signed(value, 1, bare ? '' : ' bp');
  const size = Math.abs(value ?? 0);
  const written = signed(value, size >= 1000 ? 0 : size >= 100 ? 1 : 2, '%');
  return { ...written, text: written.text.replace(',', '') };
}

export function setChange(node, value, isYield, bare) {
  const { text, dir } = changeText(value, isYield, bare);
  node.textContent = text;
  node.classList.remove('up', 'down', 'flat', 'na');
  node.classList.add(dir);
}

// The trend line for a period: its points, the level it is measured from, and
// the direction that colours it. `spark` is the server's series for the period.
export function lineView(period, spark, q, fetchedAt) {
  if (period === '1d') {
    // Colour follows the quoted change, not the (slightly lagging) last bar,
    // so the line never disagrees with the numbers beside it.
    return { base: q.prevClose, move: q.change ?? 0, t: spark?.t, c: spark?.c, step: 'minute' };
  }
  if (!spark?.c?.length) return {};
  // History stops at the last completed bar; finish the line at the live price.
  const live = q.last !== spark.c.at(-1);
  return {
    base: spark.base,
    move: q.last - spark.base,
    t: live ? [...spark.t, fetchedAt] : spark.t,
    c: live ? [...spark.c, q.last] : spark.c,
    step: spark.step,
  };
}
