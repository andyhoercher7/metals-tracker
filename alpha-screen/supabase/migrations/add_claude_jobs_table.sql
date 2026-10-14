-- Applied to the Supabase project on 2026-07-06 (copy for version control).
-- Background Claude jobs (Anthropic Batches API). The alpha-screen edge
-- function's long screen run was killed at Supabase's 150s free-plan wall
-- clock limit (status 546); jobs let the run happen asynchronously while the
-- client polls. RLS on with no policies: only the service role (edge
-- function) can read/write.
CREATE TABLE IF NOT EXISTS claude_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('screen','review')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','error')),
  batch_id text,
  system_prompt text,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  max_searches int NOT NULL DEFAULT 8,
  continuations int NOT NULL DEFAULT 0,
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE claude_jobs ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS claude_jobs_running_idx ON claude_jobs (kind, status, created_at DESC);
