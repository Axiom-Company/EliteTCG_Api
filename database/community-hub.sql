-- ============================================
-- EliteTCG Community Hub Schema
-- PostgreSQL / Supabase
-- ============================================
-- This migration adds tables for:
-- 1. Pack Opening & Pull Rate Analysis
-- 2. Price Trend Tracking
-- 3. Blog / Content Management
-- 4. Community Product Reviews
-- 5. Discussion Forum (Threads & Comments)
-- 6. Discord Integration
-- ============================================

-- ============================================
-- ENUMS
-- ============================================

CREATE TYPE content_status AS ENUM ('draft', 'published', 'archived');
CREATE TYPE content_type AS ENUM ('article', 'pack_opening', 'guide', 'news');
CREATE TYPE card_rarity AS ENUM (
  'common', 'uncommon', 'rare', 'holo_rare', 'ultra_rare',
  'full_art', 'special_art_rare', 'hyper_rare', 'secret_rare',
  'illustration_rare', 'special_illustration_rare', 'gold'
);
CREATE TYPE vote_type AS ENUM ('upvote', 'downvote');
CREATE TYPE thread_status AS ENUM ('open', 'closed', 'pinned');
CREATE TYPE price_source AS ENUM ('manual', 'store', 'marketplace', 'external');

-- ============================================
-- 1. PACK OPENING & PULL RATE ANALYSIS
-- ============================================

-- Individual pack opening sessions
CREATE TABLE pack_opening_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    set_id UUID REFERENCES sets(id) ON DELETE SET NULL,
    product_id UUID REFERENCES products(id) ON DELETE SET NULL,

    -- Session metadata
    title VARCHAR(255),
    description TEXT,
    packs_opened INTEGER NOT NULL DEFAULT 1,
    product_type VARCHAR(50), -- 'booster_box', 'etb', 'single_pack', 'booster_bundle'

    -- Aggregated stats (denormalized for performance)
    total_cards_pulled INTEGER DEFAULT 0,
    notable_pulls INTEGER DEFAULT 0, -- count of ultra_rare and above

    -- Media
    thumbnail_url VARCHAR(500),

    is_verified BOOLEAN DEFAULT false, -- admin-verified opening
    is_public BOOLEAN DEFAULT true,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Individual cards pulled in a session
CREATE TABLE pull_records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID NOT NULL REFERENCES pack_opening_sessions(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    set_id UUID REFERENCES sets(id) ON DELETE SET NULL,

    -- Card details
    card_name VARCHAR(255) NOT NULL,
    card_number VARCHAR(20), -- e.g., '234/198'
    rarity card_rarity NOT NULL,
    card_image_url VARCHAR(500),

    -- Classification
    is_hit BOOLEAN DEFAULT false, -- notable pull (ultra rare+)
    is_chase_card BOOLEAN DEFAULT false, -- most sought-after card in set
    estimated_value DECIMAL(10, 2),

    pack_number INTEGER, -- which pack in the session (1-36 for booster box)

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Pre-computed pull rate statistics per set (refreshed periodically)
CREATE TABLE pull_rate_stats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    set_id UUID NOT NULL REFERENCES sets(id) ON DELETE CASCADE,

    rarity card_rarity NOT NULL,
    total_pulled INTEGER DEFAULT 0,
    total_packs_sampled INTEGER DEFAULT 0,
    pull_rate_percentage DECIMAL(6, 3) DEFAULT 0, -- e.g., 2.500 = 2.5%

    -- Per-card breakdown stored as JSONB
    -- [{ card_name, card_number, times_pulled, rate_percentage }]
    card_breakdown JSONB DEFAULT '[]',

    sample_size_sessions INTEGER DEFAULT 0, -- how many sessions contributed

    last_calculated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(set_id, rarity)
);

-- ============================================
-- 2. PRICE TREND TRACKING
-- ============================================

