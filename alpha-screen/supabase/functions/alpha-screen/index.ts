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
//   claude-start     { kind, systemPrompt|prompt } -> { job_id } (background batch job)
//   claude-poll      { job_id }               -> { status: running|done|error, data?, error? }
//
// Long screen runs exceed the 150s wall-clock limit on Supabase's free plan
// (killed with status 546), so the screen runs as an Anthropic Message Batch:
// claude-start submits the batch and returns instantly; the client polls
// claude-poll until the batch ends. Batch pricing is also 50% of standard.

import { createClient } from 'npm:@supabase/supabase-js@2';

const supa = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// POST to the Anthropic Messages API, retrying transient failures (HTTP
// 429/5xx and overloaded_error/rate_limit_error/api_error). Anthropic returns
// "Overloaded" when its servers are momentarily busy; a short backoff usually
// clears it. Backoff is kept small so a synchronous call still fits the 150s
// platform limit. Non-transient errors throw immediately.
// deno-lint-ignore no-explicit-any
async function anthropicMessage(payload: unknown): Promise<any> {
  const transientTypes = new Set(['overloaded_error', 'rate_limit_error', 'api_error']);
  let lastMsg = 'unknown error';
  for (let i = 0; i < 5; i++) {
    let resp: Response;
    try {
      resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: anthropicHeaders(),
        body: JSON.stringify(payload),
      });
    } catch (e) {
      lastMsg = (e as Error).message;
      await sleep(1000 * 2 ** i);
      continue;
    }
    if (resp.status === 429 || resp.status >= 500) {
      lastMsg = `HTTP ${resp.status}`;
      await sleep(1000 * 2 ** i);
      continue;
    }
    const data = await resp.json();
    if (data.error) {
      if (transientTypes.has(data.error.type)) {
        lastMsg = data.error.message || data.error.type;
        await sleep(1000 * 2 ** i);
        continue;
      }
      throw new Error(`Anthropic API: ${data.error.message}`);
    }
    return data;
  }
  throw new Error(
    `Anthropic API is busy right now (${lastMsg}). It auto-retried a few times — please click again in a minute.`,
  );
}

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
  maxTokens?: number;
  thinking?: boolean;
}) {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured on the edge function');

  const messages: unknown[] = [{ role: 'user', content: opts.userContent }];

  // Server-side web search runs a server loop that can pause (pause_turn);
  // re-send to let it resume, a few times at most.
  for (let attempt = 0; attempt < 4; attempt++) {
    const data = await anthropicMessage({
      model: MODEL,
      max_tokens: opts.maxTokens ?? 16000,
      // Adaptive thinking is powerful but slow; a synchronous call must
      // finish inside the platform's 150s wall-clock limit, so the light
      // per-position review path turns it off.
      ...(opts.thinking === false ? {} : { thinking: { type: 'adaptive' } }),
      ...(opts.system ? { system: opts.system } : {}),
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: opts.maxSearches }],
      output_config: { format: { type: 'json_schema', schema: opts.schema } },
      messages,
    });

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

// ── Background Claude jobs (Anthropic Batches API) ──────────────────────────

const REVIEW_SYSTEM =
  'You are a disciplined stock analyst reviewing held positions. Use web search for current news and prices. Be specific and evidence-based.';

const anthropicHeaders = () => ({
  'x-api-key': Deno.env.get('ANTHROPIC_API_KEY') ?? '',
  'anthropic-version': '2023-06-01',
  'content-type': 'application/json',
});

function claudeParams(kind: string, system: string, messages: unknown[], maxSearches: number) {
  return {
    model: MODEL,
    // A full 10-pick screen (long theses per pick) plus adaptive thinking can
    // exceed a small budget and truncate the JSON ("hit the token limit");
    // give the screen ample room. Reviews are small.
    max_tokens: kind === 'screen' ? 32000 : 8000,
    thinking: { type: 'adaptive' },
    system,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: maxSearches }],
    output_config: {
      format: { type: 'json_schema', schema: kind === 'screen' ? SCREEN_SCHEMA : REVIEW_SCHEMA },
    },
    messages,
  };
}

