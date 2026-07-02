// Alpha Screen server-side API. (Deployed to Supabase as `alpha-screen`,
// verify_jwt enabled. This copy is for version control.)
// All third-party calls (Anthropic, Yahoo Finance, Finnhub) run here so no
// API key ever ships to the browser and no third-party CORS proxy is needed.
//
// Actions (POST JSON { action, ...params }):
//   quotes           { tickers[] }            -> { prices: {T: close}, asOf }
//   historical-opens { ticker, startDate }    -> { opens, currentPrice, asOf }
//   audit            { ticker }               -> { ticker, price, date, name, currency, exchange, error }
//   fundamentals     { tickers[] }            -> { configured, data: {T: {...}} }
//   run-screen       { systemPrompt }         -> screen JSON (schema-enforced)
//   position-review  { prompt }               -> review JSON (schema-enforced)

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });

// verify_jwt already checked the signature; additionally require a real
// signed-in user so the public anon key alone cannot burn Anthropic credits.
function isAuthenticatedUser(req: Request): boolean {
  try {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.role === 'authenticated';
  } catch {
    return false;
  }
}

// ── Yahoo Finance (server-side, no proxy) ───────────────────────────────────

async function yahooJson(url: string) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
  return r.json();
}

const chartUrl = (ticker: string, extra = 'interval=1d&range=7d') =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?${extra}`;

// Most recent COMPLETED daily close (a bar dated before today, UTC),
// falling back to the latest available close.
function lastCompletedClose(result: any): { price: number; date: string } | null {
  const ts: number[] = result?.timestamp || [];
  const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close || [];
  const today = new Date().toISOString().slice(0, 10);
  for (let i = ts.length - 1; i >= 0; i--) {
    if (closes[i] == null) continue;
    const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    if (date < today) return { price: closes[i]!, date };
  }
  for (let i = ts.length - 1; i >= 0; i--) {
    if (closes[i] != null) {
      return { price: closes[i]!, date: new Date(ts[i] * 1000).toISOString().slice(0, 10) };
    }
  }
  return null;
}

async function fetchClose(ticker: string) {
  const data = await yahooJson(chartUrl(ticker));
  const r = data?.chart?.result?.[0];
  const close = lastCompletedClose(r);
  if (!close) throw new Error(`No close price for ${ticker}`);
  return {
    price: close.price,
    date: close.date,
    currency: r?.meta?.currency ?? null,
    exchange: r?.meta?.exchangeName ?? null,
  };
}

async function actionQuotes(tickers: string[]) {
  const unique = [...new Set(tickers)].slice(0, 50);
  const results = await Promise.allSettled(unique.map((t) => fetchClose(t)));
  const prices: Record<string, number> = {};
  let asOf: string | null = null;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      prices[unique[i]] = r.value.price;
      if (!asOf || r.value.date > asOf) asOf = r.value.date;
    }
  });
  return { prices, asOf };
}

async function actionHistoricalOpens(ticker: string, startDate: string) {
  const start = Math.floor(new Date(startDate + 'T00:00:00Z').getTime() / 1000) - 5 * 86400;
  const end = Math.floor(Date.now() / 1000) + 86400;
  const data = await yahooJson(chartUrl(ticker, `interval=1d&period1=${start}&period2=${end}`));
  const r = data?.chart?.result?.[0];
  if (!r) throw new Error(`No historical data for ${ticker}`);
  const ts: number[] = r.timestamp || [];
  const opens: (number | null)[] = r.indicators?.quote?.[0]?.open || [];
  const map: Record<string, number> = {};
  ts.forEach((t, i) => {
    if (opens[i] != null) map[new Date(t * 1000).toISOString().slice(0, 10)] = opens[i]!;
  });
  const close = lastCompletedClose(r);
  return { opens: map, currentPrice: close?.price ?? null, asOf: close?.date ?? null };
}

async function actionAudit(ticker: string) {
  const out: Record<string, unknown> = {
    ticker, price: null, date: null, name: null, currency: null, exchange: null, error: null,
  };
  try {
    const c = await fetchClose(ticker);
    out.price = c.price; out.date = c.date; out.currency = c.currency; out.exchange = c.exchange;
  } catch (e) {
    out.error = (e as Error).message;
  }
  try {
    const search = await yahooJson(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}`,
    );
    const match = (search?.quotes || []).find((q: any) => q.symbol === ticker);
    if (match) out.name = match.shortname || match.longname || null;
  } catch { /* name is optional */ }
  return out;
}

// ── Finnhub fundamentals (key stays server-side) ────────────────────────────

const round = (n: unknown, d = 1) =>
  n == null || isNaN(Number(n)) ? null : +Number(n).toFixed(d);