-- Tracked cards/products for price history
CREATE TABLE price_tracked_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID REFERENCES products(id) ON DELETE SET NULL,

    -- Card identification (for singles not in products table)
    card_name VARCHAR(255) NOT NULL,
    card_number VARCHAR(20),
    set_id UUID REFERENCES sets(id) ON DELETE SET NULL,
    set_code VARCHAR(10),

    -- Current price snapshot
    current_price DECIMAL(10, 2),
    previous_price DECIMAL(10, 2),
    price_change_percentage DECIMAL(6, 2) DEFAULT 0,
    price_direction VARCHAR(10) DEFAULT 'stable', -- 'up', 'down', 'stable'

    -- 30-day stats
    price_high_30d DECIMAL(10, 2),
    price_low_30d DECIMAL(10, 2),
    price_avg_30d DECIMAL(10, 2),

    -- Metadata
    image_url VARCHAR(500),
    is_active BOOLEAN DEFAULT true,
    is_featured BOOLEAN DEFAULT false,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Historical price data points
CREATE TABLE price_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tracked_item_id UUID NOT NULL REFERENCES price_tracked_items(id) ON DELETE CASCADE,

    price DECIMAL(10, 2) NOT NULL,
    source price_source DEFAULT 'store',
    source_details VARCHAR(255), -- e.g., 'marketplace listing #xyz'

    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 3. BLOG / CONTENT MANAGEMENT
-- ============================================

CREATE TABLE content_posts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    author_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    admin_author_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,

    -- Content
    title VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL UNIQUE,
    excerpt TEXT,
    body TEXT NOT NULL,
    content_type content_type NOT NULL DEFAULT 'article',

    -- Media
    featured_image_url VARCHAR(500),
    gallery_images JSONB DEFAULT '[]',

    -- Categorization
    tags JSONB DEFAULT '[]', -- ['pack-opening', 'prismatic-evolutions', 'guide']
    set_id UUID REFERENCES sets(id) ON DELETE SET NULL,
    related_product_ids JSONB DEFAULT '[]',

    -- Status & visibility
    status content_status DEFAULT 'draft',
    is_featured BOOLEAN DEFAULT false,
    is_pinned BOOLEAN DEFAULT false,
    published_at TIMESTAMPTZ,

    -- Engagement stats (denormalized)
    view_count INTEGER DEFAULT 0,
    like_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,

    -- SEO
    meta_title VARCHAR(255),
    meta_description VARCHAR(500),

    -- Link to pack opening session (for pack_opening type posts)
    opening_session_id UUID REFERENCES pack_opening_sessions(id) ON DELETE SET NULL,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Content likes (for blog posts)
CREATE TABLE content_likes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    post_id UUID NOT NULL REFERENCES content_posts(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(post_id, customer_id)
);

