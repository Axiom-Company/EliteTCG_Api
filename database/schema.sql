-- ============================================
-- EliteTCG Database Schema
-- PostgreSQL / Supabase
-- ============================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- ENUMS
-- ============================================

CREATE TYPE product_badge AS ENUM ('new', 'hot', 'sale', 'limited', 'preorder', 'none');
CREATE TYPE product_category AS ENUM ('booster_box', 'etb', 'singles', 'collection', 'accessories', 'supplies');
CREATE TYPE order_status AS ENUM ('pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded');
CREATE TYPE config_type AS ENUM ('string', 'number', 'boolean', 'json');

-- ============================================
-- TABLES
-- ============================================

-- Pokemon Sets
CREATE TABLE sets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    code VARCHAR(10) NOT NULL UNIQUE,
    description TEXT,
    release_date DATE,
    card_count INTEGER DEFAULT 0,
    logo_url VARCHAR(500),
    banner_url VARCHAR(500),
    is_active BOOLEAN DEFAULT true,
    is_new BOOLEAN DEFAULT false,
    display_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Products
CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    short_description VARCHAR(500),

    -- Pricing
    price DECIMAL(10, 2) NOT NULL,
    compare_at_price DECIMAL(10, 2),  -- Original price for sales
    cost DECIMAL(10, 2),               -- Your cost (for profit tracking)

    -- Categorization
    category product_category NOT NULL,
    set_id UUID REFERENCES sets(id) ON DELETE SET NULL,

    -- Identification
    sku VARCHAR(100) UNIQUE,
    barcode VARCHAR(100),

    -- Display
    badge product_badge DEFAULT 'none',
    is_active BOOLEAN DEFAULT true,
    is_featured BOOLEAN DEFAULT false,

    -- Images (JSON array of URLs)
    images JSONB DEFAULT '[]',

    -- SEO
    meta_title VARCHAR(255),
    meta_description VARCHAR(500),

    -- Stats
    rating DECIMAL(2, 1) DEFAULT 0,
    review_count INTEGER DEFAULT 0,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Inventory
CREATE TABLE inventory (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity INTEGER DEFAULT 0,
    reserved_quantity INTEGER DEFAULT 0,  -- Reserved for pending orders
    low_stock_threshold INTEGER DEFAULT 5,
    track_inventory BOOLEAN DEFAULT true,
    allow_backorder BOOLEAN DEFAULT false,
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(product_id)
);

-- Pre-orders
CREATE TABLE preorders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    release_date DATE NOT NULL,
    deposit_amount DECIMAL(10, 2),        -- Optional deposit required
    deposit_percentage INTEGER,            -- Or percentage of price
    max_quantity INTEGER,                  -- Max preorders allowed
    current_quantity INTEGER DEFAULT 0,    -- Current preorder count
    is_active BOOLEAN DEFAULT true,
    notify_customers BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(product_id)
);

