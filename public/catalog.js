// Suggestions offered when adding a row, by the table they fit: instruments
// the quote feed was checked to carry. Any other symbol of the feed can be
// typed in as well. The key is the table's: section id / card title / label.

const row = (symbol, name, note, unit) => ({ symbol, name, note, unit });

export const CATALOG = {
  'equities/Americas and Europe/United States': [
    row('.RUT', 'Russell 2000', 'Small caps'),
    row('.NYA', 'NYSE Composite'),
    row('.VIX', 'VIX', 'S&P 500 volatility'),
  ],
  'equities/Americas and Europe/Europe': [
    row('.FCHI', 'CAC 40', 'France'),
    row('.FTMIB', 'FTSE MIB', 'Italy'),
    row('.IBEX', 'IBEX 35', 'Spain'),
    row('.AEX', 'AEX', 'Netherlands'),
    row('.BFX', 'BEL 20', 'Belgium'),
    row('.OMXS30', 'OMX Stockholm 30', 'Sweden'),
  ],
  'equities/Americas and Europe/Switzerland': [row('.SLI', 'SLI', 'Swiss Leader Index')],
  'equities/Americas and Europe/United Kingdom': [row('.FTAS', 'FTSE All-Share')],
  'equities/Americas and Europe/Other markets': [
    row('.GSPTSE', 'S&P/TSX', 'Canada'),
    row('.BVSP', 'Bovespa', 'Brazil'),
    row('.MXX', 'S&P/BMV IPC', 'Mexico'),
  ],
  'equities/Asia/Japan': [row('.JPXNK400', 'JPX-Nikkei 400')],
  'equities/Asia/South Korea': [row('.KS200', 'KOSPI 200')],
  'equities/Asia/China': [
    row('.HSCE', 'Hang Seng China', 'Enterprises (H shares)'),
    row('.HSTECH', 'Hang Seng Tech'),
  ],
  'equities/Asia/India': [row('.NIFTYIT', 'Nifty IT')],
  'equities/Asia/Other markets': [row('.AXJO', 'S&P/ASX 200', 'Australia')],
  'crypto/Coins/Price in USD': [
    row('DOGE.CM=', 'Dogecoin', 'DOGE'),
    row('ADA.CM=', 'Cardano', 'ADA'),
    row('AVAX.CM=', 'Avalanche', 'AVAX'),
    row('LINK.CM=', 'Chainlink', 'LINK'),
    row('LTC.CM=', 'Litecoin', 'LTC'),
    row('BCH.CM=', 'Bitcoin Cash', 'BCH'),
    row('DOT.CM=', 'Polkadot', 'DOT'),
  ],
  'bonds/Treasury yields/Maturity': [
    row('US7Y', '7-year', 'Note'),
    row('US10YTIP', '10-year TIPS', 'Real yield'),
  ],
  'bonds/Bond indexes/Via tracking ETF': [
    row('BND', 'Total bond market', 'BND'),
    row('SHY', 'Treasuries 1–3y', 'SHY'),
    row('IEF', 'Treasuries 7–10y', 'IEF'),
    row('MBB', 'Mortgage-backed', 'MBB'),
    row('EMB', 'Emerging markets', 'USD bonds · EMB'),
    row('BNDX', 'International', 'Ex-US bonds · BNDX'),
  ],
  'commodities/Agriculture/Grains': [
    row('@KW.1', 'KC wheat', 'Hard red winter', '¢/bu'),
    row('@O.1', 'Oats', null, '¢/bu'),
    row('@RR.1', 'Rough rice', null, 'USD/cwt'),
    row('@SM.1', 'Soybean meal', null, 'USD/short ton'),
    row('@BO.1', 'Soybean oil', null, '¢/lb'),
  ],
  'commodities/Agriculture/Softs': [row('@OJ.1', 'Orange juice', null, '¢/lb')],
  'commodities/Agriculture/Livestock': [row('@FC.1', 'Feeder cattle', null, '¢/lb')],
  'fx/US dollar/Spot': [
    row('GBP=', 'GBP/USD'),
    row('AUD=', 'AUD/USD'),
    row('CAD=', 'USD/CAD'),
    row('MXN=', 'USD/MXN'),
    row('INR=', 'USD/INR'),
    row('KRW=', 'USD/KRW'),
  ],
  'fx/Euro and franc crosses/Spot': [
    row('EURGBP=', 'EUR/GBP'),
    row('GBPCHF=', 'GBP/CHF'),
  ],
};