-- Content comments
CREATE TABLE content_comments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    post_id UUID NOT NULL REFERENCES content_posts(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES content_comments(id) ON DELETE CASCADE,

    body TEXT NOT NULL,
    is_edited BOOLEAN DEFAULT false,

    -- Moderation
    is_flagged BOOLEAN DEFAULT false,
    is_hidden BOOLEAN DEFAULT false,

    like_count INTEGER DEFAULT 0,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 4. COMMUNITY PRODUCT REVIEWS
-- ============================================

CREATE TABLE product_reviews (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    set_id UUID REFERENCES sets(id) ON DELETE SET NULL,

    -- Review content
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    title VARCHAR(255),
    body TEXT,

    -- Specific ratings (optional sub-scores)
    value_rating INTEGER CHECK (value_rating >= 1 AND value_rating <= 5),
    pull_rates_rating INTEGER CHECK (pull_rates_rating >= 1 AND pull_rates_rating <= 5),
    quality_rating INTEGER CHECK (quality_rating >= 1 AND quality_rating <= 5),

    -- Media
    images JSONB DEFAULT '[]',

    -- Verification
    is_verified_purchase BOOLEAN DEFAULT false, -- bought from EliteTCG
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,

    -- Moderation
    is_approved BOOLEAN DEFAULT true,
    is_flagged BOOLEAN DEFAULT false,

    -- Engagement
    helpful_count INTEGER DEFAULT 0,
    not_helpful_count INTEGER DEFAULT 0,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(customer_id, product_id)
);

-- Review helpfulness votes
CREATE TABLE review_votes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    review_id UUID NOT NULL REFERENCES product_reviews(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    is_helpful BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(review_id, customer_id)
);

-- ============================================
-- 5. DISCUSSION FORUM
-- ============================================

-- Discussion categories
CREATE TABLE discussion_categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    icon VARCHAR(100),
    color VARCHAR(7), -- hex color
    display_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    thread_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Discussion threads
CREATE TABLE discussion_threads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    category_id UUID NOT NULL REFERENCES discussion_categories(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

    title VARCHAR(255) NOT NULL,
    body TEXT NOT NULL,
    slug VARCHAR(255) NOT NULL UNIQUE,

    -- Tags
    tags JSONB DEFAULT '[]',

    -- Status
    status thread_status DEFAULT 'open',
    is_pinned BOOLEAN DEFAULT false,
    is_locked BOOLEAN DEFAULT false,

    -- Related entities
    set_id UUID REFERENCES sets(id) ON DELETE SET NULL,
    product_id UUID REFERENCES products(id) ON DELETE SET NULL,

    -- Engagement (denormalized)
    reply_count INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    vote_score INTEGER DEFAULT 0,
    last_reply_at TIMESTAMPTZ,
    last_reply_by UUID REFERENCES customers(id) ON DELETE SET NULL,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Thread replies
CREATE TABLE discussion_replies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    thread_id UUID NOT NULL REFERENCES discussion_threads(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES discussion_replies(id) ON DELETE CASCADE,

    body TEXT NOT NULL,
    is_edited BOOLEAN DEFAULT false,

    -- Moderation
    is_flagged BOOLEAN DEFAULT false,
    is_hidden BOOLEAN DEFAULT false,

    -- Best answer
    is_accepted_answer BOOLEAN DEFAULT false,

    -- Engagement
    vote_score INTEGER DEFAULT 0,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Votes on threads and replies
CREATE TABLE discussion_votes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

    thread_id UUID REFERENCES discussion_threads(id) ON DELETE CASCADE,
    reply_id UUID REFERENCES discussion_replies(id) ON DELETE CASCADE,

    vote vote_type NOT NULL,

    created_at TIMESTAMPTZ DEFAULT NOW(),

    -- One vote per entity per user
    UNIQUE(customer_id, thread_id),
    UNIQUE(customer_id, reply_id),

    -- Must vote on either a thread or reply, not both
    CHECK (
        (thread_id IS NOT NULL AND reply_id IS NULL) OR
        (thread_id IS NULL AND reply_id IS NOT NULL)
    )
);

-- ============================================
-- 6. DISCORD LINK (simple invite URL storage)
-- ============================================

CREATE TABLE discord_config (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    guild_id VARCHAR(100), -- server name for display
    webhook_url VARCHAR(500), -- repurposed as invite_url
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- INDEXES
-- ============================================

-- Pack openings
CREATE INDEX idx_pack_sessions_customer ON pack_opening_sessions(customer_id);
CREATE INDEX idx_pack_sessions_set ON pack_opening_sessions(set_id);
CREATE INDEX idx_pack_sessions_created ON pack_opening_sessions(created_at DESC);
CREATE INDEX idx_pack_sessions_public ON pack_opening_sessions(is_public) WHERE is_public = true;

CREATE INDEX idx_pull_records_session ON pull_records(session_id);
CREATE INDEX idx_pull_records_set ON pull_records(set_id);
CREATE INDEX idx_pull_records_rarity ON pull_records(rarity);
CREATE INDEX idx_pull_records_card ON pull_records(card_name);
CREATE INDEX idx_pull_records_hit ON pull_records(is_hit) WHERE is_hit = true;

CREATE INDEX idx_pull_rate_stats_set ON pull_rate_stats(set_id);

-- Price trends
CREATE INDEX idx_price_tracked_set ON price_tracked_items(set_id);
CREATE INDEX idx_price_tracked_active ON price_tracked_items(is_active) WHERE is_active = true;
CREATE INDEX idx_price_tracked_featured ON price_tracked_items(is_featured) WHERE is_featured = true;

CREATE INDEX idx_price_history_item ON price_history(tracked_item_id);
CREATE INDEX idx_price_history_date ON price_history(recorded_at DESC);

-- Content
CREATE INDEX idx_content_posts_slug ON content_posts(slug);
CREATE INDEX idx_content_posts_status ON content_posts(status);
CREATE INDEX idx_content_posts_type ON content_posts(content_type);
CREATE INDEX idx_content_posts_published ON content_posts(published_at DESC) WHERE status = 'published';
CREATE INDEX idx_content_posts_featured ON content_posts(is_featured) WHERE is_featured = true;
CREATE INDEX idx_content_posts_author ON content_posts(author_id);
CREATE INDEX idx_content_posts_set ON content_posts(set_id);

CREATE INDEX idx_content_comments_post ON content_comments(post_id);
CREATE INDEX idx_content_comments_customer ON content_comments(customer_id);

-- Product reviews
CREATE INDEX idx_product_reviews_product ON product_reviews(product_id);
CREATE INDEX idx_product_reviews_customer ON product_reviews(customer_id);
CREATE INDEX idx_product_reviews_rating ON product_reviews(rating);
CREATE INDEX idx_product_reviews_set ON product_reviews(set_id);
CREATE INDEX idx_product_reviews_verified ON product_reviews(is_verified_purchase) WHERE is_verified_purchase = true;

-- Forum
CREATE INDEX idx_discussion_threads_category ON discussion_threads(category_id);
CREATE INDEX idx_discussion_threads_customer ON discussion_threads(customer_id);
CREATE INDEX idx_discussion_threads_slug ON discussion_threads(slug);
CREATE INDEX idx_discussion_threads_status ON discussion_threads(status);
CREATE INDEX idx_discussion_threads_created ON discussion_threads(created_at DESC);
CREATE INDEX idx_discussion_threads_last_reply ON discussion_threads(last_reply_at DESC);
CREATE INDEX idx_discussion_threads_votes ON discussion_threads(vote_score DESC);

CREATE INDEX idx_discussion_replies_thread ON discussion_replies(thread_id);
CREATE INDEX idx_discussion_replies_customer ON discussion_replies(customer_id);

CREATE INDEX idx_discussion_votes_customer ON discussion_votes(customer_id);

-- ============================================
-- TRIGGERS
-- ============================================

CREATE TRIGGER update_pack_sessions_updated_at
    BEFORE UPDATE ON pack_opening_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_pull_rate_stats_updated_at
    BEFORE UPDATE ON pull_rate_stats
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_price_tracked_updated_at
    BEFORE UPDATE ON price_tracked_items
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_content_posts_updated_at
    BEFORE UPDATE ON content_posts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_content_comments_updated_at
    BEFORE UPDATE ON content_comments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_product_reviews_updated_at
    BEFORE UPDATE ON product_reviews
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_discussion_threads_updated_at
    BEFORE UPDATE ON discussion_threads
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_discussion_replies_updated_at
    BEFORE UPDATE ON discussion_replies
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_discord_config_updated_at
    BEFORE UPDATE ON discord_config
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- FUNCTIONS
-- ============================================

-- Recalculate pull rate stats for a set
CREATE OR REPLACE FUNCTION recalculate_pull_rates(target_set_id UUID)
RETURNS VOID AS $$
DECLARE
    total_packs INTEGER;
    total_sessions INTEGER;
    r card_rarity;
BEGIN
    -- Get total packs opened for this set
    SELECT COALESCE(SUM(packs_opened), 0), COUNT(*)
    INTO total_packs, total_sessions
    FROM pack_opening_sessions
    WHERE set_id = target_set_id AND is_public = true;

    IF total_packs = 0 THEN RETURN; END IF;

    -- For each rarity, calculate pull rates
    FOR r IN SELECT unnest(enum_range(NULL::card_rarity))
    LOOP
        INSERT INTO pull_rate_stats (set_id, rarity, total_pulled, total_packs_sampled, pull_rate_percentage, sample_size_sessions, card_breakdown, last_calculated_at)
        SELECT
            target_set_id,
            r,
            COALESCE(COUNT(*), 0),
            total_packs,
            CASE WHEN total_packs > 0
                THEN ROUND((COUNT(*)::DECIMAL / total_packs) * 100, 3)
                ELSE 0
            END,
            total_sessions,
            COALESCE(
                jsonb_agg(
                    jsonb_build_object(
                        'card_name', sub.card_name,
                        'card_number', sub.card_number,
                        'times_pulled', sub.cnt,
                        'rate_percentage', CASE WHEN total_packs > 0
                            THEN ROUND((sub.cnt::DECIMAL / total_packs) * 100, 3)
                            ELSE 0 END
                    )
                ) FILTER (WHERE sub.card_name IS NOT NULL),
                '[]'::jsonb
            ),
            NOW()
        FROM (
            SELECT pr.card_name, pr.card_number, COUNT(*) as cnt
            FROM pull_records pr
            JOIN pack_opening_sessions pos ON pr.session_id = pos.id
            WHERE pr.set_id = target_set_id AND pr.rarity = r AND pos.is_public = true
            GROUP BY pr.card_name, pr.card_number
            ORDER BY cnt DESC
        ) sub
        ON CONFLICT (set_id, rarity)
        DO UPDATE SET
            total_pulled = EXCLUDED.total_pulled,
            total_packs_sampled = EXCLUDED.total_packs_sampled,
            pull_rate_percentage = EXCLUDED.pull_rate_percentage,
            sample_size_sessions = EXCLUDED.sample_size_sessions,
            card_breakdown = EXCLUDED.card_breakdown,
            last_calculated_at = NOW();
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Update thread reply counts
CREATE OR REPLACE FUNCTION update_thread_reply_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE discussion_threads
        SET reply_count = reply_count + 1,
            last_reply_at = NEW.created_at,
            last_reply_by = NEW.customer_id
        WHERE id = NEW.thread_id;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE discussion_threads
        SET reply_count = GREATEST(reply_count - 1, 0)
        WHERE id = OLD.thread_id;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_thread_reply_count
    AFTER INSERT OR DELETE ON discussion_replies
    FOR EACH ROW EXECUTE FUNCTION update_thread_reply_count();

-- Update content post comment count
CREATE OR REPLACE FUNCTION update_post_comment_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE content_posts SET comment_count = comment_count + 1 WHERE id = NEW.post_id;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE content_posts SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = OLD.post_id;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_post_comment_count
    AFTER INSERT OR DELETE ON content_comments
    FOR EACH ROW EXECUTE FUNCTION update_post_comment_count();

-- Update category thread count
CREATE OR REPLACE FUNCTION update_category_thread_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE discussion_categories SET thread_count = thread_count + 1 WHERE id = NEW.category_id;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE discussion_categories SET thread_count = GREATEST(thread_count - 1, 0) WHERE id = OLD.category_id;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_category_thread_count
    AFTER INSERT OR DELETE ON discussion_threads
    FOR EACH ROW EXECUTE FUNCTION update_category_thread_count();

-- ============================================
-- SEED DATA
-- ============================================

-- Default discussion categories
INSERT INTO discussion_categories (name, slug, description, icon, color, display_order) VALUES
('General Discussion', 'general', 'Talk about anything Pokemon TCG related', 'chat', '#3B82F6', 1),
('Pull Rates & Openings', 'pull-rates', 'Share and discuss pack opening results', 'sparkles', '#F59E0B', 2),
('Price Talk', 'price-talk', 'Discuss card values, trends, and market analysis', 'trending-up', '#10B981', 3),
('Deck Building', 'deck-building', 'Share and discuss competitive deck strategies', 'layers', '#8B5CF6', 4),
('Marketplace Chat', 'marketplace-chat', 'Discuss buying, selling, and trading', 'store', '#EF4444', 5),
('SA Pokemon TCG Community', 'sa-community', 'South African Pokemon TCG collector community hub', 'flag', '#006B3F', 6),
('New Releases & Spoilers', 'new-releases', 'Upcoming sets, leaks, and previews', 'zap', '#EC4899', 7),
('Feedback & Suggestions', 'feedback', 'Help us improve EliteTCG', 'message-circle', '#6B7280', 8);
