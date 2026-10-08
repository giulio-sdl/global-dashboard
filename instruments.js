// What the dashboard shows. Edit this file to add, remove or reorder rows.
// Symbols are CNBC quote symbols: ".XXX" = cash index, "@XX.1" = front-month
// future, plain ticker = US-listed security (the only kind with pre/post-market),
// "EUR=" = currency pair, "BTC.CM=" = crypto price from Coin Metrics, "US10Y" = Treasury yield.

// Regular trading hours in exchange-local time. `ref` is the index whose last
// trade date is used to spot exchange holidays.
export const MARKETS = {
  us: { label: 'NYSE / Nasdaq', tz: 'America/New_York', sessions: [['09:30', '16:00']], pre: ['04:00', '09:30'], post: ['16:00', '20:00'], ref: '.SPX' },
  eu: { label: 'Xetra / Euronext', tz: 'Europe/Paris', sessions: [['09:00', '17:30']], ref: '.GDAXI' },
  ch: { label: 'SIX Swiss Exchange', tz: 'Europe/Zurich', sessions: [['09:00', '17:30']], ref: '.SSMI' },
  uk: { label: 'London Stock Exchange', tz: 'Europe/London', sessions: [['08:00', '16:30']], ref: '.FTSE' },
  jp: { label: 'Tokyo Stock Exchange', tz: 'Asia/Tokyo', sessions: [['09:00', '11:30'], ['12:30', '15:30']], ref: '.N225' },
  kr: { label: 'Korea Exchange', tz: 'Asia/Seoul', sessions: [['09:00', '15:30']], ref: '.KS11' },
  cn: { label: 'Shanghai / Shenzhen', short: 'Mainland', tz: 'Asia/Shanghai', sessions: [['09:30', '11:30'], ['13:00', '15:00']], ref: '.SSEC' },
  hk: { label: 'Hong Kong Exchange', short: 'Hong Kong', tz: 'Asia/Hong_Kong', sessions: [['09:30', '12:00'], ['13:00', '16:00']], ref: '.HSI' },
  in: { label: 'NSE India', tz: 'Asia/Kolkata', sessions: [['09:15', '15:30']], ref: '.NSEI' },
};

// Group kinds: 'quote'  = last / change / trend / 52-week range,
//              'matrix' = currency cross-rate grid.
// A group with `markets` is a country: it gets its own heading and exchange
// status, and its last column shows the move since the close while the
// exchange is shut. Per index:
//   holdings  the constituents shown in its detail panel: `fund` is the product
//             id of an iShares ETF tracking the index on ishares.com/ch, whose
//             daily holdings file supplies the weights.
//   proxy     what the move since the close is read from: an index future, or
//             a US-listed ETF holding the same market. `tag` is the short label.
//   market    the exchange, where it differs from the group's first one.
const country = (label, markets, items) => ({ label, markets, kind: 'quote', items });
const future = (symbol, name) => ({ symbol, name, tag: 'Fut' });
const etf = (symbol, name) => ({ symbol, name, tag: symbol });

// The headline tiles at the top of the page, in order.
export const OVERVIEW = ['.SPX', '.NDX', '.STOXX', '.SSMI', '.FTSE', '.N225', '.SSEC', '.NSEI', '.CD20', 'BTC.CM=', '@GC.1', '@LCO.1', 'EUR=', 'CHF='];