async function actionFundamentals(tickers: string[]) {
  const key = Deno.env.get('FINNHUB_API_KEY');
  if (!key) return { configured: false, data: {} };
  const unique = [...new Set(tickers)].slice(0, 30);
  const results = await Promise.allSettled(
    unique.map(async (t) => {
      const r = await fetch(
        `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(t)}&metric=all&token=${key}`,
        { signal: AbortSignal.timeout(15000) },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const m = (await r.json())?.metric;
      if (!m || Object.keys(m).length === 0) throw new Error(`No fundamentals for ${t}`);
      const out: Record<string, number | null> = {};
      if (m.peTTM != null) out.pe_ratio = round(m.peTTM);
      if (m.forwardPE != null) out.forward_pe = round(m.forwardPE);
      if (m.roeTTM != null) out.roe = round(m.roeTTM);
      if (m.epsGrowthTTMYoy != null) out.eps_growth_yoy = round(m.epsGrowthTTMYoy);
      if (m.revenueGrowthTTMYoy != null) out.revenue_growth = round(m.revenueGrowthTTMYoy);
      if (m.grossMarginTTM != null) out.gross_margin = round(m.grossMarginTTM);
      const de = m['totalDebt/totalEquityQuarterly'] ?? m['totalDebt/totalEquityAnnual'];
      if (de != null) out.debt_equity = round(de, 2);
      return out;
    }),
  );
  const data: Record<string, unknown> = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && Object.keys(r.value).length > 0) data[unique[i]] = r.value;
  });
  return { configured: true, data };
}

// ── Anthropic (schema-enforced JSON, web search, adaptive thinking) ─────────

const MODEL = 'claude-opus-4-8';

const SELL_TRIGGER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['trigger_type', 'trigger_description', 'action_on_trigger'],
  properties: {
    trigger_type: {
      type: 'string',
      enum: [
        'EARNINGS_MISS_GUIDANCE_CUT', 'EARNINGS_MISS_GUIDANCE_MAINTAINED', 'THESIS_BROKEN',
        'DRAWDOWN_25PCT', 'FLAT_8_WEEKS', 'TARGET_HIT', 'TIME_DECAY_WEEK_48',
      ],
    },
    trigger_description: { type: 'string' },
    action_on_trigger: { type: 'string', enum: ['SELL_50', 'SELL_100', 'REVIEW'] },
  },
};

const SCREEN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['stage1_summary', 'picks', 'macro_pushback_summary', 'screen_notes'],
  properties: {
    stage1_summary: {
      type: 'object',
      additionalProperties: false,
      required: ['total_screened', 'passed_filter', 'top_sectors'],
      properties: {
        total_screened: { type: 'integer' },
        passed_filter: { type: 'integer' },
        top_sectors: { type: 'array', items: { type: 'string' } },
      },
    },
    picks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'rank', 'ticker', 'company_name', 'country', 'us_listed', 'sector', 'industry',
          'macro_theme', 'quant_score', 'price_at_pick',
          'target_price_bear', 'target_price', 'target_price_bull', 'p_2x',
          'pe_ratio', 'forward_pe', 'peg_ratio', 'roe', 'eps_growth_yoy', 'revenue_growth',
          'debt_equity', 'price_momentum_3m', 'price_momentum_6m', 'gross_margin',
          'analyst_revision_direction', 'entry_thesis', 'key_risks',
          'macro_alignment_notes', 'macro_pushback', 'qual_scores', 'sell_triggers',
        ],
        properties: {
          rank: { type: 'integer' },
          ticker: { type: 'string' },
          company_name: { type: 'string' },
          country: { type: 'string' },
          us_listed: { type: 'boolean' },
          sector: { type: 'string' },
          industry: { type: 'string' },
          macro_theme: {
            type: 'string',
            enum: ['AI_EFFICIENCY', 'EARNINGS_BROADENING', 'QUALITY_VALUE', 'OTHER'],
          },
          quant_score: { type: 'number', description: 'Quantitative composite, 0-100 scale' },
          price_at_pick: { type: 'number' },
          target_price_bear: { type: 'number', description: 'Bear-case 12-month price' },
          target_price: { type: 'number', description: 'Base-case 12-month price from valuation work, NOT a mechanical 2x' },
          target_price_bull: { type: 'number', description: 'Bull-case 12-month price' },
          p_2x: { type: 'number', description: 'Honest probability (0-1) the stock doubles within 12 months' },
          pe_ratio: { type: ['number', 'null'] },
          forward_pe: { type: ['number', 'null'] },
          peg_ratio: { type: ['number', 'null'] },
          roe: { type: ['number', 'null'] },
          eps_growth_yoy: { type: ['number', 'null'] },
          revenue_growth: { type: ['number', 'null'] },
          debt_equity: { type: ['number', 'null'] },
          price_momentum_3m: { type: ['number', 'null'] },
          price_momentum_6m: { type: ['number', 'null'] },
          gross_margin: { type: ['number', 'null'] },
          analyst_revision_direction: { type: 'string', enum: ['UP', 'DOWN', 'FLAT', 'MIXED'] },
          entry_thesis: { type: 'string' },
          key_risks: { type: 'string' },
          macro_alignment_notes: { type: 'string' },
          macro_pushback: { type: 'string' },
          qual_scores: {
            type: 'object',
            additionalProperties: false,
            required: [
              'industry_trend_score', 'macro_alignment_score', 'management_quality_score',
              'competitive_moat_score', 'thesis_conviction_score', 'risks_identified',
              'qualitative_notes',
            ],
            properties: {
              industry_trend_score: { type: 'integer', description: '1-10' },
              macro_alignment_score: { type: 'integer', description: '1-10' },
              management_quality_score: { type: 'integer', description: '1-10' },
              competitive_moat_score: { type: 'integer', description: '1-10' },
              thesis_conviction_score: { type: 'integer', description: '1-10' },
              risks_identified: { type: 'string' },
              qualitative_notes: { type: 'string' },
            },
          },
          sell_triggers: { type: 'array', items: SELL_TRIGGER_SCHEMA },
        },
      },
    },
    macro_pushback_summary: { type: 'string' },
    screen_notes: { type: 'string' },
  },
};

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'price_change_wow', 'price_change_since_entry', 'market_context', 'industry_context',
    'company_specific_news', 'thesis_status', 'hold_buy_sell_signal', 'signal_rationale',
    'earnings_review', 'post_earnings_notes', 'sell_triggers_fired',
  ],
  properties: {
    price_change_wow: { type: ['number', 'null'] },
    price_change_since_entry: { type: ['number', 'null'] },
    market_context: { type: 'string' },
    industry_context: { type: 'string' },
    company_specific_news: { type: 'string' },
    thesis_status: { type: 'string', enum: ['INTACT', 'WEAKENING', 'BROKEN'] },
    hold_buy_sell_signal: { type: 'string', enum: ['STRONG_HOLD', 'HOLD', 'ADD', 'TRIM', 'SELL'] },
    signal_rationale: { type: 'string' },
    earnings_review: { type: 'boolean' },
    post_earnings_notes: { type: 'string' },
    sell_triggers_fired: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['trigger_type', 'action'],
        properties: {
          trigger_type: {
            type: 'string',
            enum: [
              'EARNINGS_MISS_GUIDANCE_CUT', 'EARNINGS_MISS_GUIDANCE_MAINTAINED', 'THESIS_BROKEN',
              'DRAWDOWN_25PCT', 'FLAT_8_WEEKS', 'TARGET_HIT', 'TIME_DECAY_WEEK_48',
            ],
          },
          action: { type: 'string', enum: ['SELL_50', 'SELL_100', 'REVIEW'] },
        },
      },
    },
  },
};

