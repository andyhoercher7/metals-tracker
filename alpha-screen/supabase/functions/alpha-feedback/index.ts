// Alpha Screen learning loop. (Deployed to Supabase as `alpha-feedback`,
// verify_jwt enabled; invoked weekly by the pg_cron job
// `alpha-feedback-weekly`, Fridays 21:30 UTC. This copy is for version control.)
//
// Computes forward returns for every pick vs IVV since its pick date,
// correlates entry-time factor values with subsequent alpha (factor ICs),
// scores macro-theme accuracy AND per-screen-variant (cohort) performance,
// and writes one model_feedback row for this week. The weekly screen reads
// the last 8 rows before generating picks.
//
// Cohorts: picks are tagged with screen_variant ('llm' today). When a second
// screening method is added (e.g. a paid data-API screener), tag its picks
// with a new variant and this job reports the head-to-head forward alpha.
//
// Cheap and idempotent (re-runs replace this week's row), no LLM calls — so
// it accepts any valid project JWT (pg_cron invokes it with the anon key).

import { createClient } from 'npm:@supabase/supabase-js@2';

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

// ── Yahoo Finance helpers ───────────────────────────────────────────────────

async function yahooJson(url: string) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
  return r.json();
}

function lastClose(result: any): number | null {
  const ts: number[] = result?.timestamp || [];
  const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close || [];
  for (let i = ts.length - 1; i >= 0; i--) if (closes[i] != null) return closes[i];
  return null;
}

