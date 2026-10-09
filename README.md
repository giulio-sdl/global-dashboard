# Global Dashboard

Live view of the main equity indexes (US, Europe, Switzerland, UK, Japan, China, India),
their pre/post-market read, and commodities.

## Run

```bash
npm start
```

Then open http://localhost:5177. Needs Node 20 or newer; there are no dependencies to install.
Set `PORT` to use a different port.

## Opening automatically each morning

A scheduled job opens the dashboard in the default browser at 07:30, Monday to Friday. It runs
[scripts/open-dashboard.sh](scripts/open-dashboard.sh), which starts the server if it is not already running.
The Mac has to be on and logged in; if it is asleep at 07:30, the job runs when it wakes.

The schedule is `scripts/local.global-dashboard.open.plist`, installed as a copy in `~/Library/LaunchAgents`.
It holds paths specific to one Mac, so it is not in the repository. To change the time or days, edit both
copies and reload, or to switch it off altogether:

```bash
launchctl bootout gui/$(id -u)/local.global-dashboard.open && rm ~/Library/LaunchAgents/local.global-dashboard.open.plist
```

Server output from scheduled runs goes to `~/Library/Logs/global-dashboard.log`.

## Hosting it for others

By default only the computer running the server can open the dashboard. To accept visitors, start it with
`HOST=0.0.0.0`; a hosting service also sets `PORT`. The repository includes [render.yaml](render.yaml), so on
Render it is "New > Blueprint" and pick this repository. There is no login: anyone with the address can see it,
and every visitor's refreshes go to the data feeds through the one server.

## What it shows

- **At a glance**: a row of headline tiles (main index per region, gold, Brent, EUR/USD, USD/CHF, CoinDesk 20, Bitcoin) with value,
  change, trend and exchange status. The list is `OVERVIEW` in [instruments.js](instruments.js).
- A bar that stays in view while scrolling, with links to each section and the period selector.
- **Main indexes** in two cards (Americas and Europe; Asia, including South Korea), two or three per country, each country with its
  exchange status (open, lunch break, pre-market, after-hours, closed, holiday) and a countdown to the next
  open or close.
- **Since close**: cash indexes do not trade outside their session, so while an exchange is shut each index
  shows how far a future or US-listed ETF on the same market has moved since the closing bell
  ([sinceclose.js](sinceclose.js)). The figure is that instrument's price now against its price at the bell;
  it is empty until the instrument has traded after the close. The `proxy` of each index is set in
  [instruments.js](instruments.js): futures for the US indexes and the Nikkei, ETFs for the rest. ETFs are in
  US dollars, so their figure includes currency moves.
- **Detail panel**: click any row or tile to open a panel with its key figures, its change over all eight
  periods, and a larger chart with its own period buttons. For 11 of the 17 indexes it also shows the
  constituents over the period selected there: which ones lifted or dragged the index most, the same by sector,
  and a sortable table of every constituent with its weight.
- **How constituent contributions are worked out**: a name's contribution is its weight at the start of the
  period times its price change. Only today's weights are known, so the starting weight is worked back from
  them, and the contributions add up to the move of the whole basket. Beyond one day each constituent needs
  one small history request, so a period is slow the first time (about 7 seconds for the S&P 500) and cached
  for 30 minutes. It uses today's members only: over years, companies that joined or left the index are not
  accounted for, and constituent prices exclude the dividends that total-return indexes (DAX, SPI) include,
  so the total drifts from the index's own change. The panel says so whenever the gap is material. A
  constituent whose price history has a break (a change of trading currency, for instance) is left out.
- **Crypto**: seven indexes (CoinDesk 20 and 5; S&P Broad Digital Market, MegaCap, ex-MegaCap, Bitcoin and
  Ethereum), and Bitcoin, Ether, XRP, BNB, Solana, Tron and Sui in US dollars. The S&P indexes have no intraday chart, and
  the three broad ones update once a day.
- **US bonds**: Treasury yields from 3 months to 30 years (in percent, with moves in basis points), Treasury
  futures, the MOVE volatility index, and the main bond indexes shown through the ETFs that track them, because
  the feed carries no bond index levels.