-- Site Configuration (for banners, announcements, settings)
CREATE TABLE site_config (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key VARCHAR(100) NOT NULL UNIQUE,
    value TEXT,
    type config_type DEFAULT 'string',
    description VARCHAR(500),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Discount Codes
CREATE TABLE discounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(50) NOT NULL UNIQUE,
    description VARCHAR(255),

    -- Discount value
    discount_type VARCHAR(20) NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
    discount_value DECIMAL(10, 2) NOT NULL,

    -- Constraints
    minimum_order DECIMAL(10, 2),
    maximum_discount DECIMAL(10, 2),
    usage_limit INTEGER,
    usage_count INTEGER DEFAULT 0,
    per_customer_limit INTEGER DEFAULT 1,

    -- Validity
    starts_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT true,

    -- Restrictions (JSON array of product/category IDs)
    product_ids JSONB DEFAULT '[]',
    category_ids JSONB DEFAULT '[]',

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Categories (for additional organization)
CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    icon VARCHAR(100),
    image_url VARCHAR(500),
    parent_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    display_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Admin Users
CREATE TABLE admin_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    role VARCHAR(50) DEFAULT 'admin' CHECK (role IN ('super_admin', 'admin', 'manager', 'staff')),
    is_active BOOLEAN DEFAULT true,
    last_login TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Customers
CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255),
    name VARCHAR(255),
    phone VARCHAR(50),

    -- Address
    address_line1 VARCHAR(255),
    address_line2 VARCHAR(255),
    city VARCHAR(100),
    state VARCHAR(100),
    postal_code VARCHAR(20),
    country VARCHAR(100) DEFAULT 'US',

    -- Marketing
    accepts_marketing BOOLEAN DEFAULT false,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Orders
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_number VARCHAR(50) NOT NULL UNIQUE,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,

    -- Pricing
    subtotal DECIMAL(10, 2) NOT NULL,
    discount_amount DECIMAL(10, 2) DEFAULT 0,
    shipping_amount DECIMAL(10, 2) DEFAULT 0,
    tax_amount DECIMAL(10, 2) DEFAULT 0,
    total DECIMAL(10, 2) NOT NULL,

    -- Discount
    discount_code VARCHAR(50),

    -- Status
    status order_status DEFAULT 'pending',

    -- Shipping
    shipping_address JSONB,
    billing_address JSONB,
    tracking_number VARCHAR(100),
    shipped_at TIMESTAMPTZ,

    -- Payment
    payment_method VARCHAR(50),
    payment_status VARCHAR(50) DEFAULT 'pending',

    notes TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Order Items
CREATE TABLE order_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id) ON DELETE SET NULL,

    -- Snapshot of product at time of order
    product_name VARCHAR(255) NOT NULL,
    product_sku VARCHAR(100),
    product_image VARCHAR(500),

    quantity INTEGER NOT NULL,
    unit_price DECIMAL(10, 2) NOT NULL,
    total_price DECIMAL(10, 2) NOT NULL,

    is_preorder BOOLEAN DEFAULT false,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Wishlist
CREATE TABLE wishlists (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(customer_id, product_id)
);

-- ============================================
-- INDEXES
-- ============================================

CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_products_set_id ON products(set_id);
CREATE INDEX idx_products_is_active ON products(is_active);
CREATE INDEX idx_products_is_featured ON products(is_featured);
CREATE INDEX idx_products_slug ON products(slug);
CREATE INDEX idx_products_created_at ON products(created_at DESC);

CREATE INDEX idx_sets_code ON sets(code);
CREATE INDEX idx_sets_is_active ON sets(is_active);
CREATE INDEX idx_sets_display_order ON sets(display_order);

CREATE INDEX idx_inventory_product_id ON inventory(product_id);
CREATE INDEX idx_inventory_quantity ON inventory(quantity);

CREATE INDEX idx_orders_customer_id ON orders(customer_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at DESC);

CREATE INDEX idx_site_config_key ON site_config(key);

-- ============================================
-- TRIGGERS
-- ============================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_products_updated_at
    BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_sets_updated_at
    BEFORE UPDATE ON sets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_site_config_updated_at
    BEFORE UPDATE ON site_config
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_customers_updated_at
    BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_orders_updated_at
    BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- INITIAL DATA
-- ============================================

-- Default site config
INSERT INTO site_config (key, value, type, description, is_active) VALUES
('announcement_bar_text', 'Free shipping on orders over $50!', 'string', 'Text shown in the announcement bar', true),
('announcement_bar_enabled', 'true', 'boolean', 'Show/hide the announcement bar', true),
('announcement_bar_bg_color', '#E3350D', 'string', 'Background color of announcement bar', true),
('announcement_bar_text_color', '#FFFFFF', 'string', 'Text color of announcement bar', true),
('announcement_bar_link', '/shop', 'string', 'Link when clicking announcement bar', true),
('free_shipping_threshold', '50', 'number', 'Order amount for free shipping', true),
('low_stock_threshold', '5', 'number', 'Default low stock warning threshold', true),
('featured_sets_count', '8', 'number', 'Number of sets to show on homepage', true),
('featured_products_count', '8', 'number', 'Number of featured products on homepage', true),
('preorder_deposit_percentage', '20', 'number', 'Default preorder deposit percentage', true);

