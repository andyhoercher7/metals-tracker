// Stock prices via the `alpha-screen` edge function, which fetches Yahoo
// Finance server-side. No third-party CORS proxies (allorigins/corsproxy saw
// all traffic and failed intermittently) and no API key in the browser.
// Prices are the PRIOR TRADING DAY's CLOSE with an explicit as-of date.
import { invokeEdge } from './anthropic'

// Prior trading day's close for one ticker: { price, date, currency, exchange }.
export async function fetchClose(ticker) {
  const out = await invokeEdge({ action: 'audit', ticker })
  if (out.error || out.price == null) throw new Error(out.error || `No close price for ${ticker}`)
  return { price: out.price, date: out.date, currency: out.currency, exchange: out.exchange }
}

// Closes for many tickers. Returns { prices: { TICKER: price }, asOf: dateStr }.
export async function fetchQuotes(tickers) {
  return invokeEdge({ action: 'quotes', tickers })
}

// Audit a ticker: close price, resolved company name, currency, exchange, date.
export async function fetchTickerAudit(ticker) {
  return invokeEdge({ action: 'audit', ticker })
}

// Daily OPEN prices from startDate to today (for the IVV benchmark),
// plus the most recent completed close. Returns { opens, currentPrice, asOf }.
export async function fetchHistoricalOpens(ticker, startDate) {
  return invokeEdge({ action: 'historical-opens', ticker, startDate })
}
