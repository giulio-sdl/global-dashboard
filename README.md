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
  change, trend and exchange status. The list is `OVERVIEW` in [instruments.js](instruments.js), and can be
  changed from the page (see "Changing the instruments").
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
- **Detail panel**: click any row or tile to open a panel with its key figures and a larger chart with its
  own period buttons, from one day to ten years. Beside the chart's caption is the change over the period
  selected. For 11 of the 17 indexes it also shows the
  constituents over the period selected there: which ones lifted or dragged the index most, the same by sector,
  and a sortable table of every constituent with its weight.
- **Company panel**: click a company's name in an index's panel for its price chart (the same eight periods,
  each with its change), its P/E over time, its valuation measures, its key figures and its financial
  statements by year (led by the trailing twelve months) and by quarter (see SEC EDGAR below). It opens on the
  period the index panel was showing. "Back" returns to the index.
- **Valuation measures**: the nine Yahoo Finance shows (market cap, enterprise value, trailing and forward P/E,
  PEG, P/S, P/B, EV/revenue, EV/EBITDA), today and at the end of each of the last five quarters (see
  "Valuation measures" below). Both the search box and an index's panel open them.
- **Search**: the box in the header finds any share, fund, index or future by its symbol or name, in any market
  the quote feed covers, and opens it in the company panel on five years. Arrow keys and Enter pick a match;
  Enter with none highlighted opens the first, or the text as a symbol when nothing matches. "/" anywhere on
  the page puts the cursor in the box. A company listed in several countries is offered once, in its home
  market; type another listing's symbol (`AAPL-CH`) to get that one. Funds, indexes and futures have their
  chart and key figures, without statements.
- **P/E line**: on six months and longer, a company's chart carries its P/E: each price over the twelve months'
  diluted earnings per share known on that day, from its SEC filings (see "P/E over time" below).
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
- **Crypto is measured round the clock**: a share's day runs from one closing bell to the next, but crypto
  never closes, and the feed's "previous close" for a coin is only its price at 4 p.m. in New York. So the seven
  coins and the CoinDesk 20 are measured over exact spans, counted back from now ([rolling.js](rolling.js)):
  the last 24 hours, the last 5 days (120 hours, weekend included), and the same day and time of day one month
  to ten years ago. In their panel "24 hours ago" and "24-hour range" replace the previous close and day range.
  - The price at that moment comes from ten-minute prices for the last week and hourly ones for the last three
    months. Beyond that the feed has one close a day, so the price at that hour is placed between the closes
    either side: from six months back the figure is an estimate, good to a fraction of that day's move.
  - XRP, Tron and Sui are quoted from one series and charted from another, a little apart; the charted prices
    are brought to the quote's level first, which leaves these three about a tenth of a point less exact.
  - The CoinDesk 5 has no weekend prices on this feed and the S&P crypto indexes publish one value a day, so
    those six stay measured from their daily closes.
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
  periods in basis points. The detail panel's chart has its own period buttons for all eight.
- **How periods are measured**: always from a closing level, counted back from the instrument's latest
  session. Five days is the close five sessions earlier; months and years are the last close on or before the
  same date that long ago (the last weekly close for 5Y and 10Y). Futures use the continuous front-month
  contract, so their long-period changes include contract rolls.
- **Which session a quote belongs to** is worked out from the close its 1-day change is measured from, found
  among the daily closes, not from the date on the quote. The feed dates the closing quote of a US-listed
  fund a day early, dates a future by the calendar day of its last trade, and moves to today's date before a
  market has opened; counting back from that date put the 5-day and longer changes one session out. Index
  constituents are measured from the same day as their index.
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

**From the page**: "Edit rows" at the top right puts a ★ and a × on every row and a "+ Add a row" button under
every table. The changes apply at once, in every open copy of the page (a browser and the Mac app alike), and
outlast a restart. "Done" puts the controls away.

