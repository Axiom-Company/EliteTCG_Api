-- ══════════════════════════════════════════════════════════════
-- Pack Inventory — Real packs opened by admin, assigned to users
-- ══════════════════════════════════════════════════════════════

-- Each row = one real physical pack opened on camera
CREATE TABLE IF NOT EXISTS opened_packs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  set_id TEXT NOT NULL,                          -- e.g. 'sv8', 'sv7'
  set_name TEXT NOT NULL,                        -- e.g. 'Surging Sparks'
  pack_number INT NOT NULL,                      -- sequential within a set batch
  status TEXT NOT NULL DEFAULT 'available',       -- available | reserved | sold
  video_url TEXT,                                 -- link to the opening video
  total_value_zar NUMERIC(10,2) DEFAULT 0,       -- sum of card prices
  assigned_to UUID REFERENCES auth.users(id),    -- customer who got this pack
  assigned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(set_id, pack_number)
);

-- Each row = one card inside a real pack
CREATE TABLE IF NOT EXISTS pack_cards (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  pack_id UUID NOT NULL REFERENCES opened_packs(id) ON DELETE CASCADE,
  card_name TEXT NOT NULL,
  card_number TEXT,                               -- e.g. '152/191'
  rarity TEXT NOT NULL DEFAULT 'common',          -- common | uncommon | rare | ultra_rare
  image_url TEXT,                                 -- card image URL
  price_zar NUMERIC(10,2) DEFAULT 0,
  sort_order INT DEFAULT 0,                       -- display order (best last)
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_opened_packs_status ON opened_packs(status);
CREATE INDEX IF NOT EXISTS idx_opened_packs_set_id ON opened_packs(set_id);
CREATE INDEX IF NOT EXISTS idx_opened_packs_assigned_to ON opened_packs(assigned_to);
CREATE INDEX IF NOT EXISTS idx_pack_cards_pack_id ON pack_cards(pack_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_opened_packs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_opened_packs_updated_at ON opened_packs;
CREATE TRIGGER trg_opened_packs_updated_at
  BEFORE UPDATE ON opened_packs
  FOR EACH ROW EXECUTE FUNCTION update_opened_packs_updated_at();
