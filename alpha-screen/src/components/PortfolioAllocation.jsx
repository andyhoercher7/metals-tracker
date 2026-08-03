import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

// Weekly conviction-weighted allocation panel. Shows the model's target
// weights (20% single-name cap, ≤15-name target) and its trade plan —
// a new pick only appears here when it clearly beats a current holding.
// Accept/Reject is recorded per trade; accepted sells also flow into the
// Status column of the positions table below.
export default function PortfolioAllocation({ onDecisionChange }) {
  const [run, setRun] = useState(null)
  const [decisions, setDecisions] = useState({})
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)
  const [open, setOpen] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      const { data: runs } = await supabase
        .from('allocation_runs')
        .select('*')
        .eq('status', 'done')
        .order('created_at', { ascending: false })
        .limit(1)
      const latest = runs?.[0] || null
      setRun(latest)
      if (latest) {
        const { data: dec } = await supabase
          .from('allocation_decisions')
          .select('trade_key, decision')
          .eq('run_id', latest.id)
        const map = {}
        ;(dec || []).forEach(d => { map[d.trade_key] = d.decision })
        setDecisions(map)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const runNow = async () => {
    setRunning(true)
    setError(null)
    try {
      const { data, error: fnErr } = await supabase.functions.invoke('alpha-portfolio', {
        body: { action: 'recommend', force: true },
      })
      if (fnErr) throw fnErr
      if (data?.error) throw new Error(data.error)
      await load()
    } catch (err) {
      setError(`Allocation run failed: ${err.message}`)
    } finally {
      setRunning(false)
    }
  }

  const decide = async (tradeKey, decision) => {
    if (!run) return
    const { error: upErr } = await supabase
      .from('allocation_decisions')
      .upsert(
        { run_id: run.id, trade_key: tradeKey, decision },
        { onConflict: 'run_id,trade_key' },
      )
    if (upErr) { setError(upErr.message); return }
    setDecisions(prev => ({ ...prev, [tradeKey]: decision }))
    if (onDecisionChange) onDecisionChange()
  }

  const rec = run?.recommendation
  const snapByTicker = {}
  ;(rec?.holdings_snapshot || []).forEach(h => { snapByTicker[h.ticker] = h })
  const weights = [...(rec?.target_weights || [])].sort((a, b) => b.target_weight_pct - a.target_weight_pct)
  const trades = rec?.trades || []

  // Turn each target weight into an exact instruction: dollars (and shares)
  // to buy or sell to move from today's weight to the target. Moves smaller
  // than this are noise — not worth a trade or the commission/tax friction.
  const REBALANCE_MIN = 50
  const totalValue = rec?.total_value || 0
  // Names with a fired sell rule you haven't ruled on yet. The model is not
  // allowed to add to these, and the row says so — a buy here would silently
  // contradict the Sell Signals tab.
  const pendingSell = new Set(rec?.pending_sell_tickers || [])
  const rows = weights.map(w => {
    const snap = snapByTicker[w.ticker]
    const currentValue = snap?.value_usd ?? 0
    const targetValue = (w.target_weight_pct / 100) * totalValue
    const delta = targetValue - currentValue
    const price = snap?.price ?? null
    return {
      ...w,
      currentPct: snap?.weight_pct ?? null,
      currentValue,
      delta,
      shares: price ? Math.abs(delta) / price : null,
      isNew: !snap,
      pending: pendingSell.has(w.ticker),
    }
  })
  // Anything held but absent from the target list is a full exit.
  ;(rec?.holdings_snapshot || []).forEach(h => {
    if (weights.some(w => w.ticker === h.ticker)) return
    rows.push({
      ticker: h.ticker,
      conviction: 0,
      rationale: 'Not in the target portfolio — exit the full position.',
      target_weight_pct: 0,
      currentPct: h.weight_pct,
      currentValue: h.value_usd || 0,
      delta: -(h.value_usd || 0),
      shares: h.shares ?? null,
      isNew: false,
      pending: pendingSell.has(h.ticker),
    })
  })
  const totalBuys = rows.filter(r => r.delta > REBALANCE_MIN).reduce((s, r) => s + r.delta, 0)
  const totalSells = rows.filter(r => r.delta < -REBALANCE_MIN).reduce((s, r) => s - r.delta, 0)

  return (
    <div style={{ background: '#0f1424', border: '1px solid #253048', borderRadius: 8, padding: 16, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0' }}>
            ⚖ Portfolio Allocation
            {run && (
              <span style={{ fontSize: 11, fontWeight: 400, color: '#64748b', marginLeft: 10 }}>
                week of {run.week_date}
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
            Conviction-weighted targets · 20% max per stock · 15-name target (20 hard cap) · no new cash
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => setOpen(o => !o)}
            style={{ background: 'transparent', border: '1px solid #253048', color: '#94a3b8', borderRadius: 6, padding: '6px 12px', fontSize: 12, cursor: 'pointer' }}
          >
            {open ? 'Hide' : 'Show'}
          </button>
          <button
            onClick={runNow}
            disabled={running}
            style={{
              background: running ? '#1e2a42' : '#1a3a5f',
              color: running ? '#64748b' : '#60a5fa',
              border: '1px solid #2563eb', borderRadius: 6, padding: '6px 14px',
              fontSize: 12, fontWeight: 600, cursor: running ? 'not-allowed' : 'pointer',
            }}
          >
            {running ? '⟳ Running (~1 min)...' : '⟳ Re-run Allocation'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ background: '#1a0a0a', border: '1px solid #ef4444', borderRadius: 6, padding: 10, color: '#ef4444', fontSize: 12, marginTop: 12 }}>
          {error}
        </div>
      )}

      {open && (loading ? (
        <div style={{ color: '#64748b', fontSize: 12, marginTop: 12 }}>Loading...</div>
      ) : !run ? (
        <div style={{ color: '#64748b', fontSize: 12, marginTop: 12 }}>
          No allocation yet — it runs automatically every Sunday, or click Re-run Allocation.
        </div>
      ) : (
        <>
          {pendingSell.size > 0 && (
            <div style={{ background: '#1a1505', border: '1px solid #f59e0b', borderRadius: 6, padding: 10, color: '#f59e0b', fontSize: 12, marginTop: 12 }}>
              ⚠ {[...pendingSell].join(', ')} {pendingSell.size === 1 ? 'has' : 'have'} a sell signal you
              haven't decided on yet. The allocation will not add to {pendingSell.size === 1 ? 'it' : 'them'} —
              settle the signal on the Sell Signals tab first, then re-run this.
            </div>
          )}

          {rec?.summary && (
            <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.6, marginTop: 12, background: '#0b1020', border: '1px solid #1e2a42', borderRadius: 6, padding: 12 }}>
              {rec.summary}
            </div>
          )}

          {/* Trade plan */}
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600, marginBottom: 8 }}>
              This week's trades
            </div>
            {trades.length === 0 ? (
              <div style={{ fontSize: 12, color: '#10b981', background: '#0a1a0a', border: '1px solid #10b98133', borderRadius: 6, padding: 10 }}>
                No trades this week. {rec?.no_trade_reason || 'No new pick clearly beats what you already own.'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {trades.map(t => {
                  const key = `${t.action}:${t.ticker}`
                  const decided = decisions[key]
                  const isSell = t.action === 'SELL_ALL' || t.action === 'TRIM'
                  const color = isSell ? '#ef4444' : '#10b981'
                  const label =
                    t.action === 'SELL_ALL' ? 'SELL ALL' :
                    t.action === 'TRIM' ? 'TRIM' :
                    t.action === 'BUY_NEW' ? 'BUY NEW' : 'ADD'
                  return (
                    <div key={key} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', background: '#080c17', border: `1px solid ${decided ? '#253048' : color}`, borderRadius: 6, padding: '10px 12px' }}>
                      <span className="font-mono" style={{ fontSize: 11, fontWeight: 700, color, minWidth: 66 }}>{label}</span>
                      <div style={{ flex: 1 }}>
                        <span className="font-mono" style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>{t.ticker}</span>
                        <span className="font-mono" style={{ fontSize: 12, color: '#94a3b8', marginLeft: 8 }}>~${t.dollars.toLocaleString()}</span>
                        {t.replaces && (
                          <span style={{ fontSize: 11, color: '#f59e0b', marginLeft: 8 }}>replaces {t.replaces}</span>
                        )}
                        <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 3 }}>{t.rationale}</div>
                        {decided === 'accepted' && (
                          <div style={{ fontSize: 11, color: '#10b981', marginTop: 4 }}>
                            ✓ Accepted — place this trade at your broker, then record it in the Trade Log so the tracker updates.
                          </div>
                        )}
                        {decided === 'rejected' && (
                          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>✕ Rejected — no action.</div>
                        )}
                      </div>
                      {!decided ? (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            onClick={() => decide(key, 'accepted')}
                            style={{ background: '#0a1a0a', color: '#10b981', border: '1px solid #10b981', borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                          >
                            Accept
                          </button>
                          <button
                            onClick={() => decide(key, 'rejected')}
                            style={{ background: 'transparent', color: '#94a3b8', border: '1px solid #253048', borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                          >
                            Reject
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => decide(key, decided === 'accepted' ? 'rejected' : 'accepted')}
                          style={{ background: 'transparent', color: '#64748b', border: '1px solid #1e2a42', borderRadius: 6, padding: '5px 10px', fontSize: 11, cursor: 'pointer' }}
                        >
                          Undo
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Rebalance plan: exact dollars/shares to reach each target weight */}
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600, marginBottom: 8 }}>
              Rebalance plan — what to buy / sell to hit target
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #1e2a42' }}>
                    {['Ticker', 'Conviction', 'Now', 'Target', '', 'Buy / Sell'].map((h, i) => (
                      <th key={i} style={{ textAlign: i >= 2 ? 'right' : 'left', padding: '6px 8px', fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const buy = r.delta > REBALANCE_MIN
                    const sell = r.delta < -REBALANCE_MIN
                    const actionColor = buy ? '#10b981' : sell ? '#ef4444' : '#64748b'
                    return (
                      <tr key={r.ticker} style={{ borderBottom: '1px solid #131c30' }} title={r.rationale}>
                        <td className="font-mono" style={{ padding: '7px 8px', fontSize: 12, fontWeight: 700, color: '#e2e8f0' }}>
                          {r.ticker}
                          {r.isNew && <span style={{ fontSize: 9, color: '#10b981', marginLeft: 5 }}>NEW</span>}
                          {r.pending && (
                            <div style={{ fontSize: 9, color: '#f59e0b', fontWeight: 600, marginTop: 2 }}>
                              ⚠ SELL SIGNAL PENDING
                            </div>
                          )}
                        </td>
                        <td className="font-mono" style={{ padding: '7px 8px', fontSize: 11, color: '#64748b' }}>
                          {r.conviction ? `${r.conviction}/10` : '—'}
                        </td>
                        <td className="font-mono" style={{ padding: '7px 8px', fontSize: 11, color: '#94a3b8', textAlign: 'right' }}>
                          {r.currentPct != null ? `${r.currentPct}%` : '—'}
                        </td>
                        <td className="font-mono" style={{ padding: '7px 8px', fontSize: 12, color: '#60a5fa', textAlign: 'right', fontWeight: 600 }}>
                          {r.target_weight_pct}%
                        </td>
                        <td style={{ padding: '7px 8px', width: 90 }}>
                          <div style={{ background: '#080c17', borderRadius: 3, height: 10, position: 'relative', overflow: 'hidden' }}>
                            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.min(100, r.target_weight_pct * 5)}%`, background: '#1a3a5f' }} />
                            {r.currentPct != null && (
                              <div style={{ position: 'absolute', left: `${Math.min(100, r.currentPct * 5)}%`, top: 0, bottom: 0, width: 2, background: '#f59e0b' }} />
                            )}
                          </div>
                        </td>
                        <td className="font-mono" style={{ padding: '7px 8px', fontSize: 12, color: actionColor, textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap' }}>
                          {buy || sell ? (
                            <>
                              {buy ? 'BUY ' : 'SELL '}${Math.round(Math.abs(r.delta)).toLocaleString()}
                              {r.shares != null && (
                                <span style={{ color: '#64748b', fontWeight: 400, marginLeft: 6 }}>
                                  ~{r.shares.toFixed(2)} sh
                                </span>
                              )}
                            </>
                          ) : (
                            <span style={{ color: '#64748b', fontWeight: 400 }}>on target</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 11, flexWrap: 'wrap' }}>
              <span style={{ color: '#10b981' }}>Total to buy: ${Math.round(totalBuys).toLocaleString()}</span>
              <span style={{ color: '#ef4444' }}>Total to sell: ${Math.round(totalSells).toLocaleString()}</span>
              <span style={{ color: '#64748b' }}>
                Portfolio ${Math.round(totalValue).toLocaleString()} · buys and sells offset, so no new cash is needed.
              </span>
            </div>
            <div style={{ fontSize: 10, color: '#64748b', marginTop: 6 }}>
              Share counts use the prices from when this ran — round to whole shares if your broker requires it. Moves under
              ${REBALANCE_MIN} are shown as "on target" (not worth the friction). Hover a row for the model's reasoning.
            </div>
          </div>
        </>
      ))}
    </div>
  )
}
