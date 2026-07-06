# Alpha Screen upgrade — what changed and what you must do

This directory contains the fixed Alpha Screen files. It implements the top of
the priority list from `ALPHA_SCREEN_REVIEW.md`. Two parts are **already live**
(done directly against your Supabase project); the client files here are
**drop-in replacements** you copy into your local `Alpha Screen/` project.

## Already done (live in Supabase)

### Database (project `precious-metals-tracker`, applied as migrations)
1. **Score scale normalized** — the two 0–10 weeks were rescaled ×10; all
   picks/screens are now on one 0–100 scale.
2. **Duplicate reviews removed** — 13 same-week duplicate position reviews
   deleted (backed up in `weekly_position_reviews_dupes_backup`), plus a unique
   index on `(position_tracker_id, week_date)` so it can't recur.
3. **Pick lifecycle** — `ACTIVE` now means "backs a held position" (16 picks,
   matching your 16 positions); the other 24 are `WATCHING`. A partial unique
   index enforces one ACTIVE pick per ticker.
4. **Prices rounded** to cents (no more `477.0799865722656`).
5. **New pick columns**: `target_price_bear`, `target_price_bull`, `p_2x`
   (probability of doubling, 0–1) for honest targets.

### New edge function: `alpha-screen` (deployed, JWT-verified)
All Anthropic / Yahoo / Finnhub calls now run server-side:
- No API keys in the browser, no third-party CORS proxies.
- Requires a signed-in user (the public anon key alone is rejected).
- Model upgraded to **Claude Opus 4.8** with adaptive thinking.
- Output is **schema-enforced JSON** (`output_config.format`) — the fragile
  regex JSON extraction is gone; responses are guaranteed parseable and typed.

## What YOU must do (in order)

1. **Rotate your Anthropic API key** at console.anthropic.com — the old one
   shipped in the browser bundle and must be treated as compromised. Put the
   new key in Supabase: Dashboard → Edge Functions → Secrets →
   `ANTHROPIC_API_KEY` (it's shared with the metals-tracker function).
2. **Rotate your Finnhub key** and add it as the `FINNHUB_API_KEY` secret in
   the same place. Without it, fundamentals fall back to AI estimates (the app
   will warn).
3. **Delete the `.env` file from Google Drive** (`Alpha Screen/.env`) and
   remove `VITE_ANTHROPIC_API_KEY` / `VITE_FINNHUB_API_KEY` from your local
   `.env` — the client no longer reads them.
4. **Copy the replacement files** from `alpha-screen/src/` over the same paths
   in your local project:
   - `src/lib/anthropic.js`
   - `src/lib/prices.js`
   - `src/lib/fundamentals.js`
   - `src/lib/systemPrompt.js`
   - `src/lib/portfolio.js` (P&L / IVV benchmark math used by the tracker —
     required; some local copies of the project don't have it)
   - `src/components/RunScreen.jsx`
   - `src/components/PositionTracker.jsx`
5. `npm uninstall @anthropic-ai/sdk` (no longer used client-side), rebuild,
   redeploy to Netlify.

## Behavior changes you'll notice

- **Run Weekly Screen**: runs server-side (takes a few minutes with Opus +
  web search). The 60% US minimum is now enforced (lowest-ranked non-US picks
  are dropped), the composite score is computed by the app as 60% quant / 40%
  qual (the factor weights in the DB now actually determine the quant score
  the model produces, and the composite math is deterministic), and targets
  are bear/base/bull scenarios with an explicit `p_2x` instead of mechanical
  2× doubles.
- **Re-picked held tickers update their existing pick** (scores/thesis/rank
  refresh; entry price and targets stay anchored) instead of creating a
  duplicate row with a re-doubled target and a fresh trigger set.
- **New picks enter as WATCHING**; a pick is ACTIVE only when it backs a held
  position.
- **Run Weekly Review**: skips positions already reviewed this week (a
  re-click resumes an interrupted run instead of re-billing everything),
  upserts instead of duplicating, and now actually fires the earnings-miss
  sell triggers Claude reports (`sell_triggers_fired` was previously ignored).

## The learning loop (live since 2026-07-04)

The `alpha-feedback` edge function closes the loop the original design
intended but never ran:

- For every pick (deduped to first appearance per ticker) it computes the
  forward return since pick date and the alpha vs IVV over the same window.
- It correlates entry-time factor values (from `weekly_screens`) with
  subsequent alpha — per-factor information coefficients.
- It scores each macro theme (count, avg alpha, hit rate).
- It writes one `model_feedback` row per week; the weekly screen already
  loads the last 8 rows into the prompt, so the model now sees its own track
  record. Weight-adjustment suggestions unlock automatically once 8 distinct
  screen weeks exist.

It runs every Friday 21:30 UTC via the pg_cron job `alpha-feedback-weekly`
(see `supabase/migrations/schedule_weekly_feedback_job.sql`). Verified live:
the first row is in `model_feedback` (29 tickers, 4 weeks of history).
Nothing for you to configure.

## Still open (from the review, in priority order)

- Deterministic stage-1 screening from real data (§4A of the review) — the
  screen is still LLM-driven; the prompt now at least demands honest
  `stage1_summary` counts and diversification caps (max 5 picks/theme,
  max 2/industry).
- Theme caps / position sizing / trailing stops at the portfolio level (§4D).
- Scheduling the screen and position reviews themselves (feedback is already
  scheduled; the screen is left manual on purpose so you review picks before
  buying — say the word if you want it automated too).