export const SECTIONS = [
  {
    id: 'equities',
    title: 'Equity indexes',
    cards: [
      {
        title: 'Americas and Europe',
        groups: [
          country('United States', ['us'], [
            { symbol: '.SPX', name: 'S&P 500', holdings: { fund: 253743, etf: 'iShares Core S&P 500 UCITS ETF' }, proxy: future('@SP.1', 'S&P 500 futures') },
            { symbol: '.DJI', name: 'Dow Jones', note: 'Industrial Average', holdings: { fund: 253713, etf: 'iShares Dow Jones Industrial Average UCITS ETF' }, proxy: future('@DJ.1', 'Dow futures') },
            { symbol: '.NDX', name: 'Nasdaq 100', holdings: { fund: 253741, etf: 'iShares NASDAQ 100 UCITS ETF' }, proxy: future('@ND.1', 'Nasdaq 100 futures') },
          ]),
          country('Europe', ['eu'], [
            { symbol: '.STOXX', name: 'STOXX 600', note: 'Europe', holdings: { fund: 251931, etf: 'iShares STOXX Europe 600 UCITS ETF (DE)' }, proxy: etf('VGK', 'Vanguard FTSE Europe ETF') },
            { symbol: '.STOXX50E', name: 'Euro Stoxx 50', holdings: { fund: 253712, etf: 'iShares Core EURO STOXX 50 UCITS ETF' }, proxy: etf('FEZ', 'SPDR Euro Stoxx 50 ETF') },
            { symbol: '.GDAXI', name: 'DAX', note: 'Germany', holdings: { fund: 251464, etf: 'iShares Core DAX UCITS ETF (DE)' }, proxy: etf('EWG', 'iShares MSCI Germany ETF') },
          ]),
          country('Switzerland', ['ch'], [
            { symbol: '.SSMI', name: 'SMI', holdings: { fund: 261154, etf: 'iShares SMI ETF (CH)' }, proxy: etf('EWL', 'iShares MSCI Switzerland ETF') },
            { symbol: '.SSHI', name: 'SPI', holdings: { fund: 264107, etf: 'iShares Core SPI ETF (CH)' }, proxy: etf('EWL', 'iShares MSCI Switzerland ETF') },
          ]),
          country('United Kingdom', ['uk'], [
            { symbol: '.FTSE', name: 'FTSE 100', holdings: { fund: 251795, etf: 'iShares Core FTSE 100 UCITS ETF' }, proxy: etf('EWU', 'iShares MSCI United Kingdom ETF') },
            { symbol: '.FTMC', name: 'FTSE 250', holdings: { fund: 251796, etf: 'iShares FTSE 250 UCITS ETF' }, proxy: etf('EWU', 'iShares MSCI United Kingdom ETF') },
          ]),
        ],
      },
      {
        title: 'Asia',
        groups: [
          country('Japan', ['jp'], [
            { symbol: '.N225', name: 'Nikkei 225', holdings: { fund: 253742, etf: 'iShares Nikkei 225 UCITS ETF' }, proxy: future('@NK.1', 'Nikkei 225 futures (CME)') },
            { symbol: '.TOPX', name: 'TOPIX', proxy: future('@NK.1', 'Nikkei 225 futures (CME)') },
          ]),
          country('South Korea', ['kr'], [
            { symbol: '.KS11', name: 'KOSPI', proxy: etf('EWY', 'iShares MSCI South Korea ETF') },
            { symbol: '.KQ11', name: 'KOSDAQ', proxy: etf('EWY', 'iShares MSCI South Korea ETF') },
          ]),
          country('China', ['cn', 'hk'], [
            { symbol: '.SSEC', name: 'Shanghai', note: 'Composite', proxy: etf('FXI', 'iShares China Large-Cap ETF') },
            { symbol: '.SZI', name: 'Shenzhen', note: 'Component', proxy: etf('FXI', 'iShares China Large-Cap ETF') },
            { symbol: '.HSI', name: 'Hang Seng', market: 'hk', proxy: etf('FXI', 'iShares China Large-Cap ETF') },
          ]),
          country('India', ['in'], [
            { symbol: '.NSEI', name: 'Nifty 50', proxy: etf('INDA', 'iShares MSCI India ETF') },
            { symbol: '.NSEBANK', name: 'Nifty Bank', proxy: etf('INDA', 'iShares MSCI India ETF') },
          ]),
        ],
      },
    ],
  },
  {
    id: 'crypto',
    title: 'Crypto',
    cards: [
      {
        title: 'Crypto indexes',
        groups: [
          {
            label: 'Index',
            kind: 'quote',
            items: [
              { symbol: '.CD20', name: 'CoinDesk 20', note: '20 largest coins' },
              { symbol: '.CD5', name: 'CoinDesk 5', note: '5 largest coins' },
              { symbol: '.SPCBDM', name: 'S&P Broad', note: 'All digital assets · daily' },
              { symbol: '.SPCMC', name: 'S&P MegaCap', note: 'Bitcoin and Ether · daily' },
              { symbol: '.SPCBXM', name: 'S&P ex-MegaCap', note: 'Everything else · daily' },
              { symbol: '.SPBTC', name: 'S&P Bitcoin' },
              { symbol: '.SPETH', name: 'S&P Ethereum' },
            ],
          },
        ],
      },
      {
        title: 'Coins',
        groups: [
          {
            label: 'Price in USD',
            kind: 'quote',
            items: [
              { symbol: 'BTC.CM=', name: 'Bitcoin', note: 'BTC' },
              { symbol: 'ETH.CM=', name: 'Ether', note: 'ETH' },
              // Coins priced around a dollar or less: the Coin Metrics quote rounds to
              // cents, so the price comes from the spot quote, which has four decimals
              // but no chart history. `chart` names the symbol the history is taken from.
              { symbol: 'XRP=', chart: 'XRP.CM=', name: 'XRP', note: 'XRP' },
              { symbol: 'BNB.CM=', name: 'BNB', note: 'BNB' },
              { symbol: 'SOL.CM=', name: 'Solana', note: 'SOL' },
              { symbol: 'TRX=', chart: 'TRX.CM=', name: 'Tron', note: 'TRX' },
              { symbol: 'SUI=', chart: 'SUI.CM=', name: 'Sui', note: 'SUI' },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'bonds',
    title: 'US bonds',
    cards: [
      {
        title: 'Treasury yields',
        groups: [
          {
            // `yields` rows are quoted in percent, and their moves in basis points.
            label: 'Maturity',
            kind: 'quote',
            yields: true,
            items: [
              { symbol: 'US3M', name: '3-month', note: 'Bill' },
              { symbol: 'US6M', name: '6-month', note: 'Bill' },
              { symbol: 'US1Y', name: '1-year', note: 'Bill' },
              { symbol: 'US2Y', name: '2-year', note: 'Note' },
              { symbol: 'US5Y', name: '5-year', note: 'Note' },
              { symbol: 'US10Y', name: '10-year', note: 'Note' },
              { symbol: 'US20Y', name: '20-year', note: 'Bond' },
              { symbol: 'US30Y', name: '30-year', note: 'Bond' },
            ],
          },
        ],
      },
      {
        title: 'Bond indexes',
        groups: [
          {
            label: 'Index',
            kind: 'quote',
            items: [{ symbol: '.MOVE', name: 'MOVE', note: 'Treasury volatility · daily' }],
          },
          {
            // The feed carries no bond index levels, so each index is shown through the ETF that tracks it.
            label: 'Via tracking ETF',
            kind: 'quote',
            items: [
              { symbol: 'AGG', name: 'US Aggregate', note: 'AGG' },
              { symbol: 'GOVT', name: 'All Treasuries', note: 'GOVT' },
              { symbol: 'TLT', name: 'Treasuries 20y+', note: 'TLT' },
              { symbol: 'TIP', name: 'TIPS', note: 'Inflation-protected · TIP' },
              { symbol: 'LQD', name: 'Investment grade', note: 'Corporate bonds · LQD' },
              { symbol: 'HYG', name: 'High yield', note: 'Corporate bonds · HYG' },
            ],
          },
        ],
      },
      {
        title: 'Treasury futures',
        groups: [
          {
            label: 'Front-month futures',
            kind: 'quote',
            items: [
              { symbol: '@TU.1', name: '2-year note' },
              { symbol: '@FV.1', name: '5-year note' },
              { symbol: '@TY.1', name: '10-year note' },
              { symbol: '@US.1', name: '30-year bond' },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'commodities',
    title: 'Commodities',
    cards: [
      {
        title: 'Energy',
        groups: [
          {
            label: 'Front-month futures',
            kind: 'quote',
            items: [
              { symbol: '@CL.1', name: 'WTI crude', unit: 'USD/bbl' },
              { symbol: '@LCO.1', name: 'Brent crude', unit: 'USD/bbl' },
              { symbol: '@NG.1', name: 'Natural gas', unit: 'USD/MMBtu' },
              { symbol: '@RB.1', name: 'RBOB gasoline', unit: 'USD/gal' },
              { symbol: '@HO.1', name: 'Heating oil', unit: 'USD/gal' },
            ],
          },
        ],
      },
      {
        title: 'Metals',
        groups: [
          {
            label: 'Precious',
            kind: 'quote',
            items: [
              { symbol: '@GC.1', name: 'Gold', unit: 'USD/oz' },
              { symbol: '@SI.1', name: 'Silver', unit: 'USD/oz' },
              { symbol: '@PL.1', name: 'Platinum', unit: 'USD/oz' },
              { symbol: '@PA.1', name: 'Palladium', unit: 'USD/oz' },
            ],
          },
          {
            label: 'Industrial',
            kind: 'quote',
            items: [
              { symbol: '@HG.1', name: 'Copper', unit: 'USD/lb' },
              { symbol: '@AL.1', name: 'Aluminum', unit: 'USD/t' },
              { symbol: '@NI.1', name: 'Nickel', unit: 'USD/t' },
              { symbol: '@TIO.1', name: 'Iron ore 62%', unit: 'USD/t' },
            ],
          },
        ],
      },
      {
        title: 'Agriculture',
        groups: [
          {
            label: 'Grains',
            kind: 'quote',
            items: [
              { symbol: '@C.1', name: 'Corn', unit: '¢/bu' },
              { symbol: '@W.1', name: 'Wheat', unit: '¢/bu' },
              { symbol: '@S.1', name: 'Soybeans', unit: '¢/bu' },
            ],
          },
          {
            label: 'Softs',
            kind: 'quote',
            items: [
              { symbol: '@KC.1', name: 'Coffee', unit: '¢/lb' },
              { symbol: '@SB.1', name: 'Sugar', unit: '¢/lb' },
              { symbol: '@CC.1', name: 'Cocoa', unit: 'USD/t' },
              { symbol: '@CT.1', name: 'Cotton', unit: '¢/lb' },
            ],
          },
          {
            label: 'Livestock',
            kind: 'quote',
            items: [
              { symbol: '@LC.1', name: 'Live cattle', unit: '¢/lb' },
              { symbol: '@LH.1', name: 'Lean hogs', unit: '¢/lb' },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'fx',
    title: 'Currencies',
    cards: [
      {
        title: 'US dollar',
        groups: [
          {
            label: 'Spot',
            kind: 'quote',
            items: [
              { symbol: '.DXY', name: 'Dollar index', note: 'DXY' },
              { symbol: 'EUR=', name: 'EUR/USD' },
              { symbol: 'CHF=', name: 'USD/CHF' },
              { symbol: 'JPY=', name: 'USD/JPY' },
              { symbol: 'BRL=', name: 'USD/BRL' },
              { symbol: 'CNY=', name: 'USD/CNY', note: 'onshore' },
              { symbol: 'CNH=', name: 'USD/CNH', note: 'offshore' },
            ],
          },
        ],
      },
      {
        title: 'Euro and franc crosses',
        groups: [
          {
            label: 'Spot',
            kind: 'quote',
            items: [
              { symbol: 'EURCHF=', name: 'EUR/CHF' },
              { symbol: 'EURJPY=', name: 'EUR/JPY' },
              { symbol: 'EURBRL=', name: 'EUR/BRL' },
              { symbol: 'EURCNY=', name: 'EUR/CNY' },
              { symbol: 'CHFJPY=', name: 'CHF/JPY' },
            ],
          },
        ],
      },
      {
        title: 'Cross rates',
        groups: [
          {
            // Every pair is derived from the currency's USD quote; `perUsd`
            // marks pairs quoted as units per dollar (USD/CHF) rather than
            // dollars per unit (EUR/USD).
            label: 'One unit of the row currency, priced in the column currency. Derived from the USD pairs.',
            kind: 'matrix',
            items: [
              { code: 'USD', name: 'US dollar' },
              { code: 'EUR', name: 'Euro', symbol: 'EUR=' },
              { code: 'CHF', name: 'Swiss franc', symbol: 'CHF=', perUsd: true },
              { code: 'JPY', name: 'Japanese yen', symbol: 'JPY=', perUsd: true },
              { code: 'BRL', name: 'Brazilian real', symbol: 'BRL=', perUsd: true },
              { code: 'CNY', name: 'Chinese renminbi (onshore)', symbol: 'CNY=', perUsd: true },
            ],
          },
        ],
      },
    ],
  },
];
