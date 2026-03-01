-- ============================================
-- EliteTCG Marketplace v4 -- Consolidated Schema
-- Run AFTER schema.sql (base tables).
-- ============================================

-- ============================================
-- SUPABASE STORAGE BUCKETS
-- ============================================

-- Storage buckets (run via Supabase Dashboard or API)
-- INSERT INTO storage.buckets (id, name, public) VALUES ('images', 'images', true);

-- ============================================
-- ENUMS (safe to re-run — skips if already exists)
-- ============================================

DO $$ BEGIN CREATE TYPE card_condition AS ENUM ('mint', 'near_mint', 'excellent', 'good', 'played', 'poor'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE listing_status AS ENUM ('active', 'sold', 'paused', 'deleted'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE application_status AS ENUM ('pending', 'approved', 'rejected'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE marketplace_order_status AS ENUM ('pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE payment_status AS ENUM ('pending', 'completed', 'failed', 'refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE payout_status AS ENUM ('pending', 'processing', 'completed', 'failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================
-- MODIFY EXISTING CUSTOMERS TABLE
-- ============================================

ALTER TABLE customers ADD COLUMN IF NOT EXISTS first_name VARCHAR(100);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_name VARCHAR(100);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS avatar_url VARCHAR(500);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_seller BOOLEAN DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS seller_verified_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

-- ============================================
-- TABLES
-- ============================================

-- Seller Profiles (includes verification columns)
CREATE TABLE IF NOT EXISTS seller_profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

    -- Display info
    display_name VARCHAR(100) NOT NULL,
    bio TEXT,
    avatar_url VARCHAR(500),

    -- Location
    location_city VARCHAR(100),
    location_province VARCHAR(50),

    -- PayFast credentials (for split payments)
    payfast_merchant_id VARCHAR(100),
    payfast_merchant_key VARCHAR(100),
    payfast_email VARCHAR(255),

    -- Contact preferences
    contact_phone VARCHAR(20),
    contact_whatsapp VARCHAR(20),
    contact_email VARCHAR(255),
    show_phone BOOLEAN DEFAULT true,
    show_whatsapp BOOLEAN DEFAULT true,
    show_email BOOLEAN DEFAULT true,

    -- Stats (denormalized for performance)
    total_listings INTEGER DEFAULT 0,
    active_listings INTEGER DEFAULT 0,
    total_sales INTEGER DEFAULT 0,
    total_revenue DECIMAL(12, 2) DEFAULT 0,
    rating DECIMAL(3, 2) DEFAULT 0,
    review_count INTEGER DEFAULT 0,

    -- Verification
    is_verified BOOLEAN DEFAULT false,
    verified_at TIMESTAMPTZ,
    id_document_url VARCHAR(500),
    selfie_url VARCHAR(500),
    verification_status VARCHAR(20) DEFAULT 'none',

    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(customer_id)
);

-- If seller_profiles already existed, ensure new columns are present
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false;
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS id_document_url VARCHAR(500);
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS selfie_url VARCHAR(500);
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS verification_status VARCHAR(20) DEFAULT 'none';

-- Seller Applications
CREATE TABLE IF NOT EXISTS seller_applications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

    -- Application details
    display_name VARCHAR(100) NOT NULL,
    reason TEXT NOT NULL,
    experience TEXT,

    -- PayFast info (required for payouts)
    payfast_merchant_id VARCHAR(100),
    payfast_email VARCHAR(255) NOT NULL,

    -- Optional verification documents
    id_document_url VARCHAR(500),
    proof_of_address_url VARCHAR(500),

    -- Status
    status application_status DEFAULT 'pending',
    admin_notes TEXT,
    rejection_reason TEXT,
    reviewed_by UUID REFERENCES admin_users(id),
    reviewed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Marketplace Listings (includes reservation and promotion columns)
-- NOTE: The images JSONB column stores Supabase Storage public URLs
-- (e.g. https://<project>.supabase.co/storage/v1/object/public/images/...).
CREATE TABLE IF NOT EXISTS marketplace_listings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    seller_id UUID NOT NULL REFERENCES seller_profiles(id) ON DELETE CASCADE,

    -- Card information
    title VARCHAR(200) NOT NULL,
    description TEXT,
    card_name VARCHAR(200),
    set_name VARCHAR(200),
    card_number VARCHAR(50),

    -- Condition
    condition card_condition NOT NULL,
    language VARCHAR(20) DEFAULT 'English',

    -- Grading (optional)
    is_graded BOOLEAN DEFAULT false,
    grading_company VARCHAR(50),
    grade VARCHAR(20),
    certificate_number VARCHAR(50),

    -- Pricing (ZAR)
    price DECIMAL(10, 2) NOT NULL,
    compare_at_price DECIMAL(10, 2),
    currency VARCHAR(3) DEFAULT 'ZAR',

    -- Quantity
    quantity INTEGER DEFAULT 1,
    sold_quantity INTEGER DEFAULT 0,

    -- Images (JSON array of Supabase Storage public URLs, max 5)
    images JSONB DEFAULT '[]',

    -- Categorization
    category VARCHAR(50) DEFAULT 'singles', -- singles, sealed, accessories

    -- Status
    status listing_status DEFAULT 'active',

    -- Reservation
    reserve_status VARCHAR(20) DEFAULT 'available',
    reserved_by UUID REFERENCES customers(id),
    reserved_at TIMESTAMPTZ,

    -- Promotion
    promotion_tier VARCHAR(20),
    promotion_expires_at TIMESTAMPTZ,

    -- Analytics (denormalized for performance)
    view_count INTEGER DEFAULT 0,
    favorite_count INTEGER DEFAULT 0,

    -- Flags
    is_featured BOOLEAN DEFAULT false,
    is_negotiable BOOLEAN DEFAULT false,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    sold_at TIMESTAMPTZ
);

-- If marketplace_listings already existed, ensure new columns are present
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS reserve_status VARCHAR(20) DEFAULT 'available';
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS reserved_by UUID REFERENCES customers(id);
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ;
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS promotion_tier VARCHAR(20);
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS promotion_expires_at TIMESTAMPTZ;

-- Listing Views (for analytics)
CREATE TABLE IF NOT EXISTS listing_views (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    listing_id UUID NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
    viewer_id UUID REFERENCES customers(id) ON DELETE SET NULL,

    -- Tracking data
    ip_address VARCHAR(45),
    user_agent TEXT,
    referrer VARCHAR(500),

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Marketplace Orders
CREATE TABLE IF NOT EXISTS marketplace_orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_number VARCHAR(50) NOT NULL UNIQUE,

    -- Parties
    listing_id UUID REFERENCES marketplace_listings(id) ON DELETE SET NULL,
    seller_id UUID NOT NULL REFERENCES seller_profiles(id),
    buyer_id UUID REFERENCES customers(id) ON DELETE SET NULL,

    -- Quantities and pricing
    quantity INTEGER NOT NULL,
    unit_price DECIMAL(10, 2) NOT NULL,
    subtotal DECIMAL(10, 2) NOT NULL,

    -- Platform commission (tiered)
    platform_fee DECIMAL(10, 2) NOT NULL,
    platform_fee_percentage DECIMAL(5, 2),

    -- Seller payout
    seller_amount DECIMAL(10, 2) NOT NULL,

    -- Total
    total_amount DECIMAL(10, 2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'ZAR',

    -- Status
    status marketplace_order_status DEFAULT 'pending',
    payment_status payment_status DEFAULT 'pending',

    -- PayFast payment details
    payfast_payment_id VARCHAR(100),
    payfast_pf_payment_id VARCHAR(100),

    -- Buyer info (snapshot at time of order)
    buyer_email VARCHAR(255) NOT NULL,
    buyer_name VARCHAR(200) NOT NULL,
    buyer_phone VARCHAR(20),

    -- Shipping
    shipping_address JSONB,
    tracking_number VARCHAR(100),
    shipping_carrier VARCHAR(50),

    notes TEXT,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    paid_at TIMESTAMPTZ,
    shipped_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ
);

-- Seller Payouts
CREATE TABLE IF NOT EXISTS seller_payouts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    seller_id UUID NOT NULL REFERENCES seller_profiles(id),
    order_id UUID REFERENCES marketplace_orders(id) ON DELETE SET NULL,

    amount DECIMAL(10, 2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'ZAR',

    status payout_status DEFAULT 'pending',

    -- PayFast split payment details
    payfast_split_payment_id VARCHAR(100),

    -- Processing info
    processed_at TIMESTAMPTZ,
    error_message TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Listing Favorites
CREATE TABLE IF NOT EXISTS listing_favorites (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    listing_id UUID NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(customer_id, listing_id)
);

-- Listing Promotions
CREATE TABLE IF NOT EXISTS listing_promotions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    listing_id UUID NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
    seller_id UUID NOT NULL REFERENCES seller_profiles(id),
    tier VARCHAR(20) NOT NULL,
    price_paid DECIMAL(10, 2) NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    payfast_payment_id VARCHAR(100),
    payment_status payment_status DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Marketplace Reviews
CREATE TABLE IF NOT EXISTS marketplace_reviews (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES marketplace_orders(id) ON DELETE CASCADE,
    reviewer_id UUID NOT NULL REFERENCES customers(id),
    seller_id UUID NOT NULL REFERENCES seller_profiles(id),
    listing_id UUID REFERENCES marketplace_listings(id),
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    comment TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(order_id)
);

-- ============================================
-- INDEXES
-- ============================================

-- Seller profiles
CREATE INDEX IF NOT EXISTS idx_seller_profiles_customer_id ON seller_profiles(customer_id);
CREATE INDEX IF NOT EXISTS idx_seller_profiles_is_active ON seller_profiles(is_active);
CREATE INDEX IF NOT EXISTS idx_seller_profiles_rating ON seller_profiles(rating DESC);

-- Seller applications
CREATE INDEX IF NOT EXISTS idx_seller_applications_customer_id ON seller_applications(customer_id);
CREATE INDEX IF NOT EXISTS idx_seller_applications_status ON seller_applications(status);
CREATE INDEX IF NOT EXISTS idx_seller_applications_created_at ON seller_applications(created_at DESC);

-- Marketplace listings
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_seller_id ON marketplace_listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_status ON marketplace_listings(status);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_condition ON marketplace_listings(condition);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_price ON marketplace_listings(price);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_category ON marketplace_listings(category);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_created_at ON marketplace_listings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_view_count ON marketplace_listings(view_count DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_reserve_status ON marketplace_listings(reserve_status);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_promotion_tier ON marketplace_listings(promotion_tier);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_promotion_expires ON marketplace_listings(promotion_expires_at);

-- Full text search on listings
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_title_search ON marketplace_listings USING gin(to_tsvector('english', title));
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_card_name_search ON marketplace_listings USING gin(to_tsvector('english', coalesce(card_name, '')));

-- Listing views
CREATE INDEX IF NOT EXISTS idx_listing_views_listing_id ON listing_views(listing_id);
CREATE INDEX IF NOT EXISTS idx_listing_views_created_at ON listing_views(created_at);
CREATE INDEX IF NOT EXISTS idx_listing_views_ip_listing ON listing_views(ip_address, listing_id);

-- Marketplace orders
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_seller_id ON marketplace_orders(seller_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_buyer_id ON marketplace_orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_listing_id ON marketplace_orders(listing_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_status ON marketplace_orders(status);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_created_at ON marketplace_orders(created_at DESC);

-- Seller payouts
CREATE INDEX IF NOT EXISTS idx_seller_payouts_seller_id ON seller_payouts(seller_id);
CREATE INDEX IF NOT EXISTS idx_seller_payouts_status ON seller_payouts(status);

-- Listing favorites
CREATE INDEX IF NOT EXISTS idx_listing_favorites_customer_id ON listing_favorites(customer_id);
CREATE INDEX IF NOT EXISTS idx_listing_favorites_listing_id ON listing_favorites(listing_id);

-- Listing promotions
CREATE INDEX IF NOT EXISTS idx_listing_promotions_listing_id ON listing_promotions(listing_id);
CREATE INDEX IF NOT EXISTS idx_listing_promotions_expires_at ON listing_promotions(expires_at);
CREATE INDEX IF NOT EXISTS idx_listing_promotions_seller_id ON listing_promotions(seller_id);

-- Marketplace reviews
CREATE INDEX IF NOT EXISTS idx_marketplace_reviews_seller_id ON marketplace_reviews(seller_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_reviews_reviewer_id ON marketplace_reviews(reviewer_id);

-- ============================================
-- FUNCTIONS
-- ============================================

-- Increment listing view count
CREATE OR REPLACE FUNCTION increment_listing_views(listing_uuid UUID)
RETURNS void AS $$
BEGIN
    UPDATE marketplace_listings
    SET view_count = view_count + 1
    WHERE id = listing_uuid;
END;
$$ LANGUAGE plpgsql;

-- Update seller stats after a sale
CREATE OR REPLACE FUNCTION update_seller_stats_on_sale()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.payment_status = 'completed' AND OLD.payment_status != 'completed' THEN
        UPDATE seller_profiles
        SET
            total_sales = total_sales + 1,
            total_revenue = total_revenue + NEW.seller_amount
        WHERE id = NEW.seller_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Update listing quantity after sale
CREATE OR REPLACE FUNCTION update_listing_on_sale()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.payment_status = 'completed' AND OLD.payment_status != 'completed' THEN
        UPDATE marketplace_listings
        SET
            sold_quantity = sold_quantity + NEW.quantity,
            quantity = quantity - NEW.quantity,
            status = CASE
                WHEN quantity - NEW.quantity <= 0 THEN 'sold'::listing_status
                ELSE status
            END,
            sold_at = CASE
                WHEN quantity - NEW.quantity <= 0 THEN NOW()
                ELSE sold_at
            END
        WHERE id = NEW.listing_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Update seller profile listing counts
CREATE OR REPLACE FUNCTION update_seller_listing_counts()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE seller_profiles
    SET
        total_listings = (SELECT COUNT(*) FROM marketplace_listings WHERE seller_id = COALESCE(NEW.seller_id, OLD.seller_id) AND status != 'deleted'),
        active_listings = (SELECT COUNT(*) FROM marketplace_listings WHERE seller_id = COALESCE(NEW.seller_id, OLD.seller_id) AND status = 'active')
    WHERE id = COALESCE(NEW.seller_id, OLD.seller_id);

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Recalculate seller rating on review changes
CREATE OR REPLACE FUNCTION update_seller_rating()
RETURNS TRIGGER AS $$
DECLARE
    target_seller_id UUID;
BEGIN
    target_seller_id := COALESCE(NEW.seller_id, OLD.seller_id);

    UPDATE seller_profiles
    SET rating = COALESCE(
            (SELECT ROUND(AVG(rating)::numeric, 2) FROM marketplace_reviews WHERE seller_id = target_seller_id),
            0
        ),
        review_count = (SELECT COUNT(*) FROM marketplace_reviews WHERE seller_id = target_seller_id)
    WHERE id = target_seller_id;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Reserve listing with row locking (prevents double-purchase)
CREATE OR REPLACE FUNCTION reserve_listing(
    p_listing_id UUID,
    p_buyer_id UUID,
    p_quantity INTEGER DEFAULT 1
)
RETURNS JSONB AS $$
DECLARE
    v_listing marketplace_listings%ROWTYPE;
BEGIN
    SELECT * INTO v_listing
    FROM marketplace_listings
    WHERE id = p_listing_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Listing not found');
    END IF;

    IF v_listing.status != 'active' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Listing is not active');
    END IF;

    IF v_listing.reserve_status = 'reserved' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Listing is already reserved by another buyer');
    END IF;

    IF v_listing.reserve_status = 'sold' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Listing has already been sold');
    END IF;

    IF v_listing.quantity < p_quantity THEN
        RETURN jsonb_build_object('success', false, 'error', 'Insufficient quantity available');
    END IF;

    UPDATE marketplace_listings
    SET reserve_status = 'reserved',
        reserved_by = p_buyer_id,
        reserved_at = NOW()
    WHERE id = p_listing_id;

    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql;

-- Release expired reservations (called by background job)
CREATE OR REPLACE FUNCTION release_expired_reservations()
RETURNS INTEGER AS $$
DECLARE
    v_count INTEGER;
BEGIN
    UPDATE marketplace_listings
    SET reserve_status = 'available',
        reserved_by = NULL,
        reserved_at = NULL
    WHERE reserve_status = 'reserved'
      AND reserved_at < NOW() - INTERVAL '30 minutes';

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- TRIGGERS (drop first to make re-runnable)
-- ============================================

-- Auto-update updated_at timestamps
DROP TRIGGER IF EXISTS update_seller_profiles_updated_at ON seller_profiles;
CREATE TRIGGER update_seller_profiles_updated_at
    BEFORE UPDATE ON seller_profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_seller_applications_updated_at ON seller_applications;
CREATE TRIGGER update_seller_applications_updated_at
    BEFORE UPDATE ON seller_applications
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_marketplace_listings_updated_at ON marketplace_listings;
CREATE TRIGGER update_marketplace_listings_updated_at
    BEFORE UPDATE ON marketplace_listings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_marketplace_orders_updated_at ON marketplace_orders;
CREATE TRIGGER update_marketplace_orders_updated_at
    BEFORE UPDATE ON marketplace_orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_marketplace_reviews_updated_at ON marketplace_reviews;
CREATE TRIGGER update_marketplace_reviews_updated_at
    BEFORE UPDATE ON marketplace_reviews
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Update seller stats when order payment completes
DROP TRIGGER IF EXISTS trigger_update_seller_stats ON marketplace_orders;
CREATE TRIGGER trigger_update_seller_stats
    AFTER UPDATE ON marketplace_orders
    FOR EACH ROW EXECUTE FUNCTION update_seller_stats_on_sale();

-- Update listing quantity when order payment completes
DROP TRIGGER IF EXISTS trigger_update_listing_on_sale ON marketplace_orders;
CREATE TRIGGER trigger_update_listing_on_sale
    AFTER UPDATE ON marketplace_orders
    FOR EACH ROW EXECUTE FUNCTION update_listing_on_sale();

-- Update seller listing counts on listing changes
DROP TRIGGER IF EXISTS trigger_update_seller_listing_counts ON marketplace_listings;
CREATE TRIGGER trigger_update_seller_listing_counts
    AFTER INSERT OR UPDATE OR DELETE ON marketplace_listings
    FOR EACH ROW EXECUTE FUNCTION update_seller_listing_counts();

-- Recalculate seller rating on review changes
DROP TRIGGER IF EXISTS trigger_update_seller_rating ON marketplace_reviews;
CREATE TRIGGER trigger_update_seller_rating
    AFTER INSERT OR UPDATE OR DELETE ON marketplace_reviews
    FOR EACH ROW EXECUTE FUNCTION update_seller_rating();

-- ============================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================

-- Enable RLS on all marketplace tables
ALTER TABLE seller_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_reviews ENABLE ROW LEVEL SECURITY;

-- Seller profiles: Public read, owner write
DROP POLICY IF EXISTS "Seller profiles are viewable by everyone" ON seller_profiles;
CREATE POLICY "Seller profiles are viewable by everyone"
    ON seller_profiles FOR SELECT
    USING (is_active = true);

DROP POLICY IF EXISTS "Users can update own seller profile" ON seller_profiles;
CREATE POLICY "Users can update own seller profile"
    ON seller_profiles FOR UPDATE
    USING (customer_id = auth.uid());

-- Seller applications: Only owner and admins
DROP POLICY IF EXISTS "Users can view own applications" ON seller_applications;
CREATE POLICY "Users can view own applications"
    ON seller_applications FOR SELECT
    USING (customer_id = auth.uid());

DROP POLICY IF EXISTS "Users can create own applications" ON seller_applications;
CREATE POLICY "Users can create own applications"
    ON seller_applications FOR INSERT
    WITH CHECK (customer_id = auth.uid());

-- Marketplace listings: Public read active, owner all
DROP POLICY IF EXISTS "Active listings are viewable by everyone" ON marketplace_listings;
CREATE POLICY "Active listings are viewable by everyone"
    ON marketplace_listings FOR SELECT
    USING (status = 'active');

DROP POLICY IF EXISTS "Sellers can manage own listings" ON marketplace_listings;
CREATE POLICY "Sellers can manage own listings"
    ON marketplace_listings FOR ALL
    USING (seller_id IN (SELECT id FROM seller_profiles WHERE customer_id = auth.uid()));

-- Listing views: Insert only
DROP POLICY IF EXISTS "Anyone can create listing views" ON listing_views;
CREATE POLICY "Anyone can create listing views"
    ON listing_views FOR INSERT
    WITH CHECK (true);

-- Marketplace orders: Buyer and seller can view
DROP POLICY IF EXISTS "Buyers can view own orders" ON marketplace_orders;
CREATE POLICY "Buyers can view own orders"
    ON marketplace_orders FOR SELECT
    USING (buyer_id = auth.uid());

DROP POLICY IF EXISTS "Sellers can view received orders" ON marketplace_orders;
CREATE POLICY "Sellers can view received orders"
    ON marketplace_orders FOR SELECT
    USING (seller_id IN (SELECT id FROM seller_profiles WHERE customer_id = auth.uid()));

-- Listing favorites: Owner only
DROP POLICY IF EXISTS "Users can manage own favorites" ON listing_favorites;
CREATE POLICY "Users can manage own favorites"
    ON listing_favorites FOR ALL
    USING (customer_id = auth.uid());

-- Listing promotions: Public read, seller write
DROP POLICY IF EXISTS "Promotions are viewable by everyone" ON listing_promotions;
CREATE POLICY "Promotions are viewable by everyone"
    ON listing_promotions FOR SELECT
    USING (true);

DROP POLICY IF EXISTS "Sellers can manage own promotions" ON listing_promotions;
CREATE POLICY "Sellers can manage own promotions"
    ON listing_promotions FOR ALL
    USING (seller_id IN (SELECT id FROM seller_profiles WHERE customer_id = auth.uid()));

-- Marketplace reviews: Public read, reviewer create
DROP POLICY IF EXISTS "Reviews are viewable by everyone" ON marketplace_reviews;
CREATE POLICY "Reviews are viewable by everyone"
    ON marketplace_reviews FOR SELECT
    USING (true);

DROP POLICY IF EXISTS "Buyers can create own reviews" ON marketplace_reviews;
CREATE POLICY "Buyers can create own reviews"
    ON marketplace_reviews FOR INSERT
    WITH CHECK (reviewer_id = auth.uid());
