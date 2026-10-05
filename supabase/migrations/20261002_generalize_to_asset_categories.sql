-- Turn the metals-only tracker into a general "things of value" tracker.
-- Table name stays metals_entries so nothing breaks; it now holds any asset.
-- Nothing is dropped and no rows are deleted.

-- Categories are DATA, not code: adding one (and its extra fields) needs no
-- app change. detail_fields drives the per-category inputs in the UI.
CREATE TABLE IF NOT EXISTS asset_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  valuation_method text NOT NULL DEFAULT 'appraisal'
    CHECK (valuation_method IN ('spot','comp','appraisal','cost')),
  is_metal boolean NOT NULL DEFAULT false,
  detail_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort_order int NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE asset_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated full access" ON asset_categories;
CREATE POLICY "authenticated full access" ON asset_categories
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

INSERT INTO asset_categories (name, valuation_method, is_metal, sort_order, detail_fields) VALUES
  ('Precious Metals', 'spot', true, 10, '[]'::jsonb),
  ('Art', 'appraisal', false, 20, '[{"key":"artist","label":"Artist"},{"key":"year","label":"Year"},{"key":"medium","label":"Medium"},{"key":"dimensions","label":"Dimensions"},{"key":"provenance","label":"Provenance"}]'::jsonb),
  ('Sports Memorabilia', 'comp', false, 30, '[{"key":"player","label":"Player / Subject"},{"key":"year","label":"Year"},{"key":"set","label":"Set / Event"},{"key":"grade","label":"Grade"},{"key":"grader","label":"Grader (PSA/BGS/SGC)"},{"key":"cert","label":"Cert #"}]'::jsonb),
  ('Watches', 'comp', false, 40, '[{"key":"brand","label":"Brand"},{"key":"model","label":"Model"},{"key":"ref","label":"Reference #"},{"key":"serial","label":"Serial #"},{"key":"box_papers","label":"Box & Papers"}]'::jsonb),
  ('Graded Coins', 'comp', true, 50, '[{"key":"grade","label":"Grade"},{"key":"grader","label":"Grader (PCGS/NGC)"},{"key":"cert","label":"Cert #"},{"key":"mint_year","label":"Mint Year"}]'::jsonb),
  ('Jewelry', 'appraisal', true, 60, '[{"key":"karat","label":"Karat / Purity"},{"key":"stones","label":"Stones"},{"key":"maker","label":"Maker"}]'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- Generic asset columns. The existing metals columns (metal, oz,
-- mkt_price_per_oz) stay and keep working for bullion.
ALTER TABLE metals_entries
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'Precious Metals',
  ADD COLUMN IF NOT EXISTS quantity numeric NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS valuation_method text NOT NULL DEFAULT 'spot',
  ADD COLUMN IF NOT EXISTS value_each numeric,
  -- WHERE an estimate came from and WHEN. A value with no source and no date
  -- is exactly what made the old numbers impossible to check.
  ADD COLUMN IF NOT EXISTS value_as_of date,
  ADD COLUMN IF NOT EXISTS value_source text,
  ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE metals_entries DROP CONSTRAINT IF EXISTS metals_entries_valuation_method_check;
ALTER TABLE metals_entries ADD CONSTRAINT metals_entries_valuation_method_check
  CHECK (valuation_method IN ('spot','comp','appraisal','cost'));

-- Non-metal assets have no metal or troy weight, and an inherited or gifted
-- item may have no purchase price.
ALTER TABLE metals_entries ALTER COLUMN metal DROP NOT NULL;
ALTER TABLE metals_entries ALTER COLUMN oz   DROP NOT NULL;
ALTER TABLE metals_entries ALTER COLUMN cost DROP NOT NULL;

-- Everything already in the table is bullion priced off spot.
UPDATE metals_entries
   SET category = 'Precious Metals', valuation_method = 'spot'
 WHERE category = 'Precious Metals';

CREATE INDEX IF NOT EXISTS metals_entries_user_category_idx
  ON metals_entries (user_id, category);
