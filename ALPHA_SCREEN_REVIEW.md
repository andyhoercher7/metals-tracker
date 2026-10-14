# Alpha Screen — Full Model & App Review

*Reviewed 2026-07-02. Scope: the Alpha Screen stock screener (React app in Google Drive `Alpha Screen/`, Supabase project `precious-metals-tracker` screener tables, and 4 weeks of live screen/pick/trade data).*

---

## 1. How the system works today (recap)

- **Weekly screen** (`RunScreen.jsx` → `anthropic.js`): one Claude Sonnet (`claude-sonnet-4-6`) call with web search (max 15 searches, 16K output tokens) is asked to run a "two-stage screen" of the ~2,500-stock ACWI universe, apply hard filters + factor weights, and return the top 10 picks as JSON.
- **Data correction layer**: Finnhub overwrites Claude's fundamentals (P/E, ROE, growth, D/E) when a key is present; Yahoo Finance (via public CORS proxies) re-anchors `price_at_pick` to the real prior close, preserving Claude's upside ratio for the target.
- **Position management** (`PositionTracker.jsx`): weekly per-position Claude reviews with web search → thesis status (INTACT/WEAKENING/BROKEN), HOLD/ADD/TRIM/SELL signal, written to `weekly_position_reviews`; code-side sell rules in `sellRules.js`; IVV same-dollars benchmark in `portfolio.js`.
- **Learning loop** (designed): `model_feedback` is read before every screen; `sell_trigger_overrules` tracks user-vs-model outcomes; `factor_weights` is versioned.

**What's genuinely good** — worth saying before the issues: the price-verification layer, the Finnhub fundamentals override, the IVV same-dollars/same-days benchmark with per-ticker alpha, the data-audit button, codified sell rules with plain-language reasons, and the overrule-outcome tracking design are all better than most hobby screeners. The bones are strong. The problems below are mostly about the model not actually doing what the design intends.

---

## 2. Critical integrity bugs (verified against live data)

### 2.1 Score scale drifts between 0–10 and 0–100 week to week
Observed in `picks`: 06-08 top score **9.4**, 06-15 **94**, 06-22 **9.4**, 06-29 **91**. The prompt pins qual factors to 1–10 but never pins `quant_score`/`composite_score`, so Claude alternates scales. Cross-week comparison, trend tracking, and any factor learning on these scores is currently meaningless.
**Fix**: pin the scale explicitly in the output schema ("all scores 0–100"), validate on ingest (reject or ×10 anything ≤10), and backfill the two 0–10 weeks.

### 2.2 The learning loop has never run
`model_feedback` has **0 rows**. Every screen dutifully loads "the last 8 weeks of feedback" and gets nothing, so the model never learns which factors or themes worked. This was the whole point of the closed-loop design.
**Fix**: a weekly job (Supabase scheduled edge function) that computes 1w/4w/12w forward returns vs IVV for every past pick, correlates factor values with forward returns (factor information coefficient), computes theme hit rates, and writes a `model_feedback` row. Only then can weight adjustments be evidence-based.

### 2.3 Earnings-based sell triggers can never fire
The review prompt asks Claude for `sell_triggers_fired`, but `handleWeeklyReview` in `PositionTracker.jsx` **never reads that field** — it only applies `evaluateSellRules()`, which covers drawdown/flat/target/time rules. `EARNINGS_MISS_GUIDANCE_CUT` and `EARNINGS_MISS_GUIDANCE_MAINTAINED` (55 trigger rows) are dead code paths. 151 triggers exist, 0 have ever fired.
**Fix**: process `reviewData.sell_triggers_fired` alongside the auto rules; better, pull the earnings calendar (Finnhub `/calendar/earnings` is free) so the review knows an earnings event happened and must explicitly judge miss/guidance.

### 2.4 Re-picked tickers create duplicate picks, orphan triggers, and re-doubled targets
AVGO, META, CIEN, FIX, LULU, UBER, EVER, VRT, AXON each have 2–3 `picks` rows. Each new row gets 5 fresh sell triggers (hence 151 rows), but `position_tracker.pick_id` points at only one, so most triggers are orphaned noise. Worse, targets recompute at 2× the *new* price: CIEN's target went $620 → $924.50 in one week purely because the stock rose. Targets ratchet upward and `TARGET_HIT` recedes forever.
**Fix**: on re-pick of a ticker with an ACTIVE pick, update the existing row (refresh scores/thesis, keep original entry price and target); picks that drop out of the top 10 → status `WATCHING`; sold out → `CLOSED`. All 40 picks are currently `ACTIVE`, which makes the status column meaningless.

