import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { buildSystemPrompt } from '../lib/systemPrompt'
import { runWeeklyScreen } from '../lib/anthropic'
import { fetchQuotes } from '../lib/prices'
import { fetchFundamentalsBatch } from '../lib/fundamentals'
import { useFactorWeights } from '../hooks/useFactorWeights'

const today = () => new Date().toISOString().split('T')[0]
const cents = (n) => (n == null || isNaN(n) ? null : +Number(n).toFixed(2))

// Composite is computed HERE, deterministically — not by the model — so the
// weighting is real, auditable, and identical every week.
const QUANT_WEIGHT = 0.6
const QUAL_WEIGHT = 0.4

// The model is instructed to score 0-100; rescale defensively if it ever
// slips back to 0-10 so weeks stay comparable.
const to100 = (n) => (n == null ? null : n <= 10 ? +(n * 10).toFixed(1) : +Number(n).toFixed(1))

const VALID_TRIGGER_TYPES = [
  'EARNINGS_MISS_GUIDANCE_CUT',
  'EARNINGS_MISS_GUIDANCE_MAINTAINED',
  'THESIS_BROKEN',
  'DRAWDOWN_25PCT',
  'FLAT_8_WEEKS',
  'TARGET_HIT',
  'TIME_DECAY_WEEK_48',
]
const VALID_ACTIONS = ['SELL_50', 'SELL_100', 'REVIEW']

const STANDARD_TRIGGERS = [
  { trigger_type: 'EARNINGS_MISS_GUIDANCE_CUT', trigger_description: 'Earnings miss with guidance cut', action_on_trigger: 'SELL_100' },
  { trigger_type: 'EARNINGS_MISS_GUIDANCE_MAINTAINED', trigger_description: 'Earnings miss, guidance maintained', action_on_trigger: 'SELL_50' },
  { trigger_type: 'DRAWDOWN_25PCT', trigger_description: '25% drawdown from entry after 6+ weeks', action_on_trigger: 'REVIEW' },
  { trigger_type: 'TARGET_HIT', trigger_description: 'Price reaches 2x cost basis', action_on_trigger: 'SELL_50' },
  { trigger_type: 'FLAT_8_WEEKS', trigger_description: 'Held 8+ weeks within ±10%, no catalyst', action_on_trigger: 'SELL_50' },
  { trigger_type: 'TIME_DECAY_WEEK_48', trigger_description: 'Week 48 of 52 — close position', action_on_trigger: 'SELL_100' },
]

