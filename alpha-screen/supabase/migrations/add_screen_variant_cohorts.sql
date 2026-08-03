-- Applied to the Supabase project on 2026-07-05 (copy for version control).
-- Cohort tagging: which screening method produced each pick. Enables
-- head-to-head forward-alpha comparison (paper A/B) when a second screening
-- method (e.g. a paid data-API screener) is added later. Existing picks all
-- came from the LLM screen.
ALTER TABLE picks ADD COLUMN IF NOT EXISTS screen_variant text NOT NULL DEFAULT 'llm';
UPDATE picks SET screen_variant = 'llm' WHERE screen_variant IS NULL;