### 2.5 Same-week review duplication (3× API spend, ambiguous signals)
06-29 has 45 reviews for 16 positions — ATI, AVGO, CIEN, AXON etc. each reviewed 3× that day (each button click re-inserts). The "latest signal" lookup then picks arbitrarily among conflicting rows (AVGO got both HOLD and ADD the same day).
**Fix**: upsert on `(position_tracker_id, week_date)`; skip positions already reviewed this week unless forced.

### 2.6 Stage 1 of the screen is fictional
`weekly_screens` contains exactly 10 rows per week — the final picks, all `passed_to_deep_screen = true`. There is no actual 50–100 company funnel; one LLM call with 15 searches cannot screen 2,500 stocks, so "stage 1" is Claude asserting a narrative. Momentum values are unverified LLM guesses (GOOGL 6-month momentum recorded as **+135%**; APP 6-month **−38%** alongside a maximally bullish thesis). The momentum factor (15% weight) is applied to noise.
**Fix**: see §4A — make stage 1 deterministic with real data.

### 2.7 Factor weights aren't actually applied
The composite works out to roughly 60/40 quant/qual (implicit, never specified), and the seven factor weights are just prompt seasoning — Claude is trusted to have applied "25% earnings growth, 20% valuation…" in its head. Unverifiable, and changing a weight in the DB won't reliably change anything.
**Fix**: compute the quant composite **in code** — cross-sectional z-score each factor over the screened universe, multiply by `factor_weights`, store per-factor contributions. Claude should only produce the qualitative 1–10 scores. This single change makes the weights real, the scores stable, and factor attribution possible.

### 2.8 The 60% US-listed mandate only warns
`RunScreen.jsx` logs "⚠ Consider re-running" and proceeds. Either enforce (drop lowest-ranked non-US picks and backfill) or delete the rule.

---

## 3. Security & robustness

1. **Anthropic API key ships to the browser** (`dangerouslyAllowBrowser: true`, `VITE_ANTHROPIC_API_KEY` in the bundle) and a `.env` with keys is sitting in Google Drive. Anyone with the deployed URL can lift the key. **Move all Claude calls into a Supabase edge function** (you already have exactly this pattern in the metals-tracker function) and **rotate the Anthropic and Finnhub keys**.
2. **Yahoo quotes route through `allorigins.win` / `corsproxy.io`** — third-party proxies that see all your traffic and fail intermittently. The metals edge function already fetches Yahoo server-side with no proxy; do the same for the screener.
3. **The metals edge function has `verify_jwt: false`** and its `parse-invoice` / `batch-product-prices` actions call Anthropic — anyone who finds the URL can drain API credits. Turn `verify_jwt` on (clients already send a bearer token).
4. **RLS is "any authenticated user, full access"** on all screener tables, in a project shared with the metals app. Fine for single-user, but worth scoping by `user_id` if anyone else ever gets an account.
5. **The app isn't in version control** — the source of a system that trades real money lives as loose files in Google Drive (`node_modules` included). Put it in a git repo.
6. Cosmetic: prices stored with float noise (`477.0799865722656`) — round to cents on write.

---

## 4. Making the model better

### A. Deterministic stage 1 — real data, no hallucinated funnel *(highest impact)*
Maintain a fixed universe (e.g., S&P 1500 + liquid ADRs, a few hundred to ~1,500 names) in a table. Weekly, for each name, pull real metrics — Finnhub `/stock/metric` for fundamentals (already integrated), Yahoo chart history for true 3m/6m momentum (already have `fetchHistoricalOpens`) — apply the hard filters in SQL/code, z-score and weight to a composite, store the **entire universe** in `weekly_screens` with pass/fail. Claude then does only what LLMs are good at: stage-2 qualitative research on the top ~15 verified names. Result: no invented numbers, a real funnel, and a factor dataset you can learn from. (Finnhub's free tier lacks a bulk screener endpoint; FMP or EODHD offer cheap screener APIs if you'd rather not iterate the universe.)