export default function RunScreen() {
  const { weights } = useFactorWeights()
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState([])
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const addProgress = (msg) => {
    setProgress(prev => [...prev, { msg, ts: new Date().toLocaleTimeString() }])
  }

  const handleRun = async () => {
    if (!weights) {
      setError('Factor weights not loaded. Check Supabase connection.')
      return
    }
    setRunning(true)
    setError(null)
    setResult(null)
    setProgress([])

    try {
      addProgress('Fetching factor weights and model feedback from Supabase...')
      const { data: feedback } = await supabase
        .from('model_feedback')
        .select('*')
        .order('week_date', { ascending: false })
        .limit(8)
      addProgress(`Loaded ${feedback?.length || 0} weeks of model feedback history.`)

      const systemPrompt = buildSystemPrompt(weights, feedback)
      addProgress('Starting server-side Claude screen (takes a few minutes)...')
      const screenResult = await runWeeklyScreen(systemPrompt, addProgress)

      let picks = (screenResult.picks || []).slice()
      addProgress(`Screen complete. Got ${picks.length} picks.`)
      if (!picks.length) throw new Error('The screen returned no picks.')

      // Enforce the 60% US-listed minimum: drop lowest-ranked non-US picks
      // (previously this only warned).
      picks.sort((a, b) => (a.rank || 99) - (b.rank || 99))
      while (picks.length > 1 && picks.filter(p => p.us_listed).length / picks.length < 0.6) {
        const idx = picks.map(p => p.us_listed).lastIndexOf(false)
        if (idx === -1) break
        addProgress(`⚠ Dropped ${picks[idx].ticker} (non-US) to enforce the 60% US minimum.`)
        picks.splice(idx, 1)
      }
      picks.forEach((p, i) => { p.rank = i + 1 })

      const weekDate = today()

      // Re-runs replace this week's screen records cleanly.
      await supabase.from('weekly_screens').delete().eq('week_date', weekDate)
      addProgress('Cleared any prior screen data for this week.')

      // Verified fundamentals overwrite the model's numbers.
      addProgress('Fetching verified fundamentals (Finnhub, server-side)...')
      const fundResp = await fetchFundamentalsBatch(picks.map(p => p.ticker))
      const fundamentals = fundResp.data || {}
      if (fundResp.configured) {
        addProgress(`Got verified fundamentals for ${Object.keys(fundamentals).length}/${picks.length} picks.`)
      } else {
        addProgress('⚠ FINNHUB_API_KEY not set on the edge function — fundamentals are AI estimates.')
      }

      // Anchor prices to the real prior-day close; scale the target range by
      // the same ratio so the implied upside survives the correction.
      addProgress('Verifying pick prices against the live market...')
      const { prices: realCloses } = await fetchQuotes(picks.map(p => p.ticker))
      const corrected = []
      picks.forEach(p => {
        const real = realCloses[p.ticker]
        if (real != null && p.price_at_pick) {
          const ratio = real / p.price_at_pick
          if (Math.abs(1 - ratio) > 0.1) corrected.push(p.ticker)
          p.price_at_pick = cents(real)
          if (Math.abs(1 - ratio) > 0.02) {
            p.target_price = cents(p.target_price * ratio)
            p.target_price_bear = cents(p.target_price_bear * ratio)
            p.target_price_bull = cents(p.target_price_bull * ratio)
          }
        }
        p.price_at_pick = cents(p.price_at_pick)
        p.target_price = cents(p.target_price)
        p.target_price_bear = cents(p.target_price_bear)
        p.target_price_bull = cents(p.target_price_bull)
      })
      if (corrected.length) addProgress(`Corrected mispriced picks from market data: ${corrected.join(', ')}`)

      // Compute scores in code: qual = mean(1-10 factors) x 10; composite 60/40.
      picks.forEach(p => {
        const qs = p.qual_scores || {}
        const factors = [
          qs.industry_trend_score, qs.macro_alignment_score, qs.management_quality_score,
          qs.competitive_moat_score, qs.thesis_conviction_score,
        ].filter(v => v != null)
        p.quant_score = to100(p.quant_score)
        p.qual_score = factors.length
          ? +(factors.reduce((a, b) => a + b, 0) / factors.length * 10).toFixed(1)
          : null
        p.composite_score = (p.quant_score != null && p.qual_score != null)
          ? +(QUANT_WEIGHT * p.quant_score + QUAL_WEIGHT * p.qual_score).toFixed(1)
          : p.quant_score
      })

      // Write weekly_screens records (verified fundamentals override the model's).
      const screenRows = picks.map(p => {
        const f = fundamentals[p.ticker] || {}
        const v = (key) => (f[key] != null ? f[key] : p[key])
        return {
          week_date: weekDate,
          ticker: p.ticker,
          company_name: p.company_name,
          country: p.country,
          sector: p.sector,
          industry: p.industry,
          pe_ratio: v('pe_ratio'),
          forward_pe: v('forward_pe'),
          peg_ratio: p.peg_ratio,
          roe: v('roe'),
          eps_growth_yoy: v('eps_growth_yoy'),
          revenue_growth: v('revenue_growth'),
          debt_equity: v('debt_equity'),
          price_momentum_3m: p.price_momentum_3m,
          price_momentum_6m: p.price_momentum_6m,
          gross_margin: v('gross_margin'),
          analyst_revision_direction: p.analyst_revision_direction,
          composite_quant_score: p.quant_score,
          passed_to_deep_screen: true,
        }
      })
      const { error: screenErr } = await supabase.from('weekly_screens').insert(screenRows)
      if (screenErr) throw screenErr
      addProgress(`Wrote ${screenRows.length} screen records.`)

      // Pick lifecycle: a ticker with an ACTIVE (held) pick gets its existing
      // row refreshed — no duplicate rows, no re-doubled targets, no orphaned
      // trigger sets. Everything else is inserted as WATCHING (a pick becomes
      // ACTIVE when a position is opened against it).
      const { data: activePicks } = await supabase
        .from('picks')
        .select('id, ticker, price_at_pick, target_price')
        .eq('status', 'ACTIVE')
      const activeByTicker = {}
      ;(activePicks || []).forEach(p => { activeByTicker[p.ticker] = p })

      const targetDate = new Date()
      targetDate.setMonth(targetDate.getMonth() + 12)
      const targetDateStr = targetDate.toISOString().split('T')[0]

      const insertedPicks = []
      let updated = 0
      for (const p of picks) {
        const existing = activeByTicker[p.ticker]
        if (existing) {
          // Refresh assessment fields; keep entry price and targets anchored
          // to the original entry so TARGET_HIT can actually fire.
          const { error: updErr } = await supabase.from('picks').update({
            week_date: weekDate,
            rank: p.rank,
            quant_score: p.quant_score,
            qual_score: p.qual_score,
            composite_score: p.composite_score,
            entry_thesis: p.entry_thesis,
            macro_theme: p.macro_theme,
            p_2x: p.p_2x,
          }).eq('id', existing.id)
          if (updErr) throw updErr
          updated++
          insertedPicks.push({ id: existing.id, ticker: p.ticker, isNew: false, model: p })
        } else {
          const { data: ins, error: insErr } = await supabase.from('picks').insert({
            week_date: weekDate,
            ticker: p.ticker,
            company_name: p.company_name,
            rank: p.rank,
            quant_score: p.quant_score,
            qual_score: p.qual_score,
            composite_score: p.composite_score,
            entry_thesis: p.entry_thesis,
            price_at_pick: p.price_at_pick,
            target_price: p.target_price,
            target_price_bear: p.target_price_bear,
            target_price_bull: p.target_price_bull,
            p_2x: p.p_2x,
            target_date: targetDateStr,
            us_listed: p.us_listed,
            macro_theme: p.macro_theme,
            status: 'WATCHING',
            screen_variant: 'llm',
          }).select().single()
          if (insErr) throw insErr
          insertedPicks.push({ id: ins.id, ticker: p.ticker, isNew: true, model: p })
        }
      }
      addProgress(`Wrote picks: ${insertedPicks.length - updated} new (WATCHING), ${updated} held picks refreshed.`)

      // Weekly qual-score snapshot for every pick (history of the assessment).
      const qualRows = insertedPicks.map(({ id, model }) => {
        const qs = model.qual_scores || {}
        return {
          pick_id: id,
          week_date: weekDate,
          industry_trend_score: qs.industry_trend_score,
          macro_alignment_score: qs.macro_alignment_score,
          management_quality_score: qs.management_quality_score,
          competitive_moat_score: qs.competitive_moat_score,
          thesis_conviction_score: qs.thesis_conviction_score,
          risks_identified: qs.risks_identified,
          qualitative_notes: qs.qualitative_notes,
          overall_qual_score: model.qual_score,
        }
      })
      const { error: qualErr } = await supabase.from('qual_scores').insert(qualRows)
      if (qualErr) throw qualErr
      addProgress('Wrote qualitative scores.')

      // Sell triggers only for NEW picks — held picks already have their set.
      const triggerRows = []
      insertedPicks.filter(x => x.isNew).forEach(({ id, ticker, model }) => {
        const seen = new Set()
        ;(model.sell_triggers || []).forEach(t => {
          if (!VALID_TRIGGER_TYPES.includes(t.trigger_type)) return
          if (!VALID_ACTIONS.includes(t.action_on_trigger)) return
          if (seen.has(t.trigger_type)) return
          seen.add(t.trigger_type)
          triggerRows.push({
            pick_id: id, ticker,
            trigger_type: t.trigger_type,
            trigger_description: t.trigger_description,
            action_on_trigger: t.action_on_trigger,
          })
        })
        STANDARD_TRIGGERS.forEach(t => {
          if (!seen.has(t.trigger_type)) triggerRows.push({ ...t, pick_id: id, ticker })
        })
      })
      if (triggerRows.length) {
        const { error: trigErr } = await supabase.from('sell_triggers').insert(triggerRows)
        if (trigErr) throw trigErr
      }
      addProgress(`Wrote ${triggerRows.length} sell triggers (new picks only).`)

      addProgress('✅ Screen complete! Navigate to Dashboard to view picks.')
      setResult(screenResult)
    } catch (err) {
      setError(err.message)
      addProgress(`❌ Error: ${err.message}`)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 800 }}>
      <h1 style={{ margin: '0 0 8px', fontSize: 22, fontWeight: 700, color: '#e2e8f0' }}>Run Weekly Screen</h1>
      <p style={{ margin: '0 0 24px', fontSize: 13, color: '#64748b' }}>
        Runs the full two-stage Claude screen server-side with live web search. Takes a few minutes.
      </p>

      {/* Factor weights preview */}
      {weights && (
        <div
          style={{
            background: '#0f1424', border: '1px solid #1e2a42', borderRadius: 8,
            padding: 16, marginBottom: 24,
          }}
        >
          <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>
            Active Factor Weights
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
            {[
              ['Earnings Growth', weights.earnings_growth_weight],
              ['Valuation', weights.valuation_weight],
              ['Momentum', weights.momentum_weight],
              ['Quality / ROE', weights.quality_weight],
              ['Revenue Growth', weights.revenue_growth_weight],
              ['Balance Sheet', weights.balance_sheet_weight],
              ['Analyst Revisions', weights.analyst_revision_weight],
            ].map(([label, val]) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: '#94a3b8' }}>{label}</span>
                <span className="font-mono" style={{ fontSize: 13, fontWeight: 600, color: '#2563eb' }}>
                  {((val || 0) * 100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Run button */}
      <button
        onClick={handleRun}
        disabled={running}
        style={{
          background: running ? '#1e2a42' : '#2563eb',
          color: running ? '#64748b' : '#fff',
          border: 'none', borderRadius: 8, padding: '14px 32px',
          fontSize: 15, fontWeight: 700, cursor: running ? 'not-allowed' : 'pointer',
          display: 'flex', alignItems: 'center', gap: 10,
          marginBottom: 24,
          transition: 'background 0.15s',
        }}
      >
        {running ? (
          <>
            <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</span>
            Running Screen...
          </>
        ) : (
          <>⟳ Run Weekly Screen</>
        )}
      </button>

      {/* Progress log */}
      {progress.length > 0 && (
        <div
          style={{
            background: '#080c17', border: '1px solid #1e2a42', borderRadius: 8,
            padding: 16, fontFamily: 'IBM Plex Mono', fontSize: 12,
            maxHeight: 300, overflowY: 'auto',
          }}
        >
          {progress.map((p, i) => (
            <div key={i} style={{ marginBottom: 6, display: 'flex', gap: 12 }}>
              <span style={{ color: '#2563eb', flexShrink: 0 }}>{p.ts}</span>
              <span style={{ color: p.msg.startsWith('✅') ? '#10b981' : p.msg.startsWith('❌') ? '#ef4444' : p.msg.startsWith('⚠') ? '#f59e0b' : '#94a3b8' }}>
                {p.msg}
              </span>
            </div>
          ))}
          {running && (
            <div style={{ color: '#2563eb', marginTop: 4 }}>
              <span style={{ animation: 'pulse 1s infinite' }}>●</span> Processing...
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ background: '#1a0a0a', border: '1px solid #ef4444', borderRadius: 8, padding: 14, color: '#ef4444', fontSize: 13, marginTop: 16 }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Result summary */}
      {result && !running && (
        <div style={{ background: '#0a1a0a', border: '1px solid #10b981', borderRadius: 8, padding: 16, marginTop: 16 }}>
          <div style={{ fontSize: 13, color: '#10b981', fontWeight: 600, marginBottom: 8 }}>
            ✅ Screen Complete — {result.picks?.length} picks saved
          </div>
          {result.screen_notes && (
            <p style={{ fontSize: 12, color: '#94a3b8', margin: 0 }}>{result.screen_notes}</p>
          )}
        </div>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
      `}</style>
    </div>
  )
}