- **Commodities**: front-month futures for energy, metals and agriculture.
- **Currencies**: USD, EUR, CHF, JPY, BRL and CNY. Spot pairs against the dollar, the euro and franc crosses
  the feed quotes directly, and a cross-rate grid for every other combination (derived from the USD pairs).
- Each row has a trend line (hover for values) and the 52-week range where the feed provides one.
- **Short term / Long term**: the switch at the top right sets which four changes every table and tile
  shows. Short term is 1 day, 5 days, 1 month and 3 months, with a 3-month trend line; long term is 6 months,
  1 year, 5 years and 10 years, with a 10-year line (or as much history as there is). Yields show the same
  periods in basis points. The detail panel always lists all eight and has its own chart period buttons.
- **How periods are measured**: always from a closing level, counted back from the instrument's latest
  session. Five days is the close five sessions earlier; months and years are the last close on or before the
  same date that long ago (the last weekly close for 5Y and 10Y). Futures use the continuous front-month
  contract, so their long-period changes include contract rolls.
- **52-week range**: taken from a year of daily highs and lows plus today's trading, because the feed's own
  figure is missing for many instruments and rounded or stale for currencies.

## Look

The styling borrows from racing cockpits and timing screens, without any team or series branding. All of it is
in [public/styles.css](public/styles.css), driven by the colour variables at the top of the file.

- Green means up and red means down everywhere. Purple, the fastest-lap colour, marks the best gainer in each
  table over the first period of the view.
- Each tile has a strip of shift lights that fill outward from the centre: right for a gain, left for a loss.
  They follow the first change of the view: all six light up at a 2% move over 1 day (short term) or 25% over
  6 months (long term), and the outermost turns purple beyond that.
- Exchange status is a marshal light: green open, yellow pre/post-market or lunch, red closed.
- The 52-week range is a rev bar with a redline near the high; in the detail panel it is a rev counter.

## Changing the instruments

Edit [instruments.js](instruments.js) and restart. Symbols are CNBC quote symbols:
`.SPX` style for cash indexes, `@CL.1` style for front-month futures, plain tickers for US-listed securities,
`EUR=` / `EURCHF=` style for currency pairs, and `BTC.CM=` style for crypto.

## Data source

Quotes and intraday bars come from CNBC's public quote feed, proxied and cached by [server.js](server.js)
(quotes 10 s, intraday charts 3 min, longer history 10 min to 6 h). It needs no API key. US cash indexes, ETFs and currencies are real-time; other indexes,
futures and commodities are delayed by roughly 10–20 minutes. Yahoo Finance was tried first but rate-limits
unauthenticated requests (HTTP 429).

Index weights are not published by any free quote feed, so [holdings.js](holdings.js) reads them from the daily
holdings file of an iShares ETF tracking each index (ishares.com/ch), cached for 12 hours, and prices the
constituents through the CNBC feed. The `holdings.fund` value in [instruments.js](instruments.js) is the ETF's
product id on that site. There is no such fund for TOPIX, Shanghai Composite, Shenzhen Component, Hang Seng,
Nifty 50 or Nifty Bank, so those open without constituents. Copenhagen, Vienna and Warsaw listings are not
quoted by the feed, which leaves about 4% of the STOXX Europe 600 by weight without a price.

Two quirks of the feed are handled in [server.js](server.js). Shortly before an exchange opens it clears the
day's figures (change reads 0.00); until trading starts the dashboard shows the last session's change instead,
taken from the daily closes. And it is sometimes slow, most of all around the US open, so a refresh that takes
more than 2.5 seconds returns the previous figures while it finishes in the background. A history load that
comes back incomplete (the 07:30 job can start the server before the network is up after the Mac wakes) is
retried after 20 seconds rather than kept for its usual cache time.

Not available from this feed: CSI 300 and BSE Sensex, non-US index
futures other than Nikkei, the 52-week low for several commodity contracts, and direct quotes for the
CHF/BRL, CHF/CNY, JPY/BRL, JPY/CNY and BRL/CNY crosses (the grid derives them).