async function createBatch(params: unknown): Promise<string> {
  const r = await fetch('https://api.anthropic.com/v1/messages/batches', {
    method: 'POST',
    headers: anthropicHeaders(),
    body: JSON.stringify({ requests: [{ custom_id: 'r1', params }] }),
  });
  const data = await r.json();
  if (data.error) throw new Error(`Anthropic API: ${data.error.message}`);
  return data.id;
}

async function actionClaudeStart(body: any) {
  if (!Deno.env.get('ANTHROPIC_API_KEY')) {
    throw new Error('ANTHROPIC_API_KEY not configured on the edge function');
  }
  const kind = body.kind;
  let system: string, userContent: string, maxSearches: number;
  if (kind === 'screen') {
    if (!body.systemPrompt) throw new Error('systemPrompt required');
    system = body.systemPrompt;
    userContent = body.userPrompt ||
      'Run the full two-stage stock screen now, following the system prompt. Use web search for real data. Return the JSON.';
    maxSearches = 15;
    // Re-clicking Run Screen resumes the in-flight job instead of paying twice.
    const { data: existing } = await supa
      .from('claude_jobs')
      .select('id')
      .eq('kind', 'screen')
      .eq('status', 'running')
      .gte('created_at', new Date(Date.now() - 24 * 3600_000).toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) return { job_id: existing.id, resumed: true };
    // Serve the current cycle's pre-run screen instead of billing a new run.
    // The Sunday auto-run finishes hours before the user opens the app on
    // Monday, so this window must span the whole week (weekly cadence). If
    // nothing ran in 8 days it falls through and starts a fresh run.
    const { data: recentDone } = await supa
      .from('claude_jobs')
      .select('id')
      .eq('kind', 'screen')
      .eq('status', 'done')
      .gte('updated_at', new Date(Date.now() - 8 * 86400_000).toISOString())
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recentDone) return { job_id: recentDone.id, resumed: true };
  } else if (kind === 'review') {
    if (!body.prompt) throw new Error('prompt required');
    system = REVIEW_SYSTEM;
    userContent = body.prompt;
    maxSearches = 8;
  } else {
    throw new Error('kind must be "screen" or "review"');
  }

  const messages = [{ role: 'user', content: userContent }];
  const batchId = await createBatch(claudeParams(kind, system, messages, maxSearches));
  const { data: job, error } = await supa
    .from('claude_jobs')
    .insert({ kind, status: 'running', batch_id: batchId, system_prompt: system, messages, max_searches: maxSearches })
    .select('id')
    .single();
  if (error) throw new Error(`job insert failed: ${error.message}`);
  return { job_id: job.id };
}

