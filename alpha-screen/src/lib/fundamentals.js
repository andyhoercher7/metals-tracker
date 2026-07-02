// Real fundamental ratios from Finnhub, fetched by the `alpha-screen` edge
// function so the Finnhub key stays server-side. Set the FINNHUB_API_KEY
// secret on the Supabase project (Dashboard -> Edge Functions -> Secrets).
// Returns { configured, data: { TICKER: {...fields} } }; failed tickers omitted.
import { invokeEdge } from './anthropic'

export async function fetchFundamentalsBatch(tickers) {
  return invokeEdge({ action: 'fundamentals', tickers })
}
