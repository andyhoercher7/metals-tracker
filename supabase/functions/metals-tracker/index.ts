import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });

// The anon key is public and is itself a valid JWT, so "has a bearer token" is
// not a real check. Require a signed-in user before spending Anthropic credits:
// without this, anyone who learns the function URL can run up the API bill.
function isSignedIn(req: Request): boolean {
  try {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.role !== 'authenticated') return false;
    if (payload.exp && Date.now() / 1000 > payload.exp) return false;
    return true;
  } catch {
    return false;
  }
}

// Spot price from Yahoo Finance (server-side, avoids browser CORS).
async function yahooPrice(symbol: string): Promise<number | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    const d = await r.json();
    return d?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
  } catch { return null; }
}

serve(async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get('action');

  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  // ── SPOT PRICES ───────────────────────────────────────────────────────────
  // Left open: it calls only Yahoo, costs nothing, and exposes no user data.
  if (action === 'spot-prices') {
    try {
      // Copper HG=F quotes USD per avoirdupois pound → convert to troy oz.
      const [gold, silver, platinum, palladium, copperLb] = await Promise.all([
        yahooPrice('GC=F'), yahooPrice('SI=F'), yahooPrice('PL=F'),
        yahooPrice('PA=F'), yahooPrice('HG=F'),
      ]);
      const prices: Record<string, number> = {};
      if (gold)      prices.gold      = Math.round(gold * 100) / 100;
      if (silver)    prices.silver    = Math.round(silver * 100) / 100;
      if (platinum)  prices.platinum  = Math.round(platinum * 100) / 100;
      if (palladium) prices.palladium = Math.round(palladium * 100) / 100;
      if (copperLb)  prices.copper    = Math.round((copperLb / 14.5833) * 10000) / 10000;
      if (!Object.keys(prices).length) throw new Error('No prices returned from Yahoo Finance');
      return json(prices);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  // ── PARSE INVOICE ─────────────────────────────────────────────────────────
  // Extraction, not valuation: the model only reads line items out of a
  // document the user supplied, and the app shows every row for review before
  // anything is saved. It is never asked what something is worth.
  if (action === 'parse-invoice' && req.method === 'POST') {
    if (!isSignedIn(req)) return json({ error: 'Sign in required.', items: [] }, 401);
    const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
    if (!ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not configured.', items: [] }, 500);
    try {
      const { text } = await req.json();
      if (typeof text !== 'string' || !text.trim()) return json({ error: 'No invoice text supplied.', items: [] }, 400);
      // Cap the input so a huge paste cannot run up a large bill.
      const body = text.slice(0, 20000);
      const today = new Date().toISOString().split('T')[0];
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2048,
          messages: [{
            role: 'user',
            content: `Extract all precious metals line items from this invoice. Copy the figures as printed — do not estimate, infer, or fill in a price that is not on the document. For each: metal (gold/silver/copper/platinum/palladium), product name, troy ounces, total cost USD, dealer, date (default ${today}). Return ONLY a JSON array: [{"entry_date":"YYYY-MM-DD","metal":"","product":"","oz":0,"cost":0,"dealer":""}]. No other text.\n\n${body}`
          }]
        })
      });
      const data = await resp.json();
      if (data.error) return json({ error: data.error.message, items: [] }, 500);
      let replyText = '';
      for (const block of (data.content || [])) if (block.type === 'text') replyText += block.text;
      const arrMatch = replyText.match(/\[[\s\S]*\]/);
      if (arrMatch) {
        try { return json({ items: JSON.parse(arrMatch[0]) }); } catch { /* fall through */ }
      }
      return json({ items: [] });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e), items: [] }, 500);
    }
  }

  // Note: a 'batch-product-prices' action used to live here. It asked the model
  // to web-search dealer sites and return prices, which were written straight
  // into the database as market values. Nothing in the app called it, it was
  // unauthenticated, and model-generated prices are exactly what should never
  // be treated as fact — so it was removed. Real prices are entered by hand
  // (mkt_price_per_oz) or come from the live spot feed above.

  return new Response('asset-tracker API', { headers: { 'content-type': 'text/plain', ...CORS } });
});
