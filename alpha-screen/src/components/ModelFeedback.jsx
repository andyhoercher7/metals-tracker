import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

const emptyFeedback = {
  week_date: new Date().toISOString().split('T')[0],
  picks_reviewed_count: '',
  avg_return_vs_target: '',
  best_performing_factor: '',
  worst_performing_factor: '',
  notes: '',
}

const WEIGHT_FIELDS = [
  ['earnings_growth_weight', 'Earnings Growth'],
  ['valuation_weight', 'Valuation'],
  ['momentum_weight', 'Momentum'],
  ['quality_weight', 'Quality / ROE'],
  ['revenue_growth_weight', 'Revenue Growth'],
  ['balance_sheet_weight', 'Balance Sheet'],
  ['analyst_revision_weight', 'Analyst Revisions'],
]

export default function ModelFeedback() {
  const [feedback, setFeedback] = useState([])
  const [weights, setWeights] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(emptyFeedback)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [saveSuccess, setSaveSuccess] = useState(null)

  // Accept / reject of the model's weight recommendation.
  const [applying, setApplying] = useState(false)
  const [actionError, setActionError] = useState(null)

  const loadData = () => {
    return Promise.all([
      supabase.from('model_feedback').select('*').order('week_date', { ascending: false }).limit(20),
      supabase.from('factor_weights').select('*').order('effective_date', { ascending: false }).limit(10),
    ]).then(([fb, fw]) => {
      if (fb.error) setError(fb.error.message)
      else setFeedback(fb.data || [])
      if (!fw.error) setWeights(fw.data || [])
      setLoading(false)
    })
  }

  useEffect(() => { loadData() }, [])

  const handleSaveFeedback = async (e) => {
    e.preventDefault()
    setSaving(true)
    setSaveError(null)
    setSaveSuccess(null)
    try {
      const row = {
        week_date: form.week_date,
        picks_reviewed_count: form.picks_reviewed_count ? parseInt(form.picks_reviewed_count, 10) : null,
        avg_return_vs_target: form.avg_return_vs_target ? parseFloat(form.avg_return_vs_target) : null,
        best_performing_factor: form.best_performing_factor || null,
        worst_performing_factor: form.worst_performing_factor || null,
        notes: form.notes || null,
      }
      const { error: err } = await supabase.from('model_feedback').insert(row)
      if (err) throw err
      setSaveSuccess('Feedback entry saved. The model reads your recent notes before the next weekly screen.')
      setForm(emptyFeedback)
      setShowForm(false)
      await loadData()
    } catch (err) {
      setSaveError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const latest = feedback[0]
  const currentWeights = weights[0]

  // Apply the model's recommended weights: write a new factor_weights row that
  // the next weekly screen will use, and mark the suggestion accepted.
  const applyRecommendation = async () => {
    const rec = latest?.suggested_weight_adjustments?.recommended_weights
    if (!rec) return
    setApplying(true)
    setActionError(null)
    try {
      const row = {
        effective_date: new Date().toISOString().split('T')[0],
        version_notes: `Applied model suggestion from ${latest.week_date}`,
      }
      Object.entries(rec).forEach(([k, v]) => { row[k] = v.suggested })
      const { error: e1 } = await supabase.from('factor_weights').insert(row)
      if (e1) throw e1
      const { error: e2 } = await supabase.from('model_feedback').update({ suggestions_decision: 'accepted' }).eq('id', latest.id)
      if (e2) throw e2
      await loadData()
    } catch (err) {
      setActionError(err.message)
    } finally {
      setApplying(false)
    }
  }

  const rejectRecommendation = async () => {
    if (!latest) return
    setApplying(true)
    setActionError(null)
    try {
      const { error } = await supabase.from('model_feedback').update({ suggestions_decision: 'rejected' }).eq('id', latest.id)
      if (error) throw error
      await loadData()
    } catch (err) {
      setActionError(err.message)
    } finally {
      setApplying(false)
    }
  }

  if (loading) {
    return <div style={{ padding: 40, color: '#64748b', fontFamily: 'IBM Plex Mono', fontSize: 13 }}>Loading feedback...</div>
  }

  const sugg = latest?.suggested_weight_adjustments
  const rec = sugg?.recommended_weights
  const decision = latest?.suggestions_decision || 'pending'
  const changed = rec ? Object.values(rec).filter(v => Math.abs(v.suggested - v.current) > 0.0001) : []
  const lowConf = sugg && (sugg.weeks_of_history || 0) < (sugg.weeks_recommended || 8)

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#e2e8f0' }}>Model Feedback</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>Factor weight history, macro theme accuracy, and learning loop</p>
        </div>
        <button
          onClick={() => { setShowForm(s => !s); setSaveSuccess(null); setSaveError(null) }}
          style={{
            background: showForm ? 'transparent' : '#2563eb', color: showForm ? '#94a3b8' : '#fff',
            border: showForm ? '1px solid #253048' : 'none', borderRadius: 6, padding: '10px 18px',
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          {showForm ? 'Cancel' : '+ Add Feedback'}
        </button>
      </div>

      {saveSuccess && (
        <div style={{ background: '#0a1a0a', border: '1px solid #10b981', borderRadius: 8, padding: 12, color: '#10b981', fontSize: 13, marginBottom: 16 }}>
          {saveSuccess}
        </div>
      )}

      {showForm && (
        <div style={{ background: '#0f1424', border: '1px solid #2563eb', borderRadius: 8, padding: 20, marginBottom: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>New Feedback Entry</div>
          <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 16px' }}>
            Notes you add here are fed into the AI before the next weekly screen — a plain-English way to steer it. This does not change the numeric factor weights.
          </p>
          <form onSubmit={handleSaveFeedback}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 14 }}>
              <FbField label="Week Date" type="date" value={form.week_date} onChange={v => setForm(f => ({ ...f, week_date: v }))} required />
              <FbField label="Picks Reviewed" type="number" value={form.picks_reviewed_count} onChange={v => setForm(f => ({ ...f, picks_reviewed_count: v }))} />
              <FbField label="Avg Return vs Target (%)" type="number" value={form.avg_return_vs_target} onChange={v => setForm(f => ({ ...f, avg_return_vs_target: v }))} />
              <FbField label="Best Performing Factor" value={form.best_performing_factor} onChange={v => setForm(f => ({ ...f, best_performing_factor: v }))} />
              <FbField label="Worst Performing Factor" value={form.worst_performing_factor} onChange={v => setForm(f => ({ ...f, worst_performing_factor: v }))} />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={fbLabelStyle}>Notes</label>
              <textarea
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Observations, lessons, patterns to watch..."
                rows={3}
                style={{ ...fbInputStyle, width: '100%', resize: 'vertical', fontFamily: 'IBM Plex Sans' }}
              />
            </div>
            {saveError && <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 10 }}>{saveError}</div>}
            <button type="submit" disabled={saving} style={{ background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '10px 24px', fontSize: 14, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1 }}>
              {saving ? 'Saving...' : 'Save Feedback'}
            </button>
          </form>
        </div>
      )}

      {error && (
        <div style={{ background: '#1a0a0a', border: '1px solid #ef4444', borderRadius: 8, padding: 14, color: '#ef4444', fontSize: 13, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {/* Suggested weight change — with real Accept / Reject */}
      {rec && (
        <div style={{ background: '#0f1a0a', border: '1px solid #10b981', borderRadius: 8, padding: 20, marginBottom: 24 }}>
          <div style={{ fontSize: 11, color: '#10b981', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700, marginBottom: 10 }}>
            Suggested Weight Change (from the learning loop)
          </div>
          {changed.length === 0 ? (
            <div style={{ fontSize: 13, color: '#94a3b8' }}>
              No weight change recommended this week — current weights are aligned with recent performance.
            </div>
          ) : (
            <>
              <p style={{ fontSize: 13, color: '#cbd5e1', margin: '0 0 14px', lineHeight: 1.6 }}>{sugg.recommendation_rationale}</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
                {WEIGHT_FIELDS.map(([field, label]) => {
                  const v = rec[field]
                  if (!v) return null
                  const diff = +(v.suggested - v.current).toFixed(4)
                  const isChg = Math.abs(diff) > 0.0001
                  return (
                    <div key={field} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, opacity: isChg ? 1 : 0.55 }}>
                      <span style={{ color: '#94a3b8' }}>{label}</span>
                      <span className="font-mono">
                        <span style={{ color: '#64748b' }}>{(v.current * 100).toFixed(0)}%</span>
                        {isChg && <span style={{ color: '#e2e8f0' }}> → </span>}
                        {isChg && (
                          <span style={{ color: diff > 0 ? '#10b981' : '#ef4444', fontWeight: 700 }}>
                            {(v.suggested * 100).toFixed(0)}% ({diff > 0 ? '+' : ''}{(diff * 100).toFixed(0)}pp)
                          </span>
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
              {lowConf && (
                <div style={{ fontSize: 12, color: '#f59e0b', marginBottom: 12, lineHeight: 1.6 }}>
                  ⚠ Only {sugg.weeks_of_history} weeks of history ({sugg.weeks_recommended}+ recommended). Low-confidence, directional suggestion — it's a small change, safe to try or skip.
                </div>
              )}
              {actionError && <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 10 }}>{actionError}</div>}
              {decision === 'pending' ? (
                <div style={{ display: 'flex', gap: 10 }}>
                  <button onClick={applyRecommendation} disabled={applying} style={{ background: '#10b981', color: '#04120b', border: 'none', borderRadius: 6, padding: '9px 20px', fontSize: 13, fontWeight: 700, cursor: applying ? 'not-allowed' : 'pointer', opacity: applying ? 0.6 : 1 }}>
                    {applying ? 'Applying…' : '✓ Accept & use next screen'}
                  </button>
                  <button onClick={rejectRecommendation} disabled={applying} style={{ background: 'transparent', color: '#94a3b8', border: '1px solid #253048', borderRadius: 6, padding: '9px 20px', fontSize: 13, fontWeight: 600, cursor: applying ? 'not-allowed' : 'pointer' }}>
                    Reject
                  </button>
                </div>
              ) : (
                <div style={{ fontSize: 13, fontWeight: 700, color: decision === 'accepted' ? '#10b981' : '#94a3b8' }}>
                  {decision === 'accepted' ? '✓ Accepted — applied to the next weekly screen.' : '✕ Rejected — weights left unchanged.'}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Current factor weights + latest insights */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 24 }}>
        <div style={{ background: '#0f1424', border: '1px solid #1e2a42', borderRadius: 8, padding: 20 }}>
          <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 16 }}>Current Factor Weights</div>
          {currentWeights ? (
            WEIGHT_FIELDS.map(([field, label]) => {
              const val = (currentWeights[field] || 0) * 100
              return (
                <div key={field} style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 12, color: '#94a3b8' }}>{label}</span>
                    <span className="font-mono" style={{ fontSize: 12, color: '#2563eb', fontWeight: 600 }}>{val.toFixed(0)}%</span>
                  </div>
                  <div style={{ background: '#1e2a42', borderRadius: 2, height: 4 }}>
                    <div style={{ width: `${val}%`, height: '100%', background: '#2563eb', borderRadius: 2 }} />
                  </div>
                </div>
              )
            })
          ) : (
            <div style={{ fontSize: 13, color: '#64748b' }}>No weight data yet.</div>
          )}
          {currentWeights && (
            <div style={{ marginTop: 12, fontSize: 11, color: '#64748b' }}>
              Effective: {currentWeights.effective_date}
              {currentWeights.version_notes && ` · ${currentWeights.version_notes}`}
            </div>
          )}
        </div>

        <div style={{ background: '#0f1424', border: '1px solid #1e2a42', borderRadius: 8, padding: 20 }}>
          <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 16 }}>Latest Model Insights</div>
          {latest ? (
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                <div>
                  <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>Picks Reviewed</div>
                  <div className="font-mono" style={{ fontSize: 22, fontWeight: 700, color: '#e2e8f0' }}>{latest.picks_reviewed_count || '—'}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>Avg Return vs Target</div>
                  <div className="font-mono" style={{ fontSize: 22, fontWeight: 700, color: latest.avg_return_vs_target >= 0 ? '#10b981' : '#ef4444' }}>
                    {latest.avg_return_vs_target != null ? `${latest.avg_return_vs_target >= 0 ? '+' : ''}${latest.avg_return_vs_target.toFixed(1)}%` : '—'}
                  </div>
                </div>
              </div>
              {latest.best_performing_factor && (
                <div style={{ marginBottom: 8 }}>
                  <span style={{ fontSize: 11, color: '#64748b' }}>Best Factor: </span>
                  <span style={{ fontSize: 12, color: '#10b981', fontWeight: 600 }}>{latest.best_performing_factor}</span>
                </div>
              )}
              {latest.worst_performing_factor && (
                <div style={{ marginBottom: 8 }}>
                  <span style={{ fontSize: 11, color: '#64748b' }}>Worst Factor: </span>
                  <span style={{ fontSize: 12, color: '#ef4444', fontWeight: 600 }}>{latest.worst_performing_factor}</span>
                </div>
              )}
              {latest.notes && <p style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.6, margin: 0 }}>{latest.notes}</p>}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: '#64748b' }}>No feedback data yet. Complete at least one screen and weekly review to start the learning loop.</div>
          )}
        </div>
      </div>

      {/* Feedback history table */}
      {feedback.length > 0 && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 12 }}>Feedback History</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #1e2a42' }}>
                  {['Week', 'Picks Reviewed', 'Avg Return', 'Best Factor', 'Worst Factor'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: 1 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {feedback.map(f => (
                  <tr key={f.id} style={{ borderBottom: '1px solid #1e2a42' }}>
                    <td style={{ padding: '10px 12px', fontFamily: 'IBM Plex Mono', fontSize: 12, color: '#64748b' }}>{f.week_date}</td>
                    <td style={{ padding: '10px 12px', fontFamily: 'IBM Plex Mono', fontSize: 13, color: '#94a3b8' }}>{f.picks_reviewed_count || '—'}</td>
                    <td style={{ padding: '10px 12px', fontFamily: 'IBM Plex Mono', fontSize: 13 }}>
                      {f.avg_return_vs_target != null ? (
                        <span style={{ color: f.avg_return_vs_target >= 0 ? '#10b981' : '#ef4444' }}>
                          {f.avg_return_vs_target >= 0 ? '+' : ''}{f.avg_return_vs_target.toFixed(1)}%
                        </span>
                      ) : '—'}
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: 12, color: '#10b981' }}>{f.best_performing_factor || '—'}</td>
                    <td style={{ padding: '10px 12px', fontSize: 12, color: '#ef4444' }}>{f.worst_performing_factor || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

const fbLabelStyle = {
  display: 'block', fontSize: 11, color: '#64748b', marginBottom: 6,
  textTransform: 'uppercase', letterSpacing: 1,
}

const fbInputStyle = {
  width: '100%', background: '#080c17', border: '1px solid #1e2a42',
  color: '#e2e8f0', padding: '8px 12px', borderRadius: 6, fontSize: 13,
  fontFamily: 'IBM Plex Mono', outline: 'none',
}

function FbField({ label, value, onChange, type = 'text', required = false }) {
  return (
    <div>
      <label style={fbLabelStyle}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        required={required}
        step={type === 'number' ? 'any' : undefined}
        style={fbInputStyle}
      />
    </div>
  )
}
