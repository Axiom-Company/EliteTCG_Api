-- ============================================
-- Seed: 3 Realistic SA-Priced TCG Products
-- Run against Supabase SQL Editor
-- ============================================

-- 1. Pokémon TCG: Journey Together Booster Box (36 packs)
--    Realistic SA price: R3,299.99 (RRP R3,939.99)
--    Source: Rocket Grunt TCG, SA retailers March 2026
INSERT INTO products (
  name, slug, description, short_description,
  price, compare_at_price, cost,
  category, badge,
  is_active, is_featured,
  images, sku,
  rating, review_count
) VALUES (
  'Pokémon TCG: Journey Together Booster Box',
  'pokemon-journey-together-booster-box',
  'Factory sealed Pokémon TCG Scarlet & Violet - Journey Together Booster Box containing 36 booster packs. Features powerful new Trainer-focused cards including Trainer ex cards, special art rares, and stunning illustrations celebrating the bond between Trainers and their Pokémon. Each pack contains 10 cards with a guaranteed foil in every pack.',
  'Sealed booster box · 36 packs · Journey Together',
  3299.99,
  3939.99,
  2400.00,
  'booster_box',
  'hot',
  true,
  true,
  '[]',
  'PKM-JT-BB-001',
  4.8,
  47
);

-- Inventory for Journey Together BB
INSERT INTO inventory (product_id, quantity, low_stock_threshold)
SELECT id, 12, 3 FROM products WHERE slug = 'pokemon-journey-together-booster-box';

-- 2. Yu-Gi-Oh! TCG: 25th Anniversary Rarity Collection II Booster Box
--    Realistic SA price: R1,895.00
--    Source: Sword and Board, SA retailers March 2026
INSERT INTO products (
  name, slug, description, short_description,
  price, compare_at_price, cost,
  category, badge,
  is_active, is_featured,
  images, sku,
  rating, review_count
) VALUES (
  'Yu-Gi-Oh! 25th Anniversary Rarity Collection II Booster Box',
  'yugioh-25th-anniversary-rarity-collection-2-box',
  'Factory sealed Yu-Gi-Oh! 25th Anniversary Rarity Collection II Booster Box containing 24 packs. This premium collector''s set features iconic cards reprinted as Quarter Century Secret Rares, Ultra Rares, and Super Rares. Includes fan-favourite cards from across 25 years of Yu-Gi-Oh! history with stunning anniversary-edition artwork.',
  'Sealed booster box · 24 packs · 25th Anniversary',
  1895.00,
  null,
  1350.00,
  'booster_box',
  'new',
  true,
  true,
  '[]',
  'YGO-RC2-BB-001',
  4.9,
  32
);

-- Inventory for YGO 25th Anniversary RC2
INSERT INTO inventory (product_id, quantity, low_stock_threshold)
SELECT id, 8, 2 FROM products WHERE slug = 'yugioh-25th-anniversary-rarity-collection-2-box';

-- 3. Pokémon TCG: Destined Rivals Elite Trainer Box (NO IMAGE - tests placeholder)
--    Realistic SA price: R1,249.99 (RRP R1,399.99)
--    Source: Rocket Grunt TCG, SA retailers March 2026
INSERT INTO products (
  name, slug, description, short_description,
  price, compare_at_price, cost,
  category, badge,
  is_active, is_featured,
  images, sku,
  rating, review_count
) VALUES (
  'Pokémon TCG: Destined Rivals Elite Trainer Box',
  'pokemon-destined-rivals-etb',
  'The Pokémon TCG: Scarlet & Violet - Destined Rivals Elite Trainer Box includes 9 booster packs, 1 full-art foil promo card, 65 card sleeves featuring a unique design, 45 Pokémon TCG Energy cards, a player''s guide to the expansion, 6 damage-counter dice, 1 competition-legal coin-flip die, 2 acrylic condition markers, and a collector''s box with 4 dividers.',
  'Elite Trainer Box · 9 packs · Destined Rivals',
  1249.99,
  1399.99,
  900.00,
  'etb',
  'new',
  true,
  true,
  '[]',
  'PKM-DR-ETB-001',
  4.7,
  19
);

-- Inventory for Destined Rivals ETB
INSERT INTO inventory (product_id, quantity, low_stock_threshold)
SELECT id, 15, 4 FROM products WHERE slug = 'pokemon-destined-rivals-etb';
