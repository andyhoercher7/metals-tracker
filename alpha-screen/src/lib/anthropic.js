// Claude calls now go through the `alpha-screen` Supabase edge function.
// The Anthropic API key lives server-side only — nothing ships to the browser.
// The edge function enforces a JSON schema on the model output, so responses
// arrive as already-parsed, shape-guaranteed objects (no regex extraction).
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

export async function runWeeklyScreen(systemPrompt, onProgress) {
  onProgress?.('Running two-stage screen server-side (Claude Opus + web search)...')
  const result = await invokeEdge({ action: 'run-screen', systemPrompt })
  onProgress?.('Screen response received and validated against schema.')
  return result
}

export async function runPositionReview(prompt, onProgress) {
  onProgress?.('Reviewing position server-side...')
  return invokeEdge({ action: 'position-review', prompt })
}

export { invokeEdge }