- **Adding**: type a symbol, or pick one of the suggestions for that table (CAC 40, IBEX 35, ASX 200, Bovespa,
  Dogecoin, orange juice and so on; the list is [public/catalog.js](public/catalog.js)). The server asks the
  quote feed for it first, so a symbol the feed does not know is turned away, and so is one already on the page.
  Without a name the feed's own is used. The new row has its price straight away and its longer changes and
  trend line within a few seconds.
- **Where a new row goes**: at the end of its table. An index added to a country has that exchange's status,
  but no "Since close" figure and no constituents: those need a proxy and an iShares fund, which are set in
  [instruments.js](instruments.js). Indexes that belong to no country listed (Canada, Brazil, Australia) go
  under "Other markets" in either card, which only shows once it has a row. A coin priced by Coin Metrics
  (`DOGE.CM=`) is measured round the clock like the others.
- **Removing**: × takes a row off at once, and "Undo" in the note at the foot of the page puts it back. A row from
  [instruments.js](instruments.js) returns in its old place with its tile.
- **Tiles**: ★ shows a row as a tile under "At a glance" (at the end), or stops showing it.
- **Restore defaults** (two clicks) goes back to [instruments.js](instruments.js) as it is.
- The changes are kept in `layout.local.json` next to `server.js` (not in the repository) as changes to
  [instruments.js](instruments.js), so rows added to that file later still appear. Deleting the file restores
  the defaults too.
- Only the computer running the server can make changes. On a hosted copy visitors see no "Edit rows", and the
  server refuses changes sent from anywhere but its own page.
- The currency cross-rate grid follows from the USD pairs and is not edited this way.

**In the code**: edit [instruments.js](instruments.js) and restart, to reorder rows, change the defaults, or
give an index its proxy or constituents. Symbols are CNBC quote symbols: `.SPX` style for cash indexes,
`@CL.1` style for front-month futures, plain tickers for US-listed securities, `EUR=` / `EURCHF=` style for
currency pairs, and `BTC.CM=` style for crypto.

## Data sources

The preferred order is Yahoo Finance, then CNBC, FRED and SEC EDGAR. In practice:

| Source | Used for | Notes |
|---|---|---|
| Yahoo Finance | Nothing | Its data service turns programs away (HTTP 429) while answering a browser on the same computer, and it does not let another site's page read it. Using it would mean disguising the server as a browser, which this project does not do. |
| CNBC quote feed | Every live price, every chart and every change over a period; each company's key figures, market cap and forward P/E; the search box's matches | The working first source. No key needed. |
| FRED | Treasury yield history, when CNBC has none | Official daily yields from the St. Louis Fed. See [fred.js](fred.js). |
| SEC EDGAR | Company financial statements, and the figures behind the valuation measures | As filed by the company. See [edgar.js](edgar.js). |
| iShares | Index constituents and weights | Daily holdings files. See [holdings.js](holdings.js). |

### CNBC

Quotes and intraday bars come from CNBC's public quote feed, proxied and cached by [server.js](server.js)
(quotes 10 s, intraday charts 3 min, longer history 10 min to 6 h). It needs no API key. US cash indexes, ETFs and currencies are real-time; other indexes,
futures and commodities are delayed by roughly 10–20 minutes.

### FRED

Each Treasury yield names its official series in [instruments.js](instruments.js) (`fred: 'DGS10'`). When CNBC
has had no daily or weekly history for a yield for 12 hours, FRED's series stands in: the 5-day to 10-year
changes and the trend lines are drawn from it, the row says "history: FRED", and CNBC goes on being asked.
Live yields always come from CNBC, because FRED is end-of-day and a business day behind. The day FRED still
lacks is filled with the close the live quote's own change is measured from, so that five sessions back is
counted correctly; after a market holiday that adds a day that did not trade, and the five days start one
session late. The stand-in also works when CNBC's history is down for everything.

The two are not quite the same figure. FRED quotes the yield of a constant maturity, CNBC that of the latest
bill or bond sold. For a 10-year they are within a couple of basis points; for a 3-month bill they can be
five to ten apart, which shows in a change measured from one to the other.