async function fetchCloses(tickers: string[]) {
  const unique = [...new Set(tickers)];
  const results = await Promise.allSettled(
    unique.map(async (t) => {
      const data = await yahooJson(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=7d`,
      );
      const p = lastClose(data?.chart?.result?.[0]);
      if (p == null) throw new Error('no close');
      return p;
    }),
  );
  const prices: Record<string, number> = {};
  results.forEach((r, i) => { if (r.status === 'fulfilled') prices[unique[i]] = r.value; });
  return prices;
}

// Daily opens for a ticker since startDate: { 'YYYY-MM-DD': open }
async function fetchOpens(ticker: string, startDate: string) {
  const start = Math.floor(new Date(startDate + 'T00:00:00Z').getTime() / 1000) - 5 * 86400;
  const end = Math.floor(Date.now() / 1000) + 86400;
  const data = await yahooJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${start}&period2=${end}`,
  );
  const r = data?.chart?.result?.[0];
  const ts: number[] = r?.timestamp || [];
  const opens: (number | null)[] = r?.indicators?.quote?.[0]?.open || [];
  const map: Record<string, number> = {};
  ts.forEach((t, i) => {
    if (opens[i] != null) map[new Date(t * 1000).toISOString().slice(0, 10)] = opens[i]!;
  });
  return { opens: map, current: lastClose(r) };
}

// First available open on/after a date (walks forward across weekends).
function openOnOrAfter(opens: Record<string, number>, dateStr: string): number | null {
  const d = new Date(dateStr + 'T00:00:00Z');
  for (let i = 0; i < 10; i++) {
    const k = d.toISOString().slice(0, 10);
    if (opens[k] != null) return opens[k];
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return null;
}

// ── Stats ───────────────────────────────────────────────────────────────────

function pearson(pairs: [number, number][]): number | null {
  const n = pairs.length;
  if (n < 6) return null; // too few points to mean anything
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n;
  const my = pairs.reduce((s, p) => s + p[1], 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (const [x, y] of pairs) {
    num += (x - mx) * (y - my);
    dx += (x - mx) ** 2;
    dy += (y - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return +(num / Math.sqrt(dx * dy)).toFixed(3);
}

const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r2 = (n: number | null) => (n == null ? null : +n.toFixed(2));

function scoreboard(rows: any[], key: string) {
  const out: Record<string, { n: number; avg_alpha: number | null; hit_rate: number | null }> = {};
  for (const val of [...new Set(rows.map((r) => r[key]))]) {
    const t = rows.filter((r) => r[key] === val);
    out[String(val)] = {
      n: t.length,
      avg_alpha: r2(mean(t.map((x) => x.alpha))),
      hit_rate: r2(t.filter((x) => x.alpha > 0).length / t.length * 100),
    };
  }
  return out;
}

// ── Main ────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  try {
    const db = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: picks, error: pickErr } = await db
      .from('picks')
      .select('id, ticker, week_date, price_at_pick, target_price, p_2x, macro_theme, status, screen_variant')
      .not('price_at_pick', 'is', null);
    if (pickErr) throw pickErr;
    if (!picks?.length) return json({ ok: false, reason: 'no picks with entry prices' });

    const { data: screens, error: scrErr } = await db
      .from('weekly_screens')
      .select('ticker, week_date, forward_pe, roe, eps_growth_yoy, revenue_growth, debt_equity, price_momentum_3m, price_momentum_6m, gross_margin')
      .order('week_date', { ascending: true });
    if (scrErr) throw scrErr;

    // Entry-time factors = the EARLIEST screen row per ticker.
    const factorsByTicker: Record<string, any> = {};
    (screens || []).forEach((s) => {
      if (!factorsByTicker[s.ticker]) factorsByTicker[s.ticker] = s;
    });

    // Dedupe picks to one per (ticker, variant), earliest = entry, so
    // re-picked tickers don't double-count but each cohort keeps its own entry.
    const byKey: Record<string, any> = {};
    picks
      .sort((a, b) => (a.week_date < b.week_date ? -1 : 1))
      .forEach((p) => {
        const k = `${p.ticker}|${p.screen_variant || 'llm'}`;
        if (!byKey[k]) byKey[k] = p;
      });
    const entries = Object.values(byKey) as any[];

    const earliest = entries.reduce((m, p) => (p.week_date < m ? p.week_date : m), entries[0].week_date);
    const [prices, ivv] = await Promise.all([
      fetchCloses(entries.map((p) => p.ticker)),
      fetchOpens('IVV', earliest),
    ]);
    if (ivv.current == null) throw new Error('No IVV price');

    // Per-pick forward return and alpha vs IVV over the same window.
    const rows: any[] = [];
    for (const p of entries) {
      const now = prices[p.ticker];
      const ivvEntry = openOnOrAfter(ivv.opens, p.week_date);
      if (now == null || ivvEntry == null || !p.price_at_pick) continue;
      const ret = (now / p.price_at_pick - 1) * 100;
      const ivvRet = (ivv.current / ivvEntry - 1) * 100;
      const targetRet = p.target_price ? (p.target_price / p.price_at_pick - 1) * 100 : null;
      rows.push({
        ticker: p.ticker,
        week_date: p.week_date,
        status: p.status,
        macro_theme: p.macro_theme || 'OTHER',
        variant: p.screen_variant || 'llm',
        ret: r2(ret),
        ivv_ret: r2(ivvRet),
        alpha: r2(ret - ivvRet),
        target_progress_pct: targetRet && targetRet > 0 ? r2((ret / targetRet) * 100) : null,
        factors: factorsByTicker[p.ticker] || null,
      });
    }
    if (!rows.length) return json({ ok: false, reason: 'no picks with complete price data' });

    // Factor ICs: correlation between entry factor value and subsequent alpha.
    // Sign convention: for "lower is better" factors (valuation, leverage) a
    // NEGATIVE IC means the factor worked as intended.
    const FACTORS = [
      'forward_pe', 'roe', 'eps_growth_yoy', 'revenue_growth',
      'debt_equity', 'price_momentum_3m', 'price_momentum_6m', 'gross_margin',
    ];
    const ics: Record<string, number | null> = {};
    for (const f of FACTORS) {
      const pairs: [number, number][] = rows
        .filter((r) => r.factors && r.factors[f] != null)
        .map((r) => [Number(r.factors[f]), r.alpha]);
      ics[f] = pearson(pairs);
    }
    const LOWER_IS_BETTER = new Set(['forward_pe', 'debt_equity']);
    const effective = Object.entries(ics)
      .filter(([, v]) => v != null)
      .map(([f, v]) => [f, LOWER_IS_BETTER.has(f) ? -(v as number) : (v as number)] as [string, number]);
    effective.sort((a, b) => b[1] - a[1]);
    const best = effective[0] || null;
    const worst = effective[effective.length - 1] || null;

    // Scoreboards: macro theme and screen-variant cohorts.
    const themes = scoreboard(rows, 'macro_theme');
    const cohorts = scoreboard(rows, 'variant');

    const distinctWeeks = new Set(picks.map((p: any) => p.week_date)).size;

    // Build a concrete, applyable weight recommendation from the factor ICs.
    // Raw IC factors map to the 7 tunable weight categories; we nudge weight
    // from the worst-performing category toward the best by one small step,
    // clamp to sane bounds, and renormalise to sum to 1. This is what the
    // Model Feedback screen's Accept button applies.
    const { data: cw } = await db
      .from('factor_weights').select('*')
      .order('effective_date', { ascending: false }).limit(1).maybeSingle();
    const FACTOR_TO_WEIGHT: Record<string, string> = {
      forward_pe: 'valuation_weight', roe: 'quality_weight', gross_margin: 'quality_weight',
      eps_growth_yoy: 'earnings_growth_weight', revenue_growth: 'revenue_growth_weight',
      debt_equity: 'balance_sheet_weight',
      price_momentum_3m: 'momentum_weight', price_momentum_6m: 'momentum_weight',
    };
    const WEIGHT_KEYS = [
      'earnings_growth_weight', 'valuation_weight', 'momentum_weight', 'quality_weight',
      'revenue_growth_weight', 'balance_sheet_weight', 'analyst_revision_weight',
    ];
    let recommended_weights: Record<string, { current: number; suggested: number }> | null = null;
    let rec_rationale = '';
    if (cw && best && worst) {
      const cur: Record<string, number> = {};
      WEIGHT_KEYS.forEach((k) => { cur[k] = Number((cw as any)[k]) || 0; });
      const upKey = FACTOR_TO_WEIGHT[best[0]];
      const downKey = FACTOR_TO_WEIGHT[worst[0]];
      const next = { ...cur };
      const STEP = 0.02;
      if (upKey && downKey && upKey !== downKey) {
        next[upKey] = Math.min(0.40, cur[upKey] + STEP);
        next[downKey] = Math.max(0.02, cur[downKey] - STEP);
        rec_rationale =
          `Shift ${(STEP * 100).toFixed(0)}pp from ${downKey.replace(/_/g, ' ')} (weakest predictor, ${worst[0]}) ` +
          `to ${upKey.replace(/_/g, ' ')} (strongest, ${best[0]}).`;
      } else {
        rec_rationale = 'Best and worst factors map to the same weight bucket — no change recommended this week.';
      }
      const sum = WEIGHT_KEYS.reduce((s, k) => s + next[k], 0) || 1;
      recommended_weights = {};
      WEIGHT_KEYS.forEach((k) => {
        recommended_weights![k] = { current: +cur[k].toFixed(4), suggested: +(next[k] / sum).toFixed(4) };
      });
    }

    const suggestions = {
      status: distinctWeeks >= 8 ? 'ok' : 'early',
      weeks_of_history: distinctWeeks,
      weeks_recommended: 8,
      confidence: distinctWeeks >= 8 ? 'directional' : 'low',
      factor_ics: ics,
      cohorts,
      recommended_weights,
      recommendation_rationale: rec_rationale,
      guidance:
        'ICs are alpha-predictive when positive (or negative for forward_pe/debt_equity). ' +
        'Recommendation shifts weight toward high-|IC| factors in a 2pp step. Sample is small — ' +
        'treat as directional. Compare cohorts on avg_alpha and hit_rate before trusting a new method with real money.',
    };

    const avgAlpha = r2(mean(rows.map((x) => x.alpha)));
    const progress = rows.map((x) => x.target_progress_pct).filter((v) => v != null) as number[];
    const cohortLine = Object.entries(cohorts)
      .map(([k, v]) => `${k}: n=${v.n}, avg alpha ${v.avg_alpha}%, hit rate ${v.hit_rate}%`)
      .join(' | ');
    const notes =
      `${rows.length} tickers tracked over ${distinctWeeks} screen week(s). ` +
      `Avg return ${r2(mean(rows.map((x) => x.ret)))}%, avg alpha vs IVV ${avgAlpha}%. ` +
      `Cohorts — ${cohortLine}. ` +
      `Best factor: ${best ? `${best[0]} (effective IC ${best[1]})` : 'n/a'}; ` +
      `worst: ${worst ? `${worst[0]} (effective IC ${worst[1]})` : 'n/a'}. ` +
      `Sample is small — treat ICs as directional only. Per-ticker: ` +
      rows.map((x) => `${x.ticker} ${x.alpha >= 0 ? '+' : ''}${x.alpha}%`).join(', ') + '.';

    const weekDate = new Date().toISOString().slice(0, 10);
    await db.from('model_feedback').delete().eq('week_date', weekDate);
    const { error: insErr } = await db.from('model_feedback').insert({
      week_date: weekDate,
      picks_reviewed_count: rows.length,
      avg_return_vs_target: progress.length ? r2(mean(progress)) : null,
      best_performing_factor: best ? best[0] : null,
      worst_performing_factor: worst ? worst[0] : null,
      suggested_weight_adjustments: suggestions,
      macro_theme_accuracy: themes,
      notes,
    });
    if (insErr) throw insErr;

    return json({ ok: true, week_date: weekDate, picks: rows.length, avg_alpha: avgAlpha, cohorts, themes, factor_ics: ics });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
