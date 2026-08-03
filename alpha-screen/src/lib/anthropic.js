// Claude calls go through the `alpha-screen` Supabase edge function.
// The Anthropic API key lives server-side only — nothing ships to the browser.
//
// Long Claude runs (the weekly screen) execute as BACKGROUND JOBS via the
// Anthropic Batches API: the edge function submits the batch and returns a
// job id instantly, and the app polls until it finishes. This sidesteps the
// 150-second per-request limit on Supabase's free plan that killed screen
// runs mid-flight, and batch pricing is 50% of the standard API rate.
import { supabase } from './supabase'

async function invokeEdge(body) {
  const { data, error } = await supabase.functions.invoke('alpha-screen', { body })
  if (error) {
    // Non-2xx responses land in error.context; surface the server's message.
    let msg = error.message
    try {
      const detail = await error.context?.json()
      if (detail?.error) msg = detail.error
    } catch { /* keep generic message */ }
    throw new Error(msg)
  }
  if (data?.error) throw new Error(data.error)
  return data
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Submit a background Claude job and poll until it completes. If the tab is
// closed mid-run, the job keeps running server-side; re-clicking the button
// resumes waiting on the same job instead of paying for a second run.
async function runClaudeJob(startBody, onProgress, label) {
  const start = await invokeEdge(startBody)
  if (start.resumed) {
    onProgress?.(`Found a ${label.toLowerCase()} already in progress — resuming it (no double billing).`)
  }
  const t0 = Date.now()
  let lastNote = t0
  while (Date.now() - t0 < 90 * 60000) {
    await sleep(15000)
    const res = await invokeEdge({ action: 'claude-poll', job_id: start.job_id })
    if (res.status === 'done') return res.data
    if (res.status === 'error') throw new Error(res.error || `${label} failed`)
    if (onProgress && Date.now() - lastNote >= 120000) {
      lastNote = Date.now()
      const mins = Math.round((Date.now() - t0) / 60000)
      onProgress(`${label} still running (${mins} min in) — batch runs can take a while. Safe to leave this page; re-click later to resume.`)
    }
  }
  throw new Error(`${label} did not finish within 90 minutes. Click the button again to keep waiting — it resumes the same job.`)
}

export async function runWeeklyScreen(systemPrompt, onProgress) {
  onProgress?.('Submitting the two-stage screen to Claude as a background job...')
  const result = await runClaudeJob(
    { action: 'claude-start', kind: 'screen', systemPrompt },
    onProgress,
    'Screen',
  )
  onProgress?.('Screen response received and validated against schema.')
  return result
}

export async function runPositionReview(prompt, onProgress) {
  onProgress?.('Reviewing position server-side...')
  return invokeEdge({ action: 'position-review', prompt })
}

export { invokeEdge }