// Server-side copy of the client's buildSystemPrompt (src/lib/systemPrompt.js)
// so the weekly cron can pre-run the screen with nobody at the keyboard.
// deno-lint-ignore no-explicit-any
function buildScreenSystemPrompt(w: any, recentFeedback: unknown[]): string {
  const pct = (x: number) => (x * 100).toFixed(0);
  return `
You are a disciplined quantitative-qualitative stock analyst. Your mandate is to identify 5–10 public companies with the potential to double in price within 12 months. You operate with zero sentiment bias and actively push back on macro narratives that are not supported by data.

## INVESTMENT MANDATE
- Target: 2x price return within 12 months — this is a SELECTION BAR, not target-price arithmetic
- Universe: All Country World Index (~2,500 stocks), minimum 60% US-listed in final output
- Portfolio role: High-conviction, high-risk sleeve — small position sizes
- Bias correction: You will actively challenge any submitted macro views with contradicting evidence before accepting them as thesis inputs

## SCORING RULES (strict)
- quant_score: 0–100 scale, always. Never use a 0–10 scale.
- Qualitative factor scores (industry trend, macro alignment, management, moat, thesis conviction): integers 1–10.
- Do NOT compute a composite score — the application computes it deterministically as 60% quant + 40% qualitative.

## TARGET PRICES (honest, not mechanical)
For each pick provide three 12-month price scenarios derived from valuation work (forward EPS × justified multiple bands, or comparable-based):
- target_price_bear: bear case
- target_price: base case — your genuine central estimate, NOT price_at_pick × 2
- target_price_bull: bull case
And p_2x: your honest probability (0–1) that the stock doubles within 12 months. The base rate for quality mid/large caps is low single digits — most picks should be well under 0.5. This number is tracked and calibrated against outcomes, so be honest, not aspirational.

## MACRO THEMES (current — challenge these, do not accept them at face value)
1. AI EFFICIENCY THEME: Companies using AI to materially reduce costs or expand margins — NOT companies trading on AI narrative alone. Challenge: Is margin improvement actually showing up in financials yet, or is this still forward story?
2. EARNINGS BROADENING THEME: Companies outside mega-cap 10 with accelerating EPS growth, underowned and under-covered. Challenge: Is broadening actually occurring or is it a consensus view that's already priced in?
3. QUALITY AT REASONABLE PRICE: P/E relative to growth rate, not absolute value. Challenge: In a rate-sensitive environment, does quality command a premium that compresses your return potential?

## DIVERSIFICATION CONSTRAINTS
- No more than 5 of the 10 final picks may share one macro_theme.
- No more than 2 picks per industry.
The current book is heavily concentrated in AI infrastructure — a pick that adds a differentiated return driver is worth more than the 6th correlated AI name.

## QUANTITATIVE FACTOR WEIGHTS (live — read before every screen)
- Earnings Growth Momentum: ${pct(w.earnings_growth_weight)}%
- Relative Valuation: ${pct(w.valuation_weight)}%
- Price Momentum: ${pct(w.momentum_weight)}%
- ROE / Quality: ${pct(w.quality_weight)}%
- Revenue Growth: ${pct(w.revenue_growth_weight)}%
- Balance Sheet: ${pct(w.balance_sheet_weight)}%
- Analyst Estimate Revisions: ${pct(w.analyst_revision_weight)}%

## SCREENING PROCESS

### STAGE 1 — Quantitative Pre-Filter (target: 50–100 companies)
Use web search to pull pre-screened lists from finviz.com, stockanalysis.com, and macrotrends.net.
Hard filters:
- Forward P/E < 25 OR PEG < 1.5 (relative to sector, not absolute)
- EPS growth YoY > 15%
- ROE > 12%
- Debt/Equity < 2.0
- Revenue growth > 10%
- Not a penny stock (price > $3)
- Market cap > $100M
Apply factor weights to score each company on the 0–100 scale.
Report honestly in stage1_summary how many names you actually evaluated — do not claim to have screened the full universe if you did not.

### STAGE 2 — Deep Quantitative + Qualitative Screen (top 10–15 from Stage 1)
For each company, pull:
- Detailed financials (last 4 quarters)
- Analyst estimate revisions (last 90 days)
- Recent news and catalysts
- Industry trend context
- Competitive positioning
- Management track record signals

Score qualitative factors 1–10:
- Industry trend alignment
- Macro theme alignment (with pushback noted)
- Management quality evidence
- Competitive moat strength
- Thesis conviction (probability of 2x in 12 months)

### FINAL OUTPUT
Rank 1–10, respecting the diversification constraints. For each pick provide the entry thesis (why this could 2x), specific key risks, macro alignment AND contradicting evidence, bear/base/bull targets with p_2x, and pre-set sell triggers. Only report fundamental numbers you actually found via search — use null for anything unverified; the application overwrites fundamentals with verified data anyway.

## SELL RULES (hard-coded — do not override)
1. Earnings miss + guidance cut → SELL 100%
2. Earnings miss, guidance maintained → SELL 50%, re-evaluate next week
3. Thesis-breaking news → SELL 100%
4. Price down 25% from entry + held > 6 weeks, no thesis change → FLAG for review
5. 8 weeks held, price within ±10%, no visible catalyst → TRIM 50%
6. Price hits 2x cost basis → SELL 50%, let remainder run
7. Week 48 of 52, no meaningful progress → SELL 100%

User may overrule any sell signal by holding. All overrules are tracked against outcomes.

## LEARNING LOOP
${recentFeedback && recentFeedback.length > 0 ? `Recent model performance data:
${JSON.stringify(recentFeedback, null, 2)}

Before generating new picks, review this data and:
1. Note which factors predicted winners vs losers
2. Note which macro themes played out vs failed
3. Suggest weight adjustments in screen_notes if patterns are clear (minimum 8 weeks of data required)
4. Flag any systematic biases in prior recommendations` : 'No historical performance data yet — this is the first screen.'}

## OUTPUT
Your final answer is delivered as structured JSON enforced by the API — fill every field. Keep entry_thesis and key_risks under ~80 words each.
`;
}