### SEC EDGAR

Clicking a company in an index's panel opens the company's own panel. Its key figures (dividend, margins and
so on) come with its quote from CNBC. Its financial statements come from EDGAR, the SEC's filing database:
revenue, profit, earnings per share, cash flow and the balance sheet for the last five fiscal years and six
quarters, as the company filed them. The years lead with the trailing twelve months (TTM) where the latest
quarter ends after the last fiscal year: flows over the last four quarters, the balance sheet of the latest.

- **Coverage**: companies registered with the SEC. That is every US-listed company, and foreign ones that file
  there (Novartis, SAP, Toyota), which report once a year. A company listed only abroad (Nestlé, Roche) has
  no statements, and the panel says so. A US share is found by its ticker; a foreign one only by its exact
  name, because a home ticker can be someone else's in New York.
- **Quarters by subtraction**: companies file cash flow only as a running total for the year, and never file
  a fourth quarter on its own. Those quarters are the running total less the one before.
- **Once a quarter**: a company's statements are fetched when its panel is first opened, kept in `.cache/edgar`,
  and fetched again when that copy is a quarter old, or weekly once the next report is overdue. `LAYOUT` in
  `edgar.js` is raised whenever the figures are read or laid out differently; copies kept under an older one
  are fetched again once.
- **Contact address**: the SEC asks every program to name a contact and stay under ten requests a second.
  Put the address in `settings.local.json` next to `server.js`, as `{ "secContact": "you@example.com" }`, or in
  the `SEC_CONTACT` environment variable on a hosting service. The file is not in the repository. Without an
  address nothing is requested and the panel shows key figures only.
- **Known gap**: a company that has reorganised under a new registration (a new holding company, say) starts
  again with only the reports filed since.

### P/E over time

The P/E line is worked out here, from two things the panel already has: prices and the earnings per share
filed with the SEC ([edgar.js](edgar.js), `trailingEarnings`).

- **Twelve months' earnings**: a fiscal year's own figure where the twelve months are one, otherwise the last
  four quarters added up. Each figure counts from the day its report was filed, not from the end of the
  quarter, so the line only knows what the market knew. A company that reports once a year (most foreign
  filers) has a new figure once a year.
- **Stock splits**: a filing counts in the shares of its day, and the filings after a split restate earlier
  figures in the new shares, so every figure is first brought into today's shares. The factor comes from the
  quote feed, which gives prices both as they traded and adjusted for splits (only for splits, not for
  dividends): their ratio in the week a report was filed is how many of today's shares one share was then.
  Chart prices are in today's shares too. NVIDIA, with splits in 2021 and 2024, runs without a break.
- **One scale**: the price and the P/E start together and share a ratio scale, where the same change in percent
  is the same height. Where the lines part, earnings have changed: a price line pulling above the P/E line is
  earnings growing. The price's high and low are marked on the left; the P/E's one figure is the latest, in
  the legend, and hovering gives it for any day. The legend's P/E button hides the line.
- **Not drawn**: on one day to three months, where earnings rarely change and the line would retrace the
  price; while the twelve months show a loss; when the earnings are in another currency than the listing
  (Apple in Zurich, TSMC in New York, which reports in Taiwan dollars); when the filings carry no earnings
  per share for recent years (Berkshire Hathaway); and when a foreign company's P/E from its filings is above
  1.5 times the feed's own or below two-thirds of it, which is taken to mean its depositary share stands for
  a different number of ordinary ones (Shell, BP). The panel says which.