-- Sample Pokemon Sets
INSERT INTO sets (name, code, card_count, release_date, is_active, is_new, display_order) VALUES
('Prismatic Evolutions', 'PRE', 184, '2025-01-17', true, true, 1),
('Surging Sparks', 'SSP', 252, '2024-11-08', true, true, 2),
('Stellar Crown', 'SCR', 175, '2024-09-13', true, false, 3),
('Shrouded Fable', 'SFA', 99, '2024-08-02', true, false, 4),
('Twilight Masquerade', 'TWM', 226, '2024-05-24', true, false, 5),
('Temporal Forces', 'TEF', 218, '2024-03-22', true, false, 6),
('Paldean Fates', 'PAF', 245, '2024-01-26', true, false, 7),
('Paradox Rift', 'PAR', 266, '2023-11-03', true, false, 8);

-- Sample Products
INSERT INTO products (name, slug, description, price, compare_at_price, category, set_id, badge, is_active, is_featured, rating, review_count) VALUES
('Prismatic Evolutions Booster Box', 'prismatic-evolutions-booster-box', 'Factory sealed booster box containing 36 packs', 149.99, 179.99, 'booster_box', (SELECT id FROM sets WHERE code = 'PRE'), 'hot', true, true, 4.9, 128),
('Surging Sparks Elite Trainer Box', 'surging-sparks-etb', 'Elite Trainer Box with exclusive promos and accessories', 49.99, NULL, 'etb', (SELECT id FROM sets WHERE code = 'SSP'), 'new', true, true, 4.8, 64),
('Charizard ex SAR #234', 'charizard-ex-sar-234', 'Special Art Rare Charizard ex from Obsidian Flames', 289.99, NULL, 'singles', NULL, 'none', true, true, 5.0, 42),
('Pikachu VMAX Rainbow #188', 'pikachu-vmax-rainbow-188', 'Rainbow Rare Pikachu VMAX from Vivid Voltage', 159.99, 189.99, 'singles', NULL, 'sale', true, true, 4.7, 89),
('Stellar Crown Booster Bundle', 'stellar-crown-booster-bundle', '6-pack booster bundle with bonus promo', 24.99, NULL, 'booster_box', (SELECT id FROM sets WHERE code = 'SCR'), 'none', true, true, 4.6, 156),
('Ultra Premium Collection Box', 'ultra-premium-collection', 'Premium collection with exclusive gold cards', 119.99, 149.99, 'collection', NULL, 'limited', true, true, 4.9, 73),
('Mewtwo ex Full Art #151', 'mewtwo-ex-full-art-151', 'Full Art Mewtwo ex from Pokemon 151', 79.99, NULL, 'singles', NULL, 'none', true, true, 4.8, 51),
('Temporal Forces Booster Box', 'temporal-forces-booster-box', 'Factory sealed booster box containing 36 packs', 139.99, 159.99, 'booster_box', (SELECT id FROM sets WHERE code = 'TEF'), 'sale', true, true, 4.7, 98);

-- Add inventory for products
INSERT INTO inventory (product_id, quantity, low_stock_threshold)
SELECT id, floor(random() * 50 + 10)::int, 5 FROM products;

-- Sample preorders
INSERT INTO preorders (product_id, release_date, deposit_percentage, max_quantity, is_active)
SELECT id, '2025-03-28', 20, 100, true FROM products WHERE slug = 'prismatic-evolutions-booster-box';

-- Default admin user (password: admin123 - CHANGE IN PRODUCTION!)
-- Password hash for 'admin123' using bcrypt
INSERT INTO admin_users (email, password_hash, name, role) VALUES
('admin@elitetcg.com', '$2b$10$8K1p/a0dL1LXMIgoEDFrwOfMQDf.OS4Do4gSPAYLcJ4GTHX8E1Riy', 'Admin', 'super_admin');