async function callClaude(opts: {
  system?: string;
  userContent: string;
  schema: unknown;
  maxSearches: number;
}) {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured on the edge function');

  const messages: unknown[] = [{ role: 'user', content: opts.userContent }];

  // Server-side web search runs a server loop that can pause (pause_turn);
  // re-send to let it resume, a few times at most.
  for (let attempt = 0; attempt < 4; attempt++) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        ...(opts.system ? { system: opts.system } : {}),
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: opts.maxSearches }],
        output_config: { format: { type: 'json_schema', schema: opts.schema } },
        messages,
      }),
    });
    const data = await resp.json();
    if (data.error) throw new Error(`Anthropic API: ${data.error.message}`);

    if (data.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: data.content });
      continue;
    }
    if (data.stop_reason === 'refusal') throw new Error('Model declined the request.');
    if (data.stop_reason === 'max_tokens') {
      throw new Error('Response hit the token limit before the JSON finished. Try again.');
    }

    // With output_config.format the final text block is guaranteed valid JSON.
    const textBlocks = (data.content || []).filter((b: any) => b.type === 'text');
    const last = textBlocks[textBlocks.length - 1];
    if (!last) throw new Error('No text content in model response.');
    return JSON.parse(last.text);
  }
  throw new Error('Model paused too many times without finishing.');
}

// ── Router ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!isAuthenticatedUser(req)) return json({ error: 'Sign-in required' }, 401);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  try {
    switch (body.action) {
      case 'quotes':
        return json(await actionQuotes(body.tickers || []));
      case 'historical-opens':
        return json(await actionHistoricalOpens(body.ticker, body.startDate));
      case 'audit':
        return json(await actionAudit(body.ticker));
      case 'fundamentals':
        return json(await actionFundamentals(body.tickers || []));
      case 'run-screen':
        if (!body.systemPrompt) return json({ error: 'systemPrompt required' }, 400);
        return json(
          await callClaude({
            system: body.systemPrompt,
            userContent: body.userPrompt ||
              'Run the full two-stage stock screen now, following the system prompt. Use web search for real data. Return the JSON.',
            schema: SCREEN_SCHEMA,
            maxSearches: 15,
          }),
        );
      case 'position-review':
        if (!body.prompt) return json({ error: 'prompt required' }, 400);
        return json(
          await callClaude({
            system:
              'You are a disciplined stock analyst reviewing held positions. Use web search for current news and prices. Be specific and evidence-based.',
            userContent: body.prompt,
            schema: REVIEW_SCHEMA,
            maxSearches: 8,
          }),
        );
      default:
        return json({ error: `Unknown action: ${body.action}` }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