- **The feed's P/E**: today's trailing P/E among the valuation measures is this line's latest figure. The
  feed's own P/E stands in where there are no filed earnings to use, and where the measures are the feed's
  alone (filings over 550 days old, as Toyota's are now); the panel's note says which. For Apple, Microsoft
  and NVIDIA the two agreed within 0.1 when this was written.
- The earnings come from the cached statements in `.cache/edgar`; copies made before this was added are
  fetched again once. The split factors are kept six hours.

### Valuation measures

The company panel lays out the valuation measures of Yahoo Finance's statistics page, worked out in
[valuation.js](valuation.js) from the SEC filings and the quote feed, since Yahoo itself is not a source (see Data
sources). The first column is today: today's price with the latest figures filed. The others are the
ends of the last five quarters (years, for a company that reports once a year): the close on the period's last
day with the figures to that day.

- **Market cap**: today's is CNBC's. Earlier ones are carried back from it by the price and by the number of
  shares the company filed, both brought into today's shares across splits, so buybacks show. A count is in
  the shares of the day it was filed, as earnings per share are: after O'Reilly's 15-for-1 split in June 2025,
  its count for December 2024 was filed again in the new shares, 15 times the first. Only the change
  in the share count is used, which keeps companies with several share classes right. Where no count is filed
  (Berkshire Hathaway), the price alone carries it back.
- **Enterprise value**: market cap plus debt (long-term debt with the part due within a year, and short-term
  borrowing) less cash and short-term investments, from the balance sheet on the day. Banks and some
  conglomerates do not tag their debt as such (JPMorgan, Goldman Sachs, Berkshire Hathaway), and Caterpillar
  tags its quarters' debt only by business, so these have no enterprise value, or Caterpillar only at its
  year ends; the panel's note says whether the debt or the cash is missing.
- **Ratios**: trailing P/E is the price over the twelve months' diluted earnings per share, as on the P/E line;
  P/S and EV/revenue use the twelve months' revenue; P/B uses shareholders' equity on the day; EV/EBITDA uses
  operating income with depreciation and amortization added back over twelve months (or profit before tax
  with interest added back too, for a company that files no operating income: Exxon, Chevron, Shell,
  ConocoPhillips; none where it files no interest either, rather than one too low). Nothing is divided by a loss
  or by negative equity.
- **Forward P/E and PEG**: from CNBC, for today only. The PEG ratio is CNBC's P/E over the growth in earnings
  per share that analysts' estimates expect for the next year; Yahoo's uses five years' expected growth, which
  CNBC does not carry.
- **Without filings in the listing's currency** (Nestlé, SAP in New York), the column for today is CNBC's own
  figures, with no P/B and no earlier columns.
- The filed figures come with the statements in `.cache/edgar`; copies made before this was added are fetched
  again once. The daily closes are kept an hour.

### iShares

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

On some days the history service answers a good share of requests with no bars at all (one Sunday morning,
between a sixth and a third of them). An empty answer is therefore treated as a failed request, not as an
instrument without history: the missing symbols alone are asked for again after 20 seconds, and the wait
doubles each time while the very same symbols keep failing, so one that truly has no data is not asked for
endlessly.

When the history is missing for everything at once, the source itself is down. That has happened when the
local network could not look up the history service's address for a couple of minutes (prices come from
another address and kept working). It is then asked for every 20 seconds with no growing wait, and the page
fills in by itself within about 20 seconds of it returning. While most rows lack a history, a banner on the
page says so, instead of leaving the lines, charts and longer changes as unexplained dashes.

For three S&P crypto indexes the feed rounds its own percentage change to one decimal (-2.70% for a fall of
2.76%). Where the feed's percentage is further from the one its price and change imply than rounding can
explain, the implied one is shown.

Known weak spots of the feed, not corrected: the daily history of thinly traded contracts has gaps that differ
from one request to the next (nickel most of all), and the S&P Bitcoin and Ethereum indexes get yesterday's
daily close a few hours late. When one of the last five closes is missing, that row's 5-day change is measured
from a session too early until the history is next refreshed (hourly).

Not available from this feed: CSI 300 and BSE Sensex, non-US index
futures other than Nikkei, the 52-week low for several commodity contracts, and direct quotes for the
CHF/BRL, CHF/CNY, JPY/BRL, JPY/CNY and BRL/CNY crosses (the grid derives them).