### B. Structured outputs instead of regex JSON extraction
`extractJson` brace-balancing plus "return ONLY valid JSON" is fragile (you've already coded around truncation). Define a tool schema and force a tool call — the API then guarantees parseable, schema-conforming output. Also upgrade the model: the screen/review calls use `claude-sonnet-4-6`; Sonnet 5 (`claude-sonnet-5`) is a straight upgrade for this workload at similar cost.

### C. Honest targets and probabilities
Every target is mechanically 2× (the mandate leaks into the math). Instead: bear/base/bull targets from forward EPS × multiple bands, an explicit `p_2x` estimate per pick, and track calibration (how often does a "70% conviction" pick actually double?). Keep the 2×-in-12-months *mandate* as a selection filter, not as the arithmetic for targets. The base rate for a 12-month double among quality mid/large caps is low single digits — knowing which picks the model thinks are 30% vs 5% likely is where the alpha discipline is.

### D. Portfolio construction & risk
- **Theme concentration**: ~70% of picks and most held dollars are the `AI_EFFICIENCY` theme — MU, AVGO, CIEN, FIX, VRT, LRCX, TSM, ANET, APP correlate heavily. One AI-capex sentiment shock hits nearly the whole sleeve at once. Add caps: e.g., ≤50% of new-buy dollars per macro theme, ≤2 picks per industry per week.
- **Position sizing**: currently flat ~$900/pick. Size by conviction × inverse volatility instead (higher composite + lower realized vol → larger), and reserve dry powder for ADD signals so adds don't require new cash.
- **Tighter risk for a 2x sleeve**: −25% after 6 weeks is a slow stop for a high-beta portfolio (WLDN hit −17.7% in 3 weeks with no rule anywhere near firing). Consider a trailing stop (e.g., −20% from post-entry high) and "WEAKENING two consecutive weeks → forced TRIM review".
- **Benchmark honestly**: IVV is the right baseline, but given the tech tilt also track QQQ — beating the S&P while trailing the Nasdaq would tell you the "alpha" is just beta.

### E. Strategy ideas to layer in
1. **Earnings-revision momentum / PEAD sleeve**: use real analyst estimate revisions (Finnhub estimates endpoints) rather than Claude's UP/DOWN guess — currently every single pick has `analyst_revision_direction = UP`, which is a tell that it's narrative, not data.
2. **Insider buying filter**: cluster insider buys are one of the few public signals with documented forward alpha; Finnhub has the data free.
3. **Relative strength vs sector ETF** instead of absolute momentum — separates stock selection from sector beta.
4. **Short-interest / days-to-cover sanity check** on every pick.
5. **Paper-cohort tracking**: you buy ~5 of each week's 10 picks. Track the *unbought* half's forward returns too — it cleanly separates model skill from execution choices, and doubles your learning data for free.
6. **Regime awareness**: a simple market-regime flag (e.g., S&P vs 200-day, VIX bands) that scales weekly deployment rather than buying a fixed amount every week regardless of tape.

### F. Efficiency & ops
- **Batch the weekly reviews**: 16 sequential web-search calls (×3 when re-clicked) is the biggest spend. One call reviewing 4–5 positions, run in parallel, with an upsert guard, cuts review cost ~5–10×.
- **Automate the cadence**: scheduled edge functions for the Monday screen, the weekly review, price refresh, and the §2.2 feedback job — removes the manual-click failure mode that caused the triple reviews.
- **Cache stage-1 data**: fundamentals change quarterly; don't re-fetch the universe's metrics weekly, refresh on earnings dates.

---

## 5. Suggested order of attack

| Priority | Item | Why first |
|---|---|---|
| 1 | Rotate keys; move Claude + Yahoo calls to edge function (§3.1–3.3) | Live key exposure |
| 2 | Pin score scale + backfill (§2.1); round prices | Unblocks all measurement |
| 3 | Review upsert guard (§2.5); wire `sell_triggers_fired` (§2.3) | Stops spend leak; makes sell discipline real |
| 4 | Pick lifecycle: update-don't-duplicate, close stale picks (§2.4) | Cleans the ledger the loop learns from |
| 5 | Deterministic stage 1 + code-computed composite (§4A, §2.7) | The model's numbers become real |
| 6 | Feedback job writing `model_feedback` (§2.2) | The loop finally closes |
| 7 | Theme caps, sizing, trailing stops (§4D) | Risk before more alpha-seeking |
| 8 | Structured outputs + model upgrade (§4B), batched reviews (§4F) | Quality + cost |

---

*Sources reviewed: `RunScreen.jsx`, `PositionTracker.jsx`, `systemPrompt.js`, `anthropic.js`, `fundamentals.js`, `prices.js`, `sellRules.js`, `portfolio.js`, `screeningPrompts.js`, `schema.sql`, `rls-policies.sql`; Supabase tables `factor_weights`, `weekly_screens`, `picks`, `qual_scores`, `trades`, `position_tracker`, `weekly_position_reviews`, `sell_triggers`, `sell_trigger_overrules`, `model_feedback`; metals-tracker edge function v21.*
