-- ============================================
-- Card Portfolio Tracker
-- Run AFTER marketplace-v4.sql
-- ============================================

-- ============================================
-- TABLES
-- ============================================

-- Card Price Cache: stores fetched prices from pokemontcg.io
-- so we don't hammer the API on every page load.
CREATE TABLE IF NOT EXISTS card_price_cache (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- pokemontcg.io identifiers
    pokemon_tcg_id VARCHAR(50) NOT NULL UNIQUE,   -- e.g. "sv4-25"
    card_name VARCHAR(255) NOT NULL,
    set_name VARCHAR(255),
    set_code VARCHAR(20),
    card_number VARCHAR(50),
    supertype VARCHAR(50),       -- Pokémon, Trainer, Energy
    rarity VARCHAR(100),
    card_image_small VARCHAR(500),
    card_image_large VARCHAR(500),

    -- Market prices (USD from pokemontcg.io tcgplayer data)
    price_market DECIMAL(12, 2),         -- TCGplayer market price
    price_low DECIMAL(12, 2),            -- TCGplayer low price
    price_mid DECIMAL(12, 2),            -- TCGplayer mid price
    price_high DECIMAL(12, 2),           -- TCGplayer high price
    price_source VARCHAR(50) DEFAULT 'tcgplayer',

    -- ZAR conversion (we store both for display flexibility)
    price_market_zar DECIMAL(12, 2),
    usd_to_zar_rate DECIMAL(10, 4),

    -- Cache freshness
    fetched_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Portfolio Cards: a user's owned cards
CREATE TABLE IF NOT EXISTS portfolio_cards (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

    -- Card reference
    pokemon_tcg_id VARCHAR(50) NOT NULL,  -- links to card_price_cache
    card_name VARCHAR(255) NOT NULL,
    set_name VARCHAR(255),
    set_code VARCHAR(20),
    card_number VARCHAR(50),
    rarity VARCHAR(100),
    card_image_small VARCHAR(500),
    card_image_large VARCHAR(500),

    -- Ownership details
    quantity INTEGER NOT NULL DEFAULT 1,
    condition VARCHAR(20) DEFAULT 'near_mint',  -- mint, near_mint, excellent, good, played, poor
    is_graded BOOLEAN DEFAULT false,
    grading_company VARCHAR(50),
    grade VARCHAR(20),
    purchase_price DECIMAL(12, 2),  -- what the user paid (optional, for profit tracking)
    purchase_date DATE,
    notes TEXT,

    -- Snapshot of latest price at time of last refresh
    latest_price_market DECIMAL(12, 2),
    latest_price_market_zar DECIMAL(12, 2),
    price_updated_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- A user can't add the exact same card+condition combo twice; they update quantity instead
    UNIQUE(customer_id, pokemon_tcg_id, condition, is_graded, grade)
);

-- Portfolio Value Snapshots: daily roll-ups for the value-over-time graph
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

    snapshot_date DATE NOT NULL,
    total_cards INTEGER NOT NULL DEFAULT 0,
    unique_cards INTEGER NOT NULL DEFAULT 0,
    total_value_usd DECIMAL(14, 2) NOT NULL DEFAULT 0,
    total_value_zar DECIMAL(14, 2) NOT NULL DEFAULT 0,
    usd_to_zar_rate DECIMAL(10, 4),

    -- Top movers for that day (optional enrichment)
    top_gainer_card_id VARCHAR(50),
    top_gainer_change DECIMAL(12, 2),
    top_loser_card_id VARCHAR(50),
    top_loser_change DECIMAL(12, 2),

    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(customer_id, snapshot_date)
);

-- ============================================
-- INDEXES
-- ============================================

-- Card price cache
CREATE INDEX IF NOT EXISTS idx_card_price_cache_pokemon_tcg_id ON card_price_cache(pokemon_tcg_id);
CREATE INDEX IF NOT EXISTS idx_card_price_cache_set_code ON card_price_cache(set_code);
CREATE INDEX IF NOT EXISTS idx_card_price_cache_fetched_at ON card_price_cache(fetched_at);
CREATE INDEX IF NOT EXISTS idx_card_price_cache_card_name ON card_price_cache USING gin(to_tsvector('english', card_name));