// Weekly cron entry point: pre-run the screen so the result is already
// waiting when the user opens the app. Anon-callable but guarded — it
// no-ops unless the most recent screen job is over 5 days old.
async function actionScheduledScreen() {
  const { data: recent } = await supa
    .from('claude_jobs')
    .select('id')
    .eq('kind', 'screen')
    .gte('created_at', new Date(Date.now() - 5 * 86400_000).toISOString())
    .limit(1)
    .maybeSingle();
  if (recent) return { skipped: true, reason: 'A screen job already ran within the last 5 days.' };

  const { data: weights } = await supa
    .from('factor_weights')
    .select('*')
    .order('effective_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!weights) throw new Error('No factor_weights row found.');
  const { data: feedback } = await supa
    .from('model_feedback')
    .select('*')
    .order('week_date', { ascending: false })
    .limit(8);

  return actionClaudeStart({
    kind: 'screen',
    systemPrompt: buildScreenSystemPrompt(weights, feedback || []),
  });
}

async function failJob(jobId: string, msg: string) {
  await supa.from('claude_jobs')
    .update({ status: 'error', error: msg, updated_at: new Date().toISOString() })
    .eq('id', jobId);
  return { status: 'error', error: msg };
}

async function actionClaudePoll(body: any) {
  const { data: job, error: jerr } = await supa
    .from('claude_jobs').select('*').eq('id', body.job_id).maybeSingle();
  if (jerr) throw new Error(jerr.message);
  if (!job) throw new Error('Unknown job_id');
  if (job.status === 'done') return { status: 'done', data: job.result };
  if (job.status === 'error') return { status: 'error', error: job.error };

  const br = await fetch(`https://api.anthropic.com/v1/messages/batches/${job.batch_id}`, {
    headers: anthropicHeaders(),
  });
  const batch = await br.json();
  if (batch.error) return failJob(job.id, `Anthropic API: ${batch.error.message}`);
  if (batch.processing_status !== 'ended') return { status: 'running' };

  const rr = await fetch(
    batch.results_url || `https://api.anthropic.com/v1/messages/batches/${job.batch_id}/results`,
    { headers: anthropicHeaders() },
  );
  const line = (await rr.text()).split('\n').find((l) => l.trim());
  if (!line) return failJob(job.id, 'Batch ended with no results.');
  const result = JSON.parse(line).result;
  if (result.type !== 'succeeded') {
    return failJob(job.id, `Batch ${result.type}: ${JSON.stringify(result.error ?? '')}`);
  }

  const msg = result.message;
  if (msg.stop_reason === 'pause_turn') {
    // Long web-search turns pause; continue the conversation in a new batch.
    if ((job.continuations ?? 0) >= 6) {
      return failJob(job.id, 'Model paused too many times without finishing.');
    }
    // Claim the continuation first — the client and the cron poller can race,
    // and only one of them may submit (and pay for) the follow-up batch.
    const { data: claimed } = await supa.from('claude_jobs')
      .update({
        continuations: (job.continuations ?? 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id)
      .eq('batch_id', job.batch_id)
      .eq('continuations', job.continuations ?? 0)
      .select('id');
    if (!claimed || claimed.length === 0) return { status: 'running' };
    const messages = [...job.messages, { role: 'assistant', content: msg.content }];
    const batchId = await createBatch(
      claudeParams(job.kind, job.system_prompt, messages, job.max_searches),
    );
    await supa.from('claude_jobs')
      .update({ batch_id: batchId, messages, updated_at: new Date().toISOString() })
      .eq('id', job.id);
    return { status: 'running' };
  }
  if (msg.stop_reason === 'refusal') return failJob(job.id, 'Model declined the request.');
  if (msg.stop_reason === 'max_tokens') {
    return failJob(job.id, 'Response hit the token limit before the JSON finished. Try again.');
  }

  const textBlocks = (msg.content || []).filter((b: any) => b.type === 'text');
  const last = textBlocks[textBlocks.length - 1];
  if (!last) return failJob(job.id, 'No text content in model response.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(last.text);
  } catch (e) {
    return failJob(job.id, `Could not parse model JSON: ${(e as Error).message}`);
  }
  await supa.from('claude_jobs')
    .update({ status: 'done', result: parsed, updated_at: new Date().toISOString() })
    .eq('id', job.id);
  return { status: 'done', data: parsed };
}

// ── Weekly position reviews, auto-run server-side ───────────────────────────
// Ported from the client (lib/screeningPrompts.js, lib/sellRules.js) so the
// whole weekly review runs overnight with nobody at the keyboard. Results are
// written straight into weekly_position_reviews / position_tracker /
// sell_triggers, so the app shows them the moment the user opens it — no click.

// deno-lint-ignore no-explicit-any
function buildWeeklyReviewPrompt(position: any, currentPrice: number, recentNews: string): string {
  const target = position.avg_cost_basis ? (position.avg_cost_basis * 2).toFixed(2) : 'N/A';
  const chg = position.avg_cost_basis
    ? (((currentPrice - position.avg_cost_basis) / position.avg_cost_basis) * 100).toFixed(1)
    : 'N/A';
  return `
Review this held position for the week ending ${new Date().toISOString().split('T')[0]}.

POSITION DATA:
- Ticker: ${position.ticker}
- Entry price (your cost basis): $${position.avg_cost_basis}
- Current price: $${currentPrice}
- Price change since entry: ${chg}%
- Weeks held: ${position.weeks_held}
- Original thesis: ${position.entry_thesis || 'N/A'}
- Target price (2x your cost basis): $${target}

RECENT NEWS AND CONTEXT:
${recentNews}

Provide a structured weekly review:
1. Price performance context (vs market, vs sector)
2. Any company-specific news that impacts the thesis
3. Industry/macro developments relevant to this position
4. Thesis status: INTACT / WEAKENING / BROKEN (with specific evidence)
5. Signal: STRONG_HOLD / HOLD / ADD / TRIM / SELL
6. Signal rationale (be specific — what would change this signal?)
7. If earnings were released this week, post-earnings analysis

Apply sell rules automatically and flag any that are triggered.
Return the structured JSON.`;
}

// deno-lint-ignore no-explicit-any
function evaluateSellRules(position: any, reviewData: any): any[] {
  const triggers: any[] = [];
  const { price_change_since_entry, thesis_status } = reviewData || {};
  const weeksHeld = position.weeks_held || 0;
  if (price_change_since_entry != null && price_change_since_entry <= -25 && weeksHeld > 6) {
    triggers.push({ trigger_type: 'DRAWDOWN_25PCT', trigger_description: `Price down ${Math.abs(price_change_since_entry).toFixed(1)}% from entry after ${weeksHeld} weeks`, action_on_trigger: 'REVIEW' });
  }
  if (weeksHeld >= 8 && price_change_since_entry != null && Math.abs(price_change_since_entry) <= 10) {
    triggers.push({ trigger_type: 'FLAT_8_WEEKS', trigger_description: `Held ${weeksHeld} weeks with only ${price_change_since_entry?.toFixed(1)}% move — no visible catalyst`, action_on_trigger: 'SELL_50' });
  }
  if (position.avg_cost_basis && position.current_price) {
    const target2x = position.avg_cost_basis * 2;
    if (position.current_price >= target2x) {
      triggers.push({ trigger_type: 'TARGET_HIT', trigger_description: `Current price $${position.current_price.toFixed(2)} reached 2x target $${target2x.toFixed(2)} (2x cost basis $${position.avg_cost_basis.toFixed(2)})`, action_on_trigger: 'SELL_50' });
    }
  }
  if (weeksHeld >= 48) {
    triggers.push({ trigger_type: 'TIME_DECAY_WEEK_48', trigger_description: `Position held ${weeksHeld} weeks — approaching 12-month window`, action_on_trigger: 'SELL_100' });
  }
  if (thesis_status === 'BROKEN') {
    triggers.push({ trigger_type: 'THESIS_BROKEN', trigger_description: 'Weekly review flagged thesis as BROKEN', action_on_trigger: 'SELL_100' });
  }
  return triggers;
}

// Submit many review requests as ONE batch (one request per held position).
// deno-lint-ignore no-explicit-any
async function createReviewBatch(requests: any[]): Promise<string> {
  const r = await fetch('https://api.anthropic.com/v1/messages/batches', {
    method: 'POST',
    headers: anthropicHeaders(),
    body: JSON.stringify({ requests }),
  });
  const data = await r.json();
  if (data.error) throw new Error(`Anthropic API: ${data.error.message}`);
  return data.id;
}

const weekDateStr = () => new Date().toISOString().split('T')[0];

// Weekly cron entry point for reviews. Refreshes held-position prices, then
// submits one batch with a light review per position. No-ops if this week's
// reviews already exist (manual run or a prior cron tick).
async function actionScheduledReview() {
  const weekDate = weekDateStr();

  const { data: alreadyRun } = await supa
    .from('weekly_review_runs').select('id').eq('week_date', weekDate).limit(1).maybeSingle();
  if (alreadyRun) return { skipped: true, reason: 'A review run already exists for this week.' };
  const { data: alreadyReviewed } = await supa
    .from('weekly_position_reviews').select('id').eq('week_date', weekDate).limit(1).maybeSingle();
  if (alreadyReviewed) return { skipped: true, reason: 'Positions already reviewed this week.' };

  const { data: positions } = await supa
    .from('position_tracker')
    .select('id, ticker, pick_id, avg_cost_basis, current_price, weeks_held, picks(entry_thesis)')
    .gt('shares_held', 0);
  if (!positions || positions.length === 0) return { skipped: true, reason: 'No held positions.' };

  // Refresh prices so price-based rules use fresh data (best effort).
  try {
    const { prices } = await actionQuotes(positions.map((p: any) => p.ticker));
    await Promise.all(positions.map((p: any) => {
      const px = prices[p.ticker];
      if (px == null) return Promise.resolve();
      p.current_price = +Number(px).toFixed(2);
      return supa.from('position_tracker')
        .update({ current_price: p.current_price, updated_at: new Date().toISOString() })
        .eq('id', p.id);
    }));
  } catch { /* stale prices are acceptable */ }

  const requests = positions.map((p: any) => {
    const entry_thesis = p.picks?.entry_thesis;
    const prompt = buildWeeklyReviewPrompt(
      { ...p, entry_thesis },
      p.current_price || p.avg_cost_basis,
      `Search for recent news, earnings, and analyst updates for ${p.ticker}.`,
    );
    return {
      custom_id: p.id,
      params: {
        model: MODEL,
        max_tokens: 5000,
        system: 'You are a disciplined stock analyst reviewing held positions. Use web search for current news and prices. Be specific and evidence-based. Keep searches focused.',
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
        output_config: { format: { type: 'json_schema', schema: REVIEW_SCHEMA } },
        messages: [{ role: 'user', content: prompt }],
      },
    };
  });

  const batchId = await createReviewBatch(requests);
  const meta = positions.map((p: any) => ({
    cid: p.id, position_id: p.id, ticker: p.ticker, pick_id: p.pick_id,
    avg_cost_basis: p.avg_cost_basis, current_price: p.current_price, weeks_held: p.weeks_held,
  }));
  const { error } = await supa.from('weekly_review_runs')
    .insert({ week_date: weekDate, batch_id: batchId, status: 'running', positions: meta });
  if (error) throw new Error(`review run insert failed: ${error.message}`);
  return { started: true, positions: positions.length };
}

// Poll running review batches; when ended, write every position's review.
async function actionReviewPoll() {
  const { data: runs } = await supa
    .from('weekly_review_runs').select('*').eq('status', 'running')
    .gte('created_at', new Date(Date.now() - 36 * 3600_000).toISOString());
  if (!runs || runs.length === 0) return { running: 0 };

  for (const run of runs) {
    const br = await fetch(`https://api.anthropic.com/v1/messages/batches/${run.batch_id}`, {
      headers: anthropicHeaders(),
    });
    const batch = await br.json();
    if (batch.error) continue;
    if (batch.processing_status !== 'ended') continue;

    const rr = await fetch(
      batch.results_url || `https://api.anthropic.com/v1/messages/batches/${run.batch_id}/results`,
      { headers: anthropicHeaders() },
    );
    const lines = (await rr.text()).split('\n').filter((l) => l.trim());
    const metaById: Record<string, any> = {};
    (run.positions || []).forEach((m: any) => { metaById[m.cid] = m; });
    const weekDate = run.week_date;

    for (const line of lines) {
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      const meta = metaById[entry.custom_id];
      if (!meta || entry.result?.type !== 'succeeded') continue;
      const msg = entry.result.message;
      const textBlocks = (msg.content || []).filter((b: any) => b.type === 'text');
      const last = textBlocks[textBlocks.length - 1];
      if (!last) continue;
      let review: any;
      try { review = JSON.parse(last.text); } catch { continue; }

      const pos = {
        weeks_held: meta.weeks_held, avg_cost_basis: meta.avg_cost_basis,
        current_price: meta.current_price, ticker: meta.ticker,
      };
      const autoTriggers = evaluateSellRules(pos, {
        price_change_since_entry: review.price_change_since_entry,
        thesis_status: review.thesis_status,
      });
      const seen = new Set(autoTriggers.map((t) => t.trigger_type));
      (review.sell_triggers_fired || []).forEach((t: any) => {
        if (seen.has(t.trigger_type)) return;
        seen.add(t.trigger_type);
        autoTriggers.push({ trigger_type: t.trigger_type, trigger_description: `Flagged by weekly review: ${t.trigger_type}`, action_on_trigger: t.action });
      });

      await supa.from('position_tracker').update({
        thesis_intact: review.thesis_status === 'INTACT',
        last_reviewed: weekDate,
        updated_at: new Date().toISOString(),
      }).eq('id', meta.position_id);

      await supa.from('weekly_position_reviews').upsert({
        position_tracker_id: meta.position_id,
        week_date: weekDate,
        price_at_review: meta.current_price,
        price_change_wow: review.price_change_wow,
        price_change_since_entry: review.price_change_since_entry,
        market_context: review.market_context,
        industry_context: review.industry_context,
        company_specific_news: review.company_specific_news,
        thesis_status: review.thesis_status,
        hold_buy_sell_signal: review.hold_buy_sell_signal,
        signal_rationale: review.signal_rationale,
        earnings_review: review.earnings_review,
        post_earnings_notes: review.post_earnings_notes,
      }, { onConflict: 'position_tracker_id,week_date' });

      if (autoTriggers.length > 0 && meta.pick_id) {
        for (const trigger of autoTriggers) {
          const { data: existing } = await supa.from('sell_triggers').select('id')
            .eq('pick_id', meta.pick_id).eq('trigger_type', trigger.trigger_type)
            .eq('triggered', false).maybeSingle();
          if (existing) {
            await supa.from('sell_triggers').update({ triggered: true, triggered_date: weekDate }).eq('id', existing.id);
          } else {
            await supa.from('sell_triggers').insert({
              pick_id: meta.pick_id, ticker: meta.ticker, ...trigger,
              triggered: true, triggered_date: weekDate,
            });
          }
        }
      }
    }

    await supa.from('weekly_review_runs')
      .update({ status: 'done', updated_at: new Date().toISOString() })
      .eq('id', run.id);
  }
  return { processed: runs.length };
}

// ── Router ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  // claude-poll and scheduled-screen are allowed with any valid project JWT
  // (the cron jobs use the anon key): poll exposes no secrets and job ids are
  // unguessable UUIDs; scheduled-screen no-ops unless the last screen is over
  // 5 days old, so it cannot be abused to burn credits. Everything else still
  // requires a signed-in user.
  if (!['claude-poll', 'scheduled-screen', 'scheduled-review', 'review-poll'].includes(body.action) && !isAuthenticatedUser(req)) {
    return json({ error: 'Sign-in required' }, 401);
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
      case 'claude-start':
        return json(await actionClaudeStart(body));
      case 'scheduled-screen':
        return json(await actionScheduledScreen());
      case 'scheduled-review':
        return json(await actionScheduledReview());
      case 'review-poll':
        return json(await actionReviewPoll());
      case 'claude-poll':
        if (!body.job_id) return json({ error: 'job_id required' }, 400);
        return json(await actionClaudePoll(body));
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
              'You are a disciplined stock analyst reviewing held positions. Use web search for current news and prices. Be specific and evidence-based. Keep searches focused — a few targeted queries are enough.',
            userContent: body.prompt,
            schema: REVIEW_SCHEMA,
            // Light profile: one position, focused news lookup. Fewer searches
            // and no adaptive thinking so each review finishes well under the
            // 150s synchronous wall-clock limit (a full-thinking review was
            // timing out with a 546).
            maxSearches: 3,
            maxTokens: 5000,
            thinking: false,
          }),
        );
      default:
        return json({ error: `Unknown action: ${body.action}` }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
