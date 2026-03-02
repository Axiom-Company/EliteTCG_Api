-- ============================================================
-- Migration 002: Subscription Boxes
-- Monthly curated subscription boxes at R299 / R499 / R999 tiers
-- Run AFTER schema.sql + marketplace-v4.sql
-- Safe to re-run (all statements are idempotent)
-- ============================================================

-- ============================================
-- ENUMS
-- ============================================

DO $$ BEGIN CREATE TYPE subscription_status AS ENUM ('active', 'paused', 'cancelled', 'expired', 'past_due'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE subscription_box_status AS ENUM ('pending', 'curating', 'packed', 'shipped', 'delivered', 'cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE box_item_type AS ENUM ('booster_pack', 'single_card', 'accessory', 'exclusive', 'bonus'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================
-- TABLES
-- ============================================

-- Subscription Tiers (R299, R499, R999)
CREATE TABLE IF NOT EXISTS subscription_tiers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Display
    name VARCHAR(100) NOT NULL,              -- e.g. "Trainer Box", "Gym Leader Box", "Champion Box"
    slug VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    short_description VARCHAR(500),

    -- Pricing (ZAR, monthly)
    price DECIMAL(10, 2) NOT NULL,           -- 299.00, 499.00, 999.00
    compare_at_price DECIMAL(10, 2),         -- Optional strikethrough price

    -- What's included (displayed to customer)
    includes JSONB DEFAULT '[]',             -- e.g. [{"label":"5 Booster Packs","icon":"pack"},{"label":"1 Guaranteed Rare","icon":"star"}]

    -- Value promise
    guaranteed_value DECIMAL(10, 2),         -- Minimum guaranteed value of contents
    pack_count INTEGER DEFAULT 5,            -- Number of booster packs included
    guaranteed_single_min_value DECIMAL(10, 2), -- Min value of the guaranteed single

    -- Images
    image_url VARCHAR(500),
    badge VARCHAR(50),                       -- e.g. "popular", "best_value", "premium"

    -- Config
    max_subscribers INTEGER,                 -- NULL = unlimited
    current_subscribers INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    display_order INTEGER DEFAULT 0,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Customer Subscriptions
CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    subscription_number VARCHAR(50) NOT NULL UNIQUE,

    -- Parties
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    tier_id UUID NOT NULL REFERENCES subscription_tiers(id),

    -- Status
    status subscription_status DEFAULT 'active',

    -- Billing
    monthly_amount DECIMAL(10, 2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'ZAR',

    -- PayFast subscription
    payfast_token VARCHAR(200),              -- PayFast subscription token for recurring billing
    payfast_subscription_id VARCHAR(100),

    -- Cycle tracking
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    next_billing_date TIMESTAMPTZ,
    billing_day INTEGER DEFAULT 1,           -- Day of month for billing (1-28)

    -- Shipping address (snapshot, customer can update)
    shipping_address JSONB,

    -- History
    total_boxes_shipped INTEGER DEFAULT 0,
    total_amount_paid DECIMAL(12, 2) DEFAULT 0,

    -- Lifecycle
    started_at TIMESTAMPTZ DEFAULT NOW(),
    paused_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    cancellation_reason TEXT,
    expires_at TIMESTAMPTZ,                  -- When current paid period ends after cancellation

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Monthly Subscription Boxes (one per subscriber per month)
CREATE TABLE IF NOT EXISTS subscription_boxes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    box_number VARCHAR(50) NOT NULL UNIQUE,

    -- References
    subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id),
    tier_id UUID NOT NULL REFERENCES subscription_tiers(id),

    -- Period
    billing_month DATE NOT NULL,             -- e.g. '2026-03-01' for March 2026

    -- Status & fulfillment
    status subscription_box_status DEFAULT 'pending',

    -- Payment
    amount_charged DECIMAL(10, 2) NOT NULL,
    payment_status payment_status DEFAULT 'pending',
    payfast_payment_id VARCHAR(100),
    paid_at TIMESTAMPTZ,

    -- Contents value
    total_value DECIMAL(10, 2) DEFAULT 0,    -- Actual retail value of contents

    -- Shipping
    shipping_address JSONB,
    tracking_number VARCHAR(100),
    shipping_carrier VARCHAR(50) DEFAULT 'courier_guy',
    shipped_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,

    -- Customer feedback
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    feedback TEXT,

    notes TEXT,                              -- Admin notes

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(subscription_id, billing_month)
);

-- Items inside each subscription box
CREATE TABLE IF NOT EXISTS subscription_box_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    box_id UUID NOT NULL REFERENCES subscription_boxes(id) ON DELETE CASCADE,

    -- Item details
    item_type box_item_type NOT NULL,
    name VARCHAR(255) NOT NULL,
    description VARCHAR(500),

    -- References (optional, links to existing products/sets)
    product_id UUID REFERENCES products(id) ON DELETE SET NULL,
    set_id UUID REFERENCES sets(id) ON DELETE SET NULL,

    -- Value
    quantity INTEGER DEFAULT 1,
    unit_value DECIMAL(10, 2),               -- Retail value per unit
    total_value DECIMAL(10, 2),              -- quantity * unit_value

    -- Display
    image_url VARCHAR(500),

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Subscription Payment History (tracks each monthly charge)
CREATE TABLE IF NOT EXISTS subscription_payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    box_id UUID REFERENCES subscription_boxes(id) ON DELETE SET NULL,

    -- Payment details
    amount DECIMAL(10, 2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'ZAR',
    status payment_status DEFAULT 'pending',

    -- PayFast details
    payfast_payment_id VARCHAR(100),
    payfast_pf_payment_id VARCHAR(100),

    -- Billing period
    billing_month DATE NOT NULL,

    -- Timestamps
    paid_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    failure_reason TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- INDEXES
-- ============================================

-- Subscription tiers
CREATE INDEX IF NOT EXISTS idx_subscription_tiers_is_active ON subscription_tiers(is_active);
CREATE INDEX IF NOT EXISTS idx_subscription_tiers_slug ON subscription_tiers(slug);
CREATE INDEX IF NOT EXISTS idx_subscription_tiers_display_order ON subscription_tiers(display_order);

-- Subscriptions
CREATE INDEX IF NOT EXISTS idx_subscriptions_customer_id ON subscriptions(customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_tier_id ON subscriptions(tier_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_next_billing ON subscriptions(next_billing_date);
CREATE INDEX IF NOT EXISTS idx_subscriptions_payfast_token ON subscriptions(payfast_token);

-- Subscription boxes
CREATE INDEX IF NOT EXISTS idx_subscription_boxes_subscription_id ON subscription_boxes(subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscription_boxes_customer_id ON subscription_boxes(customer_id);
CREATE INDEX IF NOT EXISTS idx_subscription_boxes_tier_id ON subscription_boxes(tier_id);
CREATE INDEX IF NOT EXISTS idx_subscription_boxes_status ON subscription_boxes(status);
CREATE INDEX IF NOT EXISTS idx_subscription_boxes_billing_month ON subscription_boxes(billing_month);
CREATE INDEX IF NOT EXISTS idx_subscription_boxes_payment_status ON subscription_boxes(payment_status);

-- Subscription box items
CREATE INDEX IF NOT EXISTS idx_subscription_box_items_box_id ON subscription_box_items(box_id);
CREATE INDEX IF NOT EXISTS idx_subscription_box_items_item_type ON subscription_box_items(item_type);
CREATE INDEX IF NOT EXISTS idx_subscription_box_items_product_id ON subscription_box_items(product_id);

-- Subscription payments
CREATE INDEX IF NOT EXISTS idx_subscription_payments_subscription_id ON subscription_payments(subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_box_id ON subscription_payments(box_id);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_status ON subscription_payments(status);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_billing_month ON subscription_payments(billing_month);

-- ============================================
-- FUNCTIONS
-- ============================================

-- Update subscriber count on tier when subscriptions change
CREATE OR REPLACE FUNCTION update_tier_subscriber_count()
RETURNS TRIGGER AS $$
BEGIN
    -- Update old tier count (for tier changes or cancellations)
    IF OLD IS NOT NULL AND OLD.tier_id IS NOT NULL THEN
        UPDATE subscription_tiers
        SET current_subscribers = (
            SELECT COUNT(*) FROM subscriptions
            WHERE tier_id = OLD.tier_id AND status = 'active'
        )
        WHERE id = OLD.tier_id;
    END IF;

    -- Update new tier count
    IF NEW IS NOT NULL AND NEW.tier_id IS NOT NULL THEN
        UPDATE subscription_tiers
        SET current_subscribers = (
            SELECT COUNT(*) FROM subscriptions
            WHERE tier_id = NEW.tier_id AND status = 'active'
        )
        WHERE id = NEW.tier_id;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Update subscription stats after box ships
CREATE OR REPLACE FUNCTION update_subscription_on_box_shipped()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'shipped' AND OLD.status != 'shipped' THEN
        UPDATE subscriptions
        SET total_boxes_shipped = total_boxes_shipped + 1
        WHERE id = NEW.subscription_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Update subscription total paid after payment completes
CREATE OR REPLACE FUNCTION update_subscription_on_payment()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'completed' AND (OLD IS NULL OR OLD.status != 'completed') THEN
        UPDATE subscriptions
        SET total_amount_paid = total_amount_paid + NEW.amount
        WHERE id = NEW.subscription_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Calculate total value of box items
CREATE OR REPLACE FUNCTION update_box_total_value()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE subscription_boxes
    SET total_value = (
        SELECT COALESCE(SUM(total_value), 0)
        FROM subscription_box_items
        WHERE box_id = COALESCE(NEW.box_id, OLD.box_id)
    )
    WHERE id = COALESCE(NEW.box_id, OLD.box_id);

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- TRIGGERS
-- ============================================

-- Auto-update timestamps
DROP TRIGGER IF EXISTS update_subscription_tiers_updated_at ON subscription_tiers;
CREATE TRIGGER update_subscription_tiers_updated_at
    BEFORE UPDATE ON subscription_tiers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_subscriptions_updated_at ON subscriptions;
CREATE TRIGGER update_subscriptions_updated_at
    BEFORE UPDATE ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_subscription_boxes_updated_at ON subscription_boxes;
CREATE TRIGGER update_subscription_boxes_updated_at
    BEFORE UPDATE ON subscription_boxes
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Update tier subscriber counts
DROP TRIGGER IF EXISTS trigger_update_tier_subscriber_count ON subscriptions;
CREATE TRIGGER trigger_update_tier_subscriber_count
    AFTER INSERT OR UPDATE OR DELETE ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION update_tier_subscriber_count();

-- Update subscription stats on box shipped
DROP TRIGGER IF EXISTS trigger_update_subscription_on_box_shipped ON subscription_boxes;
CREATE TRIGGER trigger_update_subscription_on_box_shipped
    AFTER UPDATE ON subscription_boxes
    FOR EACH ROW EXECUTE FUNCTION update_subscription_on_box_shipped();

-- Update subscription paid total on payment
DROP TRIGGER IF EXISTS trigger_update_subscription_on_payment ON subscription_payments;
CREATE TRIGGER trigger_update_subscription_on_payment
    AFTER INSERT OR UPDATE ON subscription_payments
    FOR EACH ROW EXECUTE FUNCTION update_subscription_on_payment();

-- Update box total value when items change
DROP TRIGGER IF EXISTS trigger_update_box_total_value ON subscription_box_items;
CREATE TRIGGER trigger_update_box_total_value
    AFTER INSERT OR UPDATE OR DELETE ON subscription_box_items
    FOR EACH ROW EXECUTE FUNCTION update_box_total_value();

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================

ALTER TABLE subscription_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_boxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_box_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_payments ENABLE ROW LEVEL SECURITY;

-- Tiers: public read
DROP POLICY IF EXISTS "Subscription tiers viewable by everyone" ON subscription_tiers;
CREATE POLICY "Subscription tiers viewable by everyone"
    ON subscription_tiers FOR SELECT
    USING (is_active = true);

DROP POLICY IF EXISTS "Service role manages subscription tiers" ON subscription_tiers;
CREATE POLICY "Service role manages subscription tiers"
    ON subscription_tiers FOR ALL
    USING (auth.role() = 'service_role');

-- Subscriptions: owner read, service role all
DROP POLICY IF EXISTS "Customers can view own subscriptions" ON subscriptions;
CREATE POLICY "Customers can view own subscriptions"
    ON subscriptions FOR SELECT
    USING (customer_id = auth.uid());

DROP POLICY IF EXISTS "Service role manages subscriptions" ON subscriptions;
CREATE POLICY "Service role manages subscriptions"
    ON subscriptions FOR ALL
    USING (auth.role() = 'service_role');

-- Boxes: owner read, service role all
DROP POLICY IF EXISTS "Customers can view own boxes" ON subscription_boxes;
CREATE POLICY "Customers can view own boxes"
    ON subscription_boxes FOR SELECT
    USING (customer_id = auth.uid());

DROP POLICY IF EXISTS "Service role manages subscription boxes" ON subscription_boxes;
CREATE POLICY "Service role manages subscription boxes"
    ON subscription_boxes FOR ALL
    USING (auth.role() = 'service_role');

-- Box items: tied to box ownership (via service role for simplicity)
DROP POLICY IF EXISTS "Service role manages box items" ON subscription_box_items;
CREATE POLICY "Service role manages box items"
    ON subscription_box_items FOR ALL
    USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Customers can view own box items" ON subscription_box_items;
CREATE POLICY "Customers can view own box items"
    ON subscription_box_items FOR SELECT
    USING (
        box_id IN (
            SELECT id FROM subscription_boxes WHERE customer_id = auth.uid()
        )
    );

-- Payments: owner read, service role all
DROP POLICY IF EXISTS "Customers can view own payments" ON subscription_payments;
CREATE POLICY "Customers can view own payments"
    ON subscription_payments FOR SELECT
    USING (
        subscription_id IN (
            SELECT id FROM subscriptions WHERE customer_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Service role manages subscription payments" ON subscription_payments;
CREATE POLICY "Service role manages subscription payments"
    ON subscription_payments FOR ALL
    USING (auth.role() = 'service_role');

-- ============================================
-- SEED DATA: Default Subscription Tiers
-- ============================================

INSERT INTO subscription_tiers (name, slug, description, short_description, price, includes, guaranteed_value, pack_count, guaranteed_single_min_value, badge, display_order)
VALUES
(
    'Trainer Box',
    'trainer-box',
    'The perfect entry into monthly Pokemon TCG collecting. Get 5 booster packs from the hottest current set, a guaranteed single worth at least R50, random accessories, and an exclusive Elite TCG sticker.',
    'Great starter box with 5 packs and a guaranteed rare',
    299.00,
    '[{"label":"5 Booster Packs (Current Set)","icon":"pack"},{"label":"1 Guaranteed Single (R50+ value)","icon":"star"},{"label":"Random Accessory (Sleeves or Toploaders)","icon":"shield"},{"label":"Exclusive Elite TCG Sticker","icon":"sparkle"}]',
    400.00,
    5,
    50.00,
    NULL,
    1
),
(
    'Gym Leader Box',
    'gym-leader-box',
    'Level up your collection with 8 booster packs, a guaranteed single worth at least R150, premium accessories including sleeves and a toploader set, and an exclusive Elite TCG pin.',
    'Premium box with 8 packs, high-value single, and accessories',
    499.00,
    '[{"label":"8 Booster Packs (Current Set)","icon":"pack"},{"label":"1 Guaranteed Single (R150+ value)","icon":"star"},{"label":"Premium Sleeves (65ct)","icon":"shield"},{"label":"Toploader Set (25ct)","icon":"layers"},{"label":"Exclusive Elite TCG Pin","icon":"award"}]',
    700.00,
    8,
    150.00,
    'popular',
    2
),
(
    'Champion Box',
    'champion-box',
    'The ultimate monthly subscription for serious collectors. Get 12 booster packs from the hottest set, a guaranteed chase card worth at least R350, premium accessories bundle, an exclusive Elite TCG collector pin, and a bonus surprise item every month.',
    'Ultimate box with 12 packs, chase card, and premium extras',
    999.00,
    '[{"label":"12 Booster Packs (Current Set)","icon":"pack"},{"label":"1 Guaranteed Chase Card (R350+ value)","icon":"crown"},{"label":"Premium Accessories Bundle","icon":"shield"},{"label":"Exclusive Collector Pin","icon":"award"},{"label":"Bonus Surprise Item","icon":"gift"},{"label":"Elite TCG Collector Sticker","icon":"sparkle"}]',
    1400.00,
    12,
    350.00,
    'best_value',
    3
)
ON CONFLICT (slug) DO NOTHING;