-- Portfolio cards
CREATE INDEX IF NOT EXISTS idx_portfolio_cards_customer_id ON portfolio_cards(customer_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_cards_pokemon_tcg_id ON portfolio_cards(pokemon_tcg_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_cards_set_code ON portfolio_cards(set_code);
CREATE INDEX IF NOT EXISTS idx_portfolio_cards_created_at ON portfolio_cards(created_at DESC);

-- Portfolio snapshots
CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_customer_id ON portfolio_snapshots(customer_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_date ON portfolio_snapshots(snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_customer_date ON portfolio_snapshots(customer_id, snapshot_date DESC);

-- ============================================
-- TRIGGERS
-- ============================================

DROP TRIGGER IF EXISTS update_card_price_cache_updated_at ON card_price_cache;
CREATE TRIGGER update_card_price_cache_updated_at
    BEFORE UPDATE ON card_price_cache
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_portfolio_cards_updated_at ON portfolio_cards;
CREATE TRIGGER update_portfolio_cards_updated_at
    BEFORE UPDATE ON portfolio_cards
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- RLS (Row Level Security)
-- ============================================

ALTER TABLE card_price_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolio_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolio_snapshots ENABLE ROW LEVEL SECURITY;

-- Card price cache: everyone can read (it's public price data)
DROP POLICY IF EXISTS "Card prices are viewable by everyone" ON card_price_cache;
CREATE POLICY "Card prices are viewable by everyone"
    ON card_price_cache FOR SELECT
    USING (true);

-- Portfolio cards: owner only
DROP POLICY IF EXISTS "Users can manage own portfolio cards" ON portfolio_cards;
CREATE POLICY "Users can manage own portfolio cards"
    ON portfolio_cards FOR ALL
    USING (customer_id = auth.uid());

-- Portfolio snapshots: owner only
DROP POLICY IF EXISTS "Users can view own portfolio snapshots" ON portfolio_snapshots;
CREATE POLICY "Users can view own portfolio snapshots"
    ON portfolio_snapshots FOR SELECT
    USING (customer_id = auth.uid());

-- ============================================
-- FUNCTIONS
-- ============================================

-- Upsert a card into a user's portfolio (handles the quantity increment case)
CREATE OR REPLACE FUNCTION upsert_portfolio_card(
    p_customer_id UUID,
    p_pokemon_tcg_id VARCHAR,
    p_card_name VARCHAR,
    p_set_name VARCHAR,
    p_set_code VARCHAR,
    p_card_number VARCHAR,
    p_rarity VARCHAR,
    p_card_image_small VARCHAR,
    p_card_image_large VARCHAR,
    p_quantity INTEGER,
    p_condition VARCHAR DEFAULT 'near_mint',
    p_is_graded BOOLEAN DEFAULT false,
    p_grading_company VARCHAR DEFAULT NULL,
    p_grade VARCHAR DEFAULT NULL,
    p_purchase_price DECIMAL DEFAULT NULL,
    p_purchase_date DATE DEFAULT NULL,
    p_notes TEXT DEFAULT NULL,
    p_latest_price_market DECIMAL DEFAULT NULL,
    p_latest_price_market_zar DECIMAL DEFAULT NULL
)
RETURNS portfolio_cards AS $$
DECLARE
    v_card portfolio_cards;
BEGIN
    INSERT INTO portfolio_cards (
        customer_id, pokemon_tcg_id, card_name, set_name, set_code,
        card_number, rarity, card_image_small, card_image_large,
        quantity, condition, is_graded, grading_company, grade,
        purchase_price, purchase_date, notes,
        latest_price_market, latest_price_market_zar, price_updated_at
    ) VALUES (
        p_customer_id, p_pokemon_tcg_id, p_card_name, p_set_name, p_set_code,
        p_card_number, p_rarity, p_card_image_small, p_card_image_large,
        p_quantity, p_condition, p_is_graded, p_grading_company, p_grade,
        p_purchase_price, p_purchase_date, p_notes,
        p_latest_price_market, p_latest_price_market_zar, NOW()
    )
    ON CONFLICT (customer_id, pokemon_tcg_id, condition, is_graded, grade)
    DO UPDATE SET
        quantity = portfolio_cards.quantity + EXCLUDED.quantity,
        card_name = EXCLUDED.card_name,
        set_name = EXCLUDED.set_name,
        card_image_small = EXCLUDED.card_image_small,
        card_image_large = EXCLUDED.card_image_large,
        latest_price_market = EXCLUDED.latest_price_market,
        latest_price_market_zar = EXCLUDED.latest_price_market_zar,
        price_updated_at = NOW(),
        notes = COALESCE(EXCLUDED.notes, portfolio_cards.notes)
    RETURNING * INTO v_card;

    RETURN v_card;
END;
$$ LANGUAGE plpgsql;
