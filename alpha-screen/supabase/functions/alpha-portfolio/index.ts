// alpha-portfolio: weekly conviction-weighted allocation for the portfolio.
//
// Encodes the portfolio rules:
//   * hard cap 20 positions, steer toward 15 or fewer
//   * max 20% target weight in any single name
//   * no new cash — every buy is funded by a sell or trim in the same plan
//   * a new pick enters ONLY by clearly beating a current holding (swap),
//     otherwise no trades at all
//
// Runs synchronously (no web search, no extended thinking) so it finishes
// well inside the platform's 150s limit: all the fresh data it needs — this
// week's picks, the weekly position reviews, live prices — already exists.
import { createClient } from 'npm:@supabase/supabase-js@2';

const MODEL = 'claude-opus-4-8';

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

// ── Yahoo Finance quotes (same pattern as alpha-screen) ─────────────────────

async function fetchClose(ticker: string): Promise<number | null> {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=7d`,
      { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(20000) },
    );
    if (!r.ok) return null;
    const data = await r.json();
    const res = data?.chart?.result?.[0];
    const live = res?.meta?.regularMarketPrice;
    if (typeof live === 'number' && live > 0) return live;
    const closes: (number | null)[] = res?.indicators?.quote?.[0]?.close || [];
    for (let i = closes.length - 1; i >= 0; i--) if (closes[i] != null) return closes[i]!;
    return null;
  } catch {
    return null;
  }
}

async function fetchQuotes(tickers: string[]): Promise<Record<string, number>> {
  const unique = [...new Set(tickers)].slice(0, 50);
  const results = await Promise.allSettled(unique.map(fetchClose));
  const prices: Record<string, number> = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value != null) prices[unique[i]] = r.value;
  });
  return prices;
}

// ── Claude call (structured output, retries on transient errors) ────────────

const ALLOC_SCHEMA = {
  type: 'object',
  required: ['summary', 'target_weights', 'trades', 'no_trade_reason'],
  additionalProperties: false,
  properties: {
    summary: {
      type: 'string',
      description: 'Plain-English 3-6 sentence summary of this week\'s allocation decision for a non-professional investor.',
    },
    target_weights: {
      type: 'array',
      description: 'One entry per position kept in the portfolio after the recommended trades.',
      items: {
        type: 'object',
        required: ['ticker', 'target_weight_pct', 'conviction', 'rationale'],
        additionalProperties: false,
        properties: {
          ticker: { type: 'string' },
          target_weight_pct: { type: 'number', description: '0-20, all entries sum to ~100' },
          conviction: { type: 'integer', description: '1 (lowest) to 10 (highest)' },
          rationale: { type: 'string', description: 'One sentence.' },
        },
      },
    },
    trades: {
      type: 'array',
      description: 'Recommended trades, empty if nothing clears the replacement bar.',
      items: {
        type: 'object',
        required: ['action', 'ticker', 'dollars', 'rationale', 'replaces'],
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['SELL_ALL', 'TRIM', 'ADD', 'BUY_NEW'] },
          ticker: { type: 'string' },
          dollars: { type: 'number', description: 'Approximate dollars, positive.' },
          replaces: {
            type: ['string', 'null'],
            description: 'For BUY_NEW: the holding being sold to fund it. Null otherwise.',
          },
          rationale: { type: 'string', description: 'One or two sentences.' },
        },
      },
    },
    no_trade_reason: {
      type: ['string', 'null'],
      description: 'When trades is empty: why nothing clears the bar this week.',
    },
  },
};

async function callClaude(system: string, userContent: string) {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured on the edge function');

  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 3000));
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 6000,
        system,
        output_config: { format: { type: 'json_schema', schema: ALLOC_SCHEMA } },
        messages: [{ role: 'user', content: userContent }],
      }),
    });
    const data = await r.json();
    if (data.error) {
      lastErr = data.error.message || String(data.error.type);
      const transient = r.status === 429 || r.status >= 500 ||
        ['overloaded_error', 'api_error', 'rate_limit_error'].includes(data.error.type);
      if (transient) continue;
      throw new Error(`Anthropic API: ${lastErr}`);
    }
    if (data.stop_reason === 'refusal') throw new Error('Model declined the request.');
    if (data.stop_reason === 'max_tokens') {
      throw new Error('Allocation response hit the token limit. Try again.');
    }
    const textBlocks = (data.content || []).filter((b: { type: string }) => b.type === 'text');
    const last = textBlocks[textBlocks.length - 1];
    if (!last) throw new Error('No text content in model response.');
    return JSON.parse(last.text);
  }
  throw new Error(`Anthropic API: ${lastErr || 'repeated transient errors'}`);
}

// ── Data assembly ───────────────────────────────────────────────────────────

async function loadPortfolioData() {
  const { data: positions, error: posErr } = await supa
    .from('position_tracker')
    .select('id, ticker, shares_held, avg_cost_basis, unrealized_pnl_pct, weeks_held, thesis_intact')
    .gt('shares_held', 0);
  if (posErr) throw posErr;
  if (!positions || positions.length === 0) throw new Error('No positions to allocate.');

  // This cycle's screen picks (most recent week within 12 days).
  const { data: latestPick } = await supa
    .from('picks')
    .select('week_date')
    .order('week_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  let picks: Record<string, unknown>[] = [];
  if (latestPick && Date.now() - new Date(latestPick.week_date).getTime() < 12 * 86400_000) {
    const { data } = await supa
      .from('picks')
      .select('ticker, company_name, composite_score, price_at_pick, target_price, target_price_bull, target_price_bear, p_2x, entry_thesis, macro_theme')
      .eq('week_date', latestPick.week_date)
      .order('composite_score', { ascending: false });
    picks = data || [];
  }

  // Latest weekly review per position.
  const ids = positions.map((p) => p.id);
  const { data: reviews } = await supa
    .from('weekly_position_reviews')
    .select('position_tracker_id, week_date, thesis_status, hold_buy_sell_signal, signal_rationale')
    .in('position_tracker_id', ids)
    .order('week_date', { ascending: false });
  const reviewById: Record<string, { thesis_status: string; hold_buy_sell_signal: string; signal_rationale: string }> = {};
  (reviews || []).forEach((r) => {
    if (!reviewById[r.position_tracker_id]) reviewById[r.position_tracker_id] = r;
  });

  // Triggered sell rules and the user's decisions on them.
  const tickers = positions.map((p) => p.ticker);
  const { data: trigs } = await supa
    .from('sell_triggers')
    .select('id, ticker, trigger_type, action_on_trigger')
    .eq('triggered', true)
    .in('ticker', tickers);
  const trigIds = (trigs || []).map((t) => t.id);
  const decidedById: Record<string, string> = {};
  if (trigIds.length) {
    const { data: ovr } = await supa
      .from('sell_trigger_overrules')
      .select('sell_trigger_id, user_decision')
      .in('sell_trigger_id', trigIds);
    (ovr || []).forEach((o) => { decidedById[o.sell_trigger_id] = o.user_decision; });
  }
  const rulesByTicker: Record<string, string[]> = {};
  (trigs || []).forEach((t) => {
    const decision = decidedById[t.id];
    const note = `${t.trigger_type} fired (${t.action_on_trigger})` +
      (decision ? ` — user decided: ${decision}` : ' — undecided');
    (rulesByTicker[t.ticker] = rulesByTicker[t.ticker] || []).push(note);
  });

  return { positions, picks, reviewById, rulesByTicker };
}

// ── Server-side enforcement of the hard rules ───────────────────────────────

const MAX_WEIGHT = 20;
const MAX_POSITIONS = 20;
const MIN_TRADE_DOLLARS = 150;

type Weight = { ticker: string; target_weight_pct: number; conviction: number; rationale: string };
type Trade = { action: string; ticker: string; dollars: number; replaces: string | null; rationale: string };

// Cap every weight at 20% and renormalize the rest so the total stays ~100.
function enforceWeights(weights: Weight[]): Weight[] {
  const out = weights.map((w) => ({
    ...w,
    target_weight_pct: Math.max(0, w.target_weight_pct),
    conviction: Math.min(10, Math.max(1, Math.round(w.conviction || 5))),
  }));
  for (let pass = 0; pass < 4; pass++) {
    const total = out.reduce((s, w) => s + w.target_weight_pct, 0);
    if (total <= 0) break;
    out.forEach((w) => { w.target_weight_pct = (w.target_weight_pct / total) * 100; });
    const over = out.filter((w) => w.target_weight_pct > MAX_WEIGHT);
    if (over.length === 0) break;
    let excess = 0;
    over.forEach((w) => { excess += w.target_weight_pct - MAX_WEIGHT; w.target_weight_pct = MAX_WEIGHT; });
    const under = out.filter((w) => w.target_weight_pct < MAX_WEIGHT);
    const underTotal = under.reduce((s, w) => s + w.target_weight_pct, 0);
    if (underTotal <= 0) break;
    under.forEach((w) => {
      w.target_weight_pct = Math.min(MAX_WEIGHT, w.target_weight_pct + excess * (w.target_weight_pct / underTotal));
    });
  }
  out.forEach((w) => { w.target_weight_pct = +w.target_weight_pct.toFixed(1); });
  return out;
}

function enforceTrades(trades: Trade[], heldTickers: Set<string>): Trade[] {
  let out = trades
    .map((t) => ({ ...t, dollars: Math.round(Math.abs(t.dollars)) }))
    .filter((t) => t.dollars >= MIN_TRADE_DOLLARS);

  // No new cash: scale buys down to what the sells actually free up.
  const sells = out.filter((t) => t.action === 'SELL_ALL' || t.action === 'TRIM')
    .reduce((s, t) => s + t.dollars, 0);
  const buys = out.filter((t) => t.action === 'BUY_NEW' || t.action === 'ADD')
    .reduce((s, t) => s + t.dollars, 0);
  if (buys > sells) {
    const ratio = sells / buys;
    out = out.map((t) =>
      t.action === 'BUY_NEW' || t.action === 'ADD'
        ? { ...t, dollars: Math.round(t.dollars * ratio) }
        : t,
    ).filter((t) => t.dollars >= MIN_TRADE_DOLLARS);
  }

  // Hard cap on total positions after the plan executes.
  const sold = new Set(out.filter((t) => t.action === 'SELL_ALL').map((t) => t.ticker));
  const added = out.filter((t) => t.action === 'BUY_NEW' && !heldTickers.has(t.ticker));
  let count = heldTickers.size - sold.size + added.length;
  while (count > MAX_POSITIONS && added.length > 0) {
    const dropped = added.pop()!;
    out = out.filter((t) => t !== dropped);
    count--;
  }
  return out;
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function actionRecommend(force: boolean) {
  // Idempotent per cycle: cron retries and app opens reuse this week's run.
  if (!force) {
    const { data: recent } = await supa
      .from('allocation_runs')
      .select('*')
      .eq('status', 'done')
      .gte('created_at', new Date(Date.now() - 3 * 86400_000).toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recent) return { run: recent, existing: true };
  }

  const { positions, picks, reviewById, rulesByTicker } = await loadPortfolioData();
  const heldTickers = new Set(positions.map((p) => p.ticker));
  const allTickers = [...heldTickers, ...picks.map((p) => p.ticker as string)];
  const prices = await fetchQuotes(allTickers);

  const holdings = positions.map((p) => {
    const price = prices[p.ticker] ?? null;
    const value = price != null ? +(p.shares_held * price).toFixed(2) : null;
    return { pos: p, price, value };
  });
  const totalValue = holdings.reduce((s, h) => s + (h.value ?? 0), 0);
  if (totalValue <= 0) throw new Error('Could not price the portfolio (no live quotes).');

  const holdingsData = holdings.map((h) => {
    const rev = reviewById[h.pos.id];
    return {
      ticker: h.pos.ticker,
      value_usd: h.value,
      // Price and share count let the app turn a target weight into an exact
      // "buy/sell $X (~N shares)" instruction.
      price: h.price,
      shares: h.pos.shares_held,
      weight_pct: h.value != null ? +((h.value / totalValue) * 100).toFixed(1) : null,
      unrealized_pnl_pct: h.pos.unrealized_pnl_pct,
      weeks_held: h.pos.weeks_held,
      thesis_intact: h.pos.thesis_intact,
      latest_review: rev
        ? { signal: rev.hold_buy_sell_signal, thesis: rev.thesis_status, note: rev.signal_rationale }
        : null,
      sell_rules: rulesByTicker[h.pos.ticker] || [],
    };
  });

  const candidatesData = picks.map((p) => ({
    ticker: p.ticker,
    company: p.company_name,
    composite_score: p.composite_score,
    live_price: prices[p.ticker as string] ?? p.price_at_pick,
    target_price: p.target_price,
    bull_bear: [p.target_price_bull, p.target_price_bear],
    p_2x: p.p_2x,
    macro_theme: p.macro_theme,
    thesis: p.entry_thesis,
    already_held: heldTickers.has(p.ticker as string),
  }));

  const system = `You are a disciplined portfolio manager running a single concentrated equity portfolio for a long-term individual investor. Each week you set conviction-based target weights and decide whether any of this week's new screen picks deserves a spot.

HARD RULES (violations will be corrected by code, so just follow them):
1. NO NEW CASH. Every BUY_NEW or ADD dollar must be funded by SELL_ALL or TRIM dollars in this same plan. Dollar totals of buys must not exceed dollar totals of sells.
2. Max 20% target weight in any single name.
3. Hard cap 20 positions; actively steer toward 15 or fewer. When at or above 15, prefer consolidating into best ideas over adding names.
4. Conviction drives weight: score every kept holding 1-10; higher conviction gets higher target weight (subject to the 20% cap). Weights sum to ~100 and cover every kept position.
5. THE REPLACEMENT BAR: a new pick enters ONLY by replacing a current holding it CLEARLY beats on 12-month risk-adjusted outlook — meaningfully higher expected return or the incumbent's thesis is impaired. Ties or marginal edges go to the incumbent (it has history, known behavior, and swapping costs taxes). If nothing clears the bar, return an empty trades array and say why in no_trade_reason.
6. Churn discipline: at most 3 swaps per week, no trades under $150, and remember sells of winners create taxable gains — a swap must be worth that drag.
7. Respect the user's recorded decisions: if a sell rule fired and the user chose to hold (overruled), do not recommend exiting that name this week unless something is materially broken beyond what they already saw.

Weigh: each holding's latest weekly review (signal, thesis status), momentum vs entry, weeks held, and each candidate's composite score, upside to target, and probability of doubling. Be decisive but honest — most weeks the right answer is few or zero trades.`;

  const userContent = `Portfolio as of ${new Date().toISOString().slice(0, 10)} — total value $${Math.round(totalValue).toLocaleString()}, ${positions.length} positions (${positions.length > 15 ? 'ABOVE the 15-name target, bias toward consolidation' : 'within the 15-name target'}).

CURRENT HOLDINGS:
${JSON.stringify(holdingsData, null, 1)}

THIS WEEK'S SCREEN CANDIDATES:
${JSON.stringify(candidatesData, null, 1)}

Produce this week's allocation: conviction + target weight for every kept holding, and the trade list (or an empty list with no_trade_reason). For BUY_NEW trades set "replaces" to the holding being sold to fund it.`;

  const weekDate = new Date().toISOString().slice(0, 10);
  try {
    const raw = await callClaude(system, userContent);
    const weights = enforceWeights((raw.target_weights || []) as Weight[]);
    const trades = enforceTrades((raw.trades || []) as Trade[], heldTickers);
    const recommendation = {
      summary: raw.summary,
      no_trade_reason: raw.no_trade_reason ?? null,
      target_weights: weights,
      trades,
      holdings_snapshot: holdingsData,
      total_value: +totalValue.toFixed(2),
      candidates_considered: candidatesData.map((c) => c.ticker),
    };
    const { data: run, error } = await supa
      .from('allocation_runs')
      .insert({ week_date: weekDate, status: 'done', recommendation })
      .select()
      .single();
    if (error) throw error;
    return { run, existing: false };
  } catch (err) {
    await supa.from('allocation_runs').insert({
      week_date: weekDate,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function actionLatest() {
  const { data: run } = await supa
    .from('allocation_runs')
    .select('*')
    .eq('status', 'done')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!run) return { run: null, decisions: [] };
  const { data: decisions } = await supa
    .from('allocation_decisions')
    .select('trade_key, decision')
    .eq('run_id', run.id);
  return { run, decisions: decisions || [] };
}

// ── HTTP entrypoint ─────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'latest';
    if (action === 'recommend') return json(await actionRecommend(!!body.force));
    if (action === 'latest') return json(await actionLatest());
    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
