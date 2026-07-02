import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { buildWeeklyReviewPrompt } from '../lib/screeningPrompts'
import { runPositionReview } from '../lib/anthropic'
import { evaluateSellRules } from '../lib/sellRules'
import { usePositions } from '../hooks/usePositions'
import { fetchQuotes, fetchHistoricalOpens, fetchTickerAudit } from '../lib/prices'
import { computePerformance } from '../lib/portfolio'

const THESIS_COLORS = {
  INTACT: '#10b981',
  WEAKENING: '#f59e0b',
  BROKEN: '#ef4444',
}

const SIGNAL_COLORS = {
  STRONG_HOLD: '#10b981',
  HOLD: '#94a3b8',
  ADD: '#3b82f6',
  TRIM: '#f59e0b',
  SELL: '#ef4444',
}

export default function PositionTracker() {
  const { positions, loading, error, refetch } = usePositions()
  const [reviewing, setReviewing] = useState(false)
  const [reviewProgress, setReviewProgress] = useState([])
  const [reviewError, setReviewError] = useState(null)
  const [refreshingPrices, setRefreshingPrices] = useState(false)
  const [priceError, setPriceError] = useState(null)
  const [lastPriceUpdate, setLastPriceUpdate] = useState(null)
  const [perf, setPerf] = useState(null)
  const [perfError, setPerfError] = useState(null)
  const [weeksByTicker, setWeeksByTicker] = useState({})
  const [signalsById, setSignalsById] = useState({})

  // Load the most recent weekly-review signal for each position.
  const loadSignals = async () => {
    if (positions.length === 0) return
    const ids = positions.map(p => p.id)
    const { data } = await supabase
      .from('weekly_position_reviews')
      .select('position_tracker_id, hold_buy_sell_signal, week_date')
      .in('position_tracker_id', ids)
      .order('week_date', { ascending: false })
    const map = {}
    ;(data || []).forEach(r => {
      if (!map[r.position_tracker_id] && r.hold_buy_sell_signal) {
        map[r.position_tracker_id] = r.hold_buy_sell_signal
      }
    })
    setSignalsById(map)
  }

  useEffect(() => {
    loadSignals()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions])

  const addLog = (msg) => setReviewProgress(prev => [...prev, { msg, ts: new Date().toLocaleTimeString() }])

  // Compute full realized + unrealized P&L and the IVV (S&P 500) benchmark
  // from the complete trade ledger.
  const loadPerformance = async () => {
    setPerfError(null)
    try {
      const { data: trades, error: tErr } = await supabase
        .from('trades')
        .select('*')
        .order('trade_date', { ascending: true })
      if (tErr) throw tErr
      if (!trades || trades.length === 0) { setPerf(null); return }

      const tickers = [...new Set(trades.map(t => t.ticker))]
      const earliest = trades[0].trade_date

      // Weeks held = whole weeks since the earliest BUY for each ticker.
      const firstBuy = {}
      trades.forEach(t => {
        if (t.action === 'BUY') {
          if (!firstBuy[t.ticker] || t.trade_date < firstBuy[t.ticker]) firstBuy[t.ticker] = t.trade_date
        }
      })
      const weeks = {}
      Object.entries(firstBuy).forEach(([tk, d]) => {
        const ms = Date.now() - new Date(d + 'T00:00:00Z').getTime()
        weeks[tk] = Math.max(0, Math.floor(ms / (7 * 86400 * 1000)))
      })
      setWeeksByTicker(weeks)
      // Persist so sell-rule checks (e.g. FLAT_8_WEEKS) use accurate week counts.
      Promise.all(
        Object.entries(weeks).map(([tk, w]) =>
          supabase.from('position_tracker').update({ weeks_held: w }).eq('ticker', tk)
        )
      ).catch(() => {})

      const [q, ivv] = await Promise.all([
        fetchQuotes(tickers),
        fetchHistoricalOpens('IVV', earliest),
      ])

      const result = computePerformance(trades, q.prices, ivv.opens, ivv.currentPrice)
      setPerf(result)
    } catch (err) {
      setPerfError(err.message)
    }
  }

  // Pull live prices for all held positions and persist them.
  const refreshPrices = async () => {
    if (positions.length === 0) return
    setRefreshingPrices(true)
    setPriceError(null)
    try {
      const tickers = positions.map(p => p.ticker)
      const { prices: quotes, asOf } = await fetchQuotes(tickers)

      const updates = positions
        .filter(p => quotes[p.ticker] != null)
        .map(p => {
          const price = +quotes[p.ticker].toFixed(2)
          const value = +((p.shares_held || 0) * price).toFixed(2)
          const pnlPct = p.avg_cost_basis
            ? +(((price - p.avg_cost_basis) / p.avg_cost_basis) * 100).toFixed(4)
            : 0
          return supabase
            .from('position_tracker')
            .update({
              current_price: price,
              current_value: value,
              unrealized_pnl_pct: pnlPct,
              updated_at: new Date().toISOString(),
            })
            .eq('id', p.id)
        })

      await Promise.all(updates)

      const missing = positions.filter(p => quotes[p.ticker] == null).map(p => p.ticker)
      if (missing.length > 0) {
        setPriceError(`Could not fetch prices for: ${missing.join(', ')}. Try again in a moment.`)
      }
      setLastPriceUpdate(asOf)
      refetch()
      loadPerformance()
    } catch (err) {
      setPriceError(err.message)
    } finally {
      setRefreshingPrices(false)
    }
  }

  // On first load: refresh held-position prices and compute full performance.
  useEffect(() => {
    if (positions.length > 0 && !lastPriceUpdate && !refreshingPrices) {
      refreshPrices()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions.length])

  useEffect(() => {
    loadPerformance()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Per-ticker performance lookup for the table (incl. IVV benchmark).
  const perfByTicker = {}
  ;(perf?.perTicker || []).forEach(p => { perfByTicker[p.ticker] = p })

  // --- Data audit: cross-check every holding against the live feed ---
  const [auditing, setAuditing] = useState(false)
  const [audit, setAudit] = useState(null)

  const runAudit = async () => {
    setAuditing(true)
    setAudit(null)
    try {
      const tickers = positions.map(p => p.ticker)
      const { data: picks } = await supabase
        .from('picks')
        .select('ticker, price_at_pick, target_price')
        .in('ticker', tickers)
      const pickByTicker = {}
      ;(picks || []).forEach(p => { if (!pickByTicker[p.ticker]) pickByTicker[p.ticker] = p })

      const rows = []
      for (const pos of positions) {
        const info = await fetchTickerAudit(pos.ticker)
        const pick = pickByTicker[pos.ticker]
        const issues = []
        let level = 'OK'

        if (info.error || info.price == null) {
          issues.push(`Could not fetch a live price (${info.error || 'unknown'})`)
          level = 'FAIL'
        } else {
          if (info.currency && info.currency !== 'USD') {
            issues.push(`Trades in ${info.currency}, not USD — possible wrong/foreign listing`)
            level = 'WARN'
          }
          if (pos.current_price != null) {
            const drift = Math.abs(pos.current_price - info.price) / info.price * 100
            if (drift > 3) {
              issues.push(`Stored price $${pos.current_price.toFixed(2)} is ${drift.toFixed(1)}% off the ${info.date} close $${info.price.toFixed(2)} — click Refresh Prices`)
              if (level !== 'FAIL') level = 'WARN'
            }
          }
          if (pick?.price_at_pick) {
            const dev = Math.abs(pick.price_at_pick - info.price) / info.price * 100
            if (dev > 40) {
              issues.push(`Pick price $${pick.price_at_pick} is ${dev.toFixed(0)}% from live $${info.price.toFixed(2)} — likely an AI mispricing`)
              if (level !== 'FAIL') level = 'WARN'
            }
          }
          if (pick?.target_price && info.price >= pick.target_price) {
            issues.push(`Target $${pick.target_price} is at/below live price — inverted target`)
            if (level !== 'FAIL') level = 'WARN'
          }
        }

        rows.push({
          ticker: pos.ticker,
          name: info.name,
          live: info.price,
          date: info.date,
          currency: info.currency,
          exchange: info.exchange,
          stored: pos.current_price,
          level,
          issues,
        })
      }
      setAudit(rows)
    } catch (err) {
      setAudit([{ ticker: '—', level: 'FAIL', issues: [err.message], name: null, live: null }])
    } finally {
      setAuditing(false)
    }
  }

  const handleWeeklyReview = async () => {
    if (positions.length === 0) {
      setReviewError('No positions to review.')
      return
    }
    setReviewing(true)
    setReviewError(null)
    setReviewProgress([])

    try {
      const weekDate = new Date().toISOString().split('T')[0]

      // Skip positions already reviewed this week — a re-click resumes where
      // an interrupted run stopped instead of re-reviewing (and re-billing)
      // everything.
      const { data: doneRows } = await supabase
        .from('weekly_position_reviews')
        .select('position_tracker_id')
        .eq('week_date', weekDate)
      const done = new Set((doneRows || []).map(r => r.position_tracker_id))
      const toReview = positions.filter(p => !done.has(p.id))
      if (done.size > 0) addLog(`Skipping ${done.size} position(s) already reviewed this week.`)
      if (toReview.length === 0) {
        addLog('✅ All positions already reviewed this week.')
        setReviewing(false)
        return
      }

      for (const pos of toReview) {
        addLog(`Reviewing ${pos.ticker}...`)

        const prompt = buildWeeklyReviewPrompt(
          pos,
          pos.current_price || pos.avg_cost_basis,
          `Search for recent news, earnings, and analyst updates for ${pos.ticker} (${pos.picks?.company_name || pos.ticker}).`
        )

        const reviewData = await runPositionReview(prompt, (msg) => addLog(`  ${pos.ticker}: ${msg}`))

        // Merge code-evaluated sell rules with the triggers Claude flagged in
        // the review (earnings-miss triggers can only come from the review —
        // the code rules can't see earnings events).
        const autoTriggers = evaluateSellRules(pos, {
          price_change_since_entry: reviewData.price_change_since_entry,
          thesis_status: reviewData.thesis_status,
          weeks_held: pos.weeks_held,
        })
        const seenTypes = new Set(autoTriggers.map(t => t.trigger_type))
        ;(reviewData.sell_triggers_fired || []).forEach(t => {
          if (seenTypes.has(t.trigger_type)) return
          seenTypes.add(t.trigger_type)
          autoTriggers.push({
            trigger_type: t.trigger_type,
            trigger_description: `Flagged by weekly review: ${t.trigger_type}`,
            action_on_trigger: t.action,
          })
        })

        // Update position tracker
        const newPrice = pos.current_price
        const { error: posErr } = await supabase
          .from('position_tracker')
          .update({
            thesis_intact: reviewData.thesis_status === 'INTACT',
            last_reviewed: weekDate,
            updated_at: new Date().toISOString(),
          })
          .eq('id', pos.id)
        if (posErr) throw posErr

        // Write weekly position review — upsert so an accidental re-run
        // updates rather than duplicates (unique index on position+week).
        const { error: revErr } = await supabase
          .from('weekly_position_reviews')
          .upsert({
            position_tracker_id: pos.id,
            week_date: weekDate,
            price_at_review: newPrice,
            price_change_wow: reviewData.price_change_wow,
            price_change_since_entry: reviewData.price_change_since_entry,
            market_context: reviewData.market_context,
            industry_context: reviewData.industry_context,
            company_specific_news: reviewData.company_specific_news,
            thesis_status: reviewData.thesis_status,
            hold_buy_sell_signal: reviewData.hold_buy_sell_signal,
            signal_rationale: reviewData.signal_rationale,
            earnings_review: reviewData.earnings_review,
            post_earnings_notes: reviewData.post_earnings_notes,
          }, { onConflict: 'position_tracker_id,week_date' })
        if (revErr) throw revErr

        // Fire sell triggers for any detected issues
        if (autoTriggers.length > 0 && pos.pick_id) {
          for (const trigger of autoTriggers) {
            const { data: existing } = await supabase
              .from('sell_triggers')
              .select('id')
              .eq('pick_id', pos.pick_id)
              .eq('trigger_type', trigger.trigger_type)
              .eq('triggered', false)
              .maybeSingle()

            if (existing) {
              await supabase
                .from('sell_triggers')
                .update({ triggered: true, triggered_date: weekDate })
                .eq('id', existing.id)
            } else {
              await supabase.from('sell_triggers').insert({
                pick_id: pos.pick_id,
                ticker: pos.ticker,
                ...trigger,
                triggered: true,
                triggered_date: weekDate,
              })
            }
            addLog(`  🔔 ${pos.ticker}: ${trigger.trigger_type} fired → ${trigger.action_on_trigger}`)
          }
        }

        addLog(`✓ ${pos.ticker}: ${reviewData.thesis_status} — ${reviewData.hold_buy_sell_signal}`)
      }

      addLog('✅ All positions reviewed.')
      refetch()
    } catch (err) {
      setReviewError(err.message)
      addLog(`❌ Error: ${err.message}`)
    } finally {
      setReviewing(false)
    }
  }

  if (loading) {
    return <div style={{ padding: 40, color: '#64748b', fontFamily: 'IBM Plex Mono', fontSize: 13 }}>Loading positions...</div>
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#e2e8f0' }}>Position Tracker</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
            {positions.length} active position{positions.length !== 1 ? 's' : ''}
          </p>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={runAudit}
            disabled={auditing || positions.length === 0}
            style={{
              background: 'transparent',
              color: auditing ? '#64748b' : '#94a3b8',
              border: '1px solid #253048', borderRadius: 6, padding: '10px 16px',
              fontSize: 13, fontWeight: 600, cursor: auditing ? 'not-allowed' : 'pointer',
            }}
          >
            {auditing ? '⟳ Checking...' : '✓ Verify Data'}
          </button>
          <button
            onClick={refreshPrices}
            disabled={refreshingPrices || positions.length === 0}
            style={{
              background: 'transparent',
              color: refreshingPrices ? '#64748b' : '#94a3b8',
              border: '1px solid #253048', borderRadius: 6, padding: '10px 16px',
              fontSize: 13, fontWeight: 600, cursor: refreshingPrices ? 'not-allowed' : 'pointer',
            }}
          >
            {refreshingPrices ? '⟳ Updating...' : '↻ Refresh Prices'}
          </button>
          <button
            onClick={handleWeeklyReview}
            disabled={reviewing || positions.length === 0}
            style={{
              background: reviewing ? '#1e2a42' : '#1a3a5f',
              color: reviewing ? '#64748b' : '#60a5fa',
              border: '1px solid #2563eb', borderRadius: 6, padding: '10px 20px',
              fontSize: 13, fontWeight: 600, cursor: reviewing ? 'not-allowed' : 'pointer',
            }}
          >
            {reviewing ? '⟳ Reviewing...' : '⟳ Run Weekly Review'}
          </button>
        </div>
      </div>

      {/* Portfolio P&L summary */}
      {perf && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 12 }}>
            {[
              { label: 'Total Invested', value: money(perf.totalInvested), color: '#e2e8f0' },
              { label: 'Holdings Value', value: money(perf.holdingsValue), color: '#e2e8f0' },
              { label: 'Realized P&L', value: signedMoney(perf.realized), color: pnlColor(perf.realized) },
              { label: 'Unrealized P&L', value: signedMoney(perf.unrealized), color: pnlColor(perf.unrealized) },
              { label: 'Total P&L', value: `${signedMoney(perf.totalPnl)} (${signedPct(perf.returnPct)})`, color: pnlColor(perf.totalPnl) },
            ].map(stat => (
              <div key={stat.label} style={{ background: '#0f1424', border: '1px solid #1e2a42', borderRadius: 6, padding: '12px 16px' }}>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>{stat.label}</div>
                <div className="font-mono" style={{ fontSize: stat.label === 'Total P&L' ? 16 : 20, fontWeight: 700, color: stat.color }}>{stat.value}</div>
              </div>
            ))}
          </div>

          {/* S&P 500 benchmark comparison */}
          <div
            style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 20,
              background: '#0b1020', border: '1px solid #253048', borderRadius: 8, padding: 16,
            }}
          >
            <div>
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>YOUR PORTFOLIO RETURN</div>
              <div className="font-mono" style={{ fontSize: 24, fontWeight: 700, color: pnlColor(perf.returnPct) }}>
                {signedPct(perf.returnPct)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>S&P 500 (IVV) — SAME DOLLARS, SAME DAYS</div>
              <div className="font-mono" style={{ fontSize: 24, fontWeight: 700, color: pnlColor(perf.ivv.returnPct) }}>
                {signedPct(perf.ivv.returnPct)}
              </div>
              <div className="font-mono" style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                {signedMoney(perf.ivv.totalPnl)} P&L
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>ALPHA vs S&P 500</div>
              <div className="font-mono" style={{ fontSize: 24, fontWeight: 700, color: pnlColor(perf.alpha) }}>
                {signedPct(perf.alpha)}
              </div>
              <div style={{ fontSize: 11, color: perf.alpha >= 0 ? '#10b981' : '#ef4444', marginTop: 2 }}>
                {perf.alpha >= 0 ? 'Beating the index' : 'Trailing the index'}
              </div>
            </div>
          </div>
        </>
      )}

      {perfError && (
        <div style={{ background: '#1a1505', border: '1px solid #f59e0b', borderRadius: 8, padding: 12, color: '#f59e0b', fontSize: 12, marginBottom: 16 }}>
          Performance/benchmark data unavailable: {perfError}
        </div>
      )}

      {lastPriceUpdate && (
        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 12, fontFamily: 'IBM Plex Mono' }}>
          Prices as of {lastPriceUpdate} close · Yahoo Finance
        </div>
      )}

      {priceError && (
        <div style={{ background: '#1a1505', border: '1px solid #f59e0b', borderRadius: 8, padding: 12, color: '#f59e0b', fontSize: 12, marginBottom: 16 }}>
          {priceError}
        </div>
      )}

      {/* Data audit results */}
      {audit && (
        <div style={{ background: '#0f1424', border: '1px solid #253048', borderRadius: 8, padding: 16, marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>
              Data Check — {audit.filter(r => r.level === 'OK').length}/{audit.length} clean
            </div>
            <button
              onClick={() => setAudit(null)}
              style={{ background: 'transparent', border: '1px solid #1e2a42', color: '#64748b', borderRadius: 6, padding: '4px 12px', fontSize: 12, cursor: 'pointer' }}
            >
              Dismiss
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {audit.map(r => {
              const color = r.level === 'FAIL' ? '#ef4444' : r.level === 'WARN' ? '#f59e0b' : '#10b981'
              const label = r.level === 'FAIL' ? '✕ FAIL' : r.level === 'WARN' ? '⚠ CHECK' : '✓ OK'
              return (
                <div key={r.ticker} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '8px 10px', background: '#080c17', borderRadius: 6, border: `1px solid ${r.level === 'OK' ? '#162133' : color}` }}>
                  <span className="font-mono" style={{ fontSize: 12, fontWeight: 700, color, minWidth: 64 }}>{label}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <span className="font-mono" style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>{r.ticker}</span>
                      {r.name && <span style={{ fontSize: 12, color: '#94a3b8' }}>{r.name}</span>}
                      {r.live != null && (
                        <span className="font-mono" style={{ fontSize: 12, color: '#64748b' }}>
                          {r.date} close ${r.live.toFixed(2)} {r.currency || ''} · {r.exchange || ''}
                        </span>
                      )}
                    </div>
                    {r.issues.length > 0 ? (
                      r.issues.map((iss, i) => (
                        <div key={i} style={{ fontSize: 12, color: color, marginTop: 3 }}>• {iss}</div>
                      ))
                    ) : (
                      <div style={{ fontSize: 12, color: '#64748b', marginTop: 3 }}>Ticker, currency, live price, pick price and target all check out.</div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {error && (
        <div style={{ background: '#1a0a0a', border: '1px solid #ef4444', borderRadius: 8, padding: 14, color: '#ef4444', fontSize: 13, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {positions.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, background: '#0f1424', border: '1px solid #1e2a42', borderRadius: 8 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>◈</div>
          <div style={{ fontSize: 16, color: '#e2e8f0', marginBottom: 8 }}>No positions held</div>
          <p style={{ fontSize: 13, color: '#64748b' }}>Enter trades in the Trade Log to track positions.</p>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #1e2a42' }}>
                {['Ticker', 'Shares', 'Avg Cost', 'Current', 'Unreal. PnL', 'S&P 500', 'Alpha', 'Weeks', 'Thesis', 'Signal', 'Last Review'].map(h => (
                  <th
                    key={h}
                    style={{
                      textAlign: 'left', padding: '8px 12px',
                      fontSize: 11, color: '#64748b', textTransform: 'uppercase',
                      letterSpacing: 1, fontWeight: 600,
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {positions.map(pos => (
                <tr
                  key={pos.id}
                  style={{
                    borderBottom: '1px solid #1e2a42',
                    background: '#0f1424',
                  }}
                >
                  <td style={{ padding: '12px', fontFamily: 'IBM Plex Mono', fontSize: 14, fontWeight: 700, color: '#e2e8f0' }}>
                    {pos.ticker}
                  </td>
                  <td style={{ padding: '12px', fontFamily: 'IBM Plex Mono', fontSize: 13, color: '#94a3b8' }}>
                    {pos.shares_held?.toFixed(2)}
                  </td>
                  <td style={{ padding: '12px', fontFamily: 'IBM Plex Mono', fontSize: 13, color: '#94a3b8' }}>
                    ${pos.avg_cost_basis?.toFixed(2)}
                  </td>
                  <td style={{ padding: '12px', fontFamily: 'IBM Plex Mono', fontSize: 13, color: '#e2e8f0' }}>
                    {pos.current_price ? `$${pos.current_price.toFixed(2)}` : '—'}
                  </td>
                  <td style={{ padding: '12px', fontFamily: 'IBM Plex Mono', fontSize: 13 }}>
                    {pos.unrealized_pnl_pct != null ? (
                      <span style={{ color: pos.unrealized_pnl_pct >= 0 ? '#10b981' : '#ef4444' }}>
                        {pos.unrealized_pnl_pct >= 0 ? '+' : ''}{pos.unrealized_pnl_pct.toFixed(1)}%
                      </span>
                    ) : '—'}
                  </td>
                  <td style={{ padding: '12px', fontFamily: 'IBM Plex Mono', fontSize: 13 }}>
                    {perfByTicker[pos.ticker] ? (
                      <span style={{ color: perfByTicker[pos.ticker].ivvReturnPct >= 0 ? '#10b981' : '#ef4444' }}>
                        {perfByTicker[pos.ticker].ivvReturnPct >= 0 ? '+' : ''}{perfByTicker[pos.ticker].ivvReturnPct.toFixed(1)}%
                      </span>
                    ) : '—'}
                  </td>
                  <td style={{ padding: '12px', fontFamily: 'IBM Plex Mono', fontSize: 13, fontWeight: 600 }}>
                    {perfByTicker[pos.ticker] ? (
                      <span style={{ color: perfByTicker[pos.ticker].alpha >= 0 ? '#10b981' : '#ef4444' }}>
                        {perfByTicker[pos.ticker].alpha >= 0 ? '+' : ''}{perfByTicker[pos.ticker].alpha.toFixed(1)}%
                      </span>
                    ) : '—'}
                  </td>
                  <td style={{ padding: '12px', fontFamily: 'IBM Plex Mono', fontSize: 13, color: '#64748b' }}>
                    {weeksByTicker[pos.ticker] ?? pos.weeks_held ?? 0}
                  </td>
                  <td style={{ padding: '12px' }}>
                    <span
                      style={{
                        fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 3,
                        background: pos.thesis_intact ? '#0a1a0a' : '#1a0a0a',
                        color: pos.thesis_intact ? '#10b981' : '#ef4444',
                      }}
                    >
                      {pos.thesis_intact ? 'INTACT' : 'AT RISK'}
                    </span>
                  </td>
                  <td style={{ padding: '12px' }}>
                    {signalsById[pos.id] ? (
                      <span
                        style={{
                          fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 3,
                          background: '#0b1020',
                          color: SIGNAL_COLORS[signalsById[pos.id]] || '#94a3b8',
                          border: `1px solid ${SIGNAL_COLORS[signalsById[pos.id]] || '#1e2a42'}`,
                        }}
                      >
                        {signalsById[pos.id].replace(/_/g, ' ')}
                      </span>
                    ) : (
                      <span style={{ fontSize: 12, color: '#64748b' }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: '12px', fontFamily: 'IBM Plex Mono', fontSize: 11, color: '#64748b' }}>
                    {pos.last_reviewed || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Review log */}
      {reviewProgress.length > 0 && (
        <div
          style={{
            marginTop: 24, background: '#080c17', border: '1px solid #1e2a42', borderRadius: 8,
            padding: 16, fontFamily: 'IBM Plex Mono', fontSize: 12, maxHeight: 250, overflowY: 'auto',
          }}
        >
          {reviewProgress.map((p, i) => (
            <div key={i} style={{ marginBottom: 4, display: 'flex', gap: 12 }}>
              <span style={{ color: '#2563eb', flexShrink: 0 }}>{p.ts}</span>
              <span style={{ color: p.msg.startsWith('✅') ? '#10b981' : p.msg.startsWith('❌') ? '#ef4444' : p.msg.includes('🔔') ? '#f59e0b' : '#94a3b8' }}>
                {p.msg}
              </span>
            </div>
          ))}
        </div>
      )}

      {reviewError && (
        <div style={{ background: '#1a0a0a', border: '1px solid #ef4444', borderRadius: 8, padding: 14, color: '#ef4444', fontSize: 13, marginTop: 16 }}>
          {reviewError}
        </div>
      )}
    </div>
  )
}

// --- formatting helpers ---
function money(n) {
  return `$${(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
function signedMoney(n) {
  const v = n || 0
  return `${v >= 0 ? '+' : '-'}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
function signedPct(n) {
  const v = n || 0
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}
function pnlColor(n) {
  return (n || 0) >= 0 ? '#10b981' : '#ef4444'
}
