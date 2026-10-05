-- Estimated market value for bullion = live spot + a premium per metal.
--
-- Almost nothing changes hands at spot: coins and bars carry a premium both
-- when you buy and when you sell. Valuing bullion at bare melt understates
-- what it would actually fetch.
--
-- The premium is a row, not a constant in the app, so it can be corrected
-- without a code change - and it carries a basis and a date, the same rule the
-- rest of the app applies to every estimate. That is the difference between
-- this and the hardcoded 1.1x / 4.5x multipliers it replaces.
--
-- Written without any DROP statement on purpose: DROP hangs on this project.

CREATE TABLE IF NOT EXISTS metal_premiums (
  metal        text PRIMARY KEY,
  premium_pct  numeric NOT NULL DEFAULT 0,
  basis        text,
  as_of        date NOT NULL DEFAULT current_date,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE metal_premiums ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated full access" ON metal_premiums
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Starting estimates only. They are meant to be replaced with real quotes;
-- each row says so in its basis.
INSERT INTO metal_premiums (metal, premium_pct, basis) VALUES
  ('gold', 6, 'Starting estimate: fractional gold (1/10 oz Eagles, 1 g bars) resells a few percent over spot. Replace with a real dealer buy-back quote.'),
  ('silver', 12, 'Starting estimate: generic rounds and bars private-sale over spot; junk silver sits nearer spot. Replace with a real quote.'),
  ('platinum', 5, 'Starting estimate. No holdings yet.'),
  ('palladium', 5, 'Starting estimate. No holdings yet.'),
  ('copper', 150, 'LOW CONFIDENCE GUESS. Copper bullion retails far above metal value and resells well below retail; there is no dealer bid. Check completed eBay sales for your exact bars and replace this number.')
ON CONFLICT (metal) DO NOTHING;
