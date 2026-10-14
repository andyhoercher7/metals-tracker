import { useState, useEffect } from 'react'
import { usePicks, usePickWeeks } from '../hooks/usePicks'
import { fetchQuotes } from '../lib/prices'
import { fetchFundamentalsBatch } from '../lib/fundamentals'
import { supabase } from '../lib/supabase'
import PickCard from './PickCard'

export default function Dashboard() {
  const weeks = usePickWeeks()
  const [selectedWeek, setSelectedWeek] = useState(null)
  const { picks, loading, error, refetch } = usePicks(selectedWeek)
  const [refreshingFund, setRefreshingFund] = useState(false)
  const [fundMsg, setFundMsg] = useState(null)

  // Pull verified fundamentals from Finnhub (server-side, via the alpha-screen
  // edge function) and overwrite the stored screen metrics for the displayed
  // week — fixes Claude's bad estimates without a paid re-run.
  const refreshFundamentals = async () => {
    if (picks.length === 0) return
    setRefreshingFund(true)
    setFundMsg(null)
    try {
      const week = picks[0].week_date
      const resp = await fetchFundamentalsBatch(picks.map(p => p.ticker))
      if (!resp.configured) {
        setFundMsg('FINNHUB_API_KEY is not set on the server (Supabase → Edge Functions → Secrets).')
        return
      }
      let updated = 0
      for (const [ticker, f] of Object.entries(resp.data || {})) {
        const { error: err } = await supabase
          .from('weekly_screens')
          .update(f)
          .eq('ticker', ticker)
          .eq('week_date', week)
        if (!err) updated++
      }
      setFundMsg(`Updated verified fundamentals for ${updated}/${picks.length} picks.`)
      refetch()
    } catch (e) {
      setFundMsg(`Error: ${e.message}`)
    } finally {
      setRefreshingFund(false)
    }
  }
  const [livePrices, setLivePrices] = useState({})
  const [priceAsOf, setPriceAsOf] = useState(null)
  const [ownedTickers, setOwnedTickers] = useState(new Set())
  const [firstSeen, setFirstSeen] = useState({}) // ticker -> earliest week_date ever picked

  // Determine which picks you already own and which week each ticker was first
  // recommended (to flag brand-new picks).
  useEffect(() => {
    supabase
      .from('position_tracker')
      .select('ticker')
      .gt('shares_held', 0)
      .then(({ data }) => setOwnedTickers(new Set((data || []).map(d => d.ticker))))

    supabase
      .from('picks')
      .select('ticker, week_date')
      .then(({ data }) => {
        const earliest = {}
        ;(data || []).forEach(p => {
          if (!earliest[p.ticker] || p.week_date < earliest[p.ticker]) earliest[p.ticker] = p.week_date
        })
        setFirstSeen(earliest)
      })
  }, [])

  // Fetch prior-day close prices for the displayed picks so each card can show
  // current price + performance since the pick was recommended.
  useEffect(() => {
    if (picks.length === 0) return
    let cancelled = false
    fetchQuotes(picks.map(p => p.ticker)).then(res => {
      if (!cancelled) { setLivePrices(res.prices); setPriceAsOf(res.asOf) }
    })
    return () => { cancelled = true }
  }, [picks])

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>
        <div className="font-mono" style={{ fontSize: 13 }}>Loading picks...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ padding: 40 }}>
        <div style={{ background: '#1a0a0a', border: '1px solid #ef4444', borderRadius: 8, padding: 16, color: '#ef4444', fontSize: 13 }}>
          Error: {error}
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: 24 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#e2e8f0' }}>Weekly Picks</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
            Top 10 high-conviction picks targeting 2x in 12 months
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {picks.length > 0 && (
            <button
              onClick={refreshFundamentals}
              disabled={refreshingFund}
              title="Pull verified PEG, P/E, ROE, growth from Finnhub (server-side)"
              style={{
                background: 'transparent', color: refreshingFund ? '#64748b' : '#94a3b8',
                border: '1px solid #253048', borderRadius: 6, padding: '8px 14px',
                fontSize: 13, fontWeight: 600, cursor: refreshingFund ? 'not-allowed' : 'pointer',
              }}
            >
              {refreshingFund ? '⟳ Verifying...' : '↻ Refresh Fundamentals'}
            </button>
          )}
          {weeks.length > 0 && (
            <select
              value={selectedWeek || weeks[0]}
              onChange={e => setSelectedWeek(e.target.value)}
              style={{
                background: '#0f1424', border: '1px solid #1e2a42', color: '#e2e8f0',
                padding: '8px 12px', borderRadius: 6, fontSize: 13, fontFamily: 'IBM Plex Mono',
              }}
            >
              {weeks.map(w => (
                <option key={w} value={w}>{w}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {fundMsg && (
        <div style={{ background: '#0b1020', border: '1px solid #253048', borderRadius: 8, padding: 12, color: '#94a3b8', fontSize: 13, marginBottom: 16 }}>
          {fundMsg}
        </div>
      )}

      {picks.length === 0 ? (
        <div
          style={{
            textAlign: 'center', padding: 60,
            background: '#0f1424', border: '1px solid #1e2a42', borderRadius: 8,
          }}
        >
          <div style={{ fontSize: 40, marginBottom: 12 }}>◈</div>
          <div style={{ fontSize: 16, color: '#e2e8f0', marginBottom: 8 }}>No picks yet</div>
          <p style={{ fontSize: 13, color: '#64748b' }}>
            Go to <strong style={{ color: '#2563eb' }}>Run Screen</strong> to generate this week's picks with Claude AI.
          </p>
        </div>
      ) : (
        <>
          {/* Summary bar */}
          <div
            style={{
              display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12,
              marginBottom: 20,
            }}
          >
            {[
              { label: 'Total Picks', value: picks.length, mono: true },
              {
                label: 'Avg Composite', mono: true,
                value: (picks.reduce((s, p) => s + (p.composite_score || 0), 0) / picks.length).toFixed(1),
              },
              {
                label: 'US-Listed',
                value: `${picks.filter(p => p.us_listed).length}/${picks.length}`,
                mono: true,
              },
              {
                label: 'Avg Target Upside',
                value: picks.filter(p => p.price_at_pick && p.target_price).length > 0
                  ? `+${(picks
                      .filter(p => p.price_at_pick && p.target_price)
                      .reduce((s, p) => s + ((p.target_price - p.price_at_pick) / p.price_at_pick * 100), 0)
                      / picks.filter(p => p.price_at_pick && p.target_price).length).toFixed(0)}%`
                  : '—',
                color: '#10b981',
              },
            ].map(stat => (
              <div
                key={stat.label}
                style={{
                  background: '#0f1424', border: '1px solid #1e2a42', borderRadius: 6,
                  padding: '12px 16px',
                }}
              >
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>{stat.label}</div>
                <div
                  className={stat.mono !== false ? 'font-mono' : ''}
                  style={{ fontSize: 20, fontWeight: 700, color: stat.color || '#e2e8f0' }}
                >
                  {stat.value}
                </div>
              </div>
            ))}
          </div>

          {/* Picks list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {picks.map(pick => (
              <PickCard
                key={pick.id}
                pick={pick}
                livePrice={livePrices[pick.ticker]}
                closeDate={priceAsOf}
                owned={ownedTickers.has(pick.ticker)}
                isNew={firstSeen[pick.ticker] === pick.week_date}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
