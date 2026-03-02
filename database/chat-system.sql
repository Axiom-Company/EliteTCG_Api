-- ============================================
-- EliteTCG Chat System Schema
-- Minimal DB footprint: only DMs, pinned msgs,
-- channel config, and moderation state.
-- Public channel messages live in-memory.
-- ============================================

-- ============================================
-- 1. CHAT CHANNELS (config only, ~6 rows for public + DM rows)
-- ============================================

CREATE TABLE IF NOT EXISTS chat_channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100),
    slug VARCHAR(100) UNIQUE,
    description VARCHAR(500),
    icon VARCHAR(100),
    color VARCHAR(7),
    channel_type VARCHAR(10) NOT NULL DEFAULT 'public'
        CHECK (channel_type IN ('public', 'dm')),
    is_read_only BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    display_order INTEGER DEFAULT 0,
    member_count INTEGER DEFAULT 0,
    created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_channels_type ON chat_channels(channel_type);
CREATE INDEX IF NOT EXISTS idx_chat_channels_active ON chat_channels(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_chat_channels_order ON chat_channels(display_order);

-- ============================================
-- 2. CHAT MEMBERS (membership + moderation)
-- ============================================

CREATE TABLE IF NOT EXISTS chat_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    role VARCHAR(20) DEFAULT 'member'
        CHECK (role IN ('member', 'moderator', 'admin')),
    is_muted BOOLEAN DEFAULT false,
    muted_until TIMESTAMPTZ,
    is_banned BOOLEAN DEFAULT false,
    banned_at TIMESTAMPTZ,
    banned_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
    ban_reason VARCHAR(500),
    last_read_at TIMESTAMPTZ DEFAULT NOW(),
    notifications_enabled BOOLEAN DEFAULT true,
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_members_channel ON chat_members(channel_id);
CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);

-- ============================================
-- 3. CHAT DM MESSAGES (only DM conversations persisted)
-- ============================================

CREATE TABLE IF NOT EXISTS chat_dm_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    content TEXT NOT NULL CHECK (char_length(content) <= 2000),
    image_url VARCHAR(500),
    image_filename VARCHAR(255),
    reply_to_id UUID REFERENCES chat_dm_messages(id) ON DELETE SET NULL,
    is_edited BOOLEAN DEFAULT false,
    edited_at TIMESTAMPTZ,
    is_deleted BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_dm_messages_channel_time
    ON chat_dm_messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_dm_messages_user
    ON chat_dm_messages(user_id);

-- ============================================
-- 4. CHAT PINNED MESSAGES (saved from public channels)
-- ============================================

CREATE TABLE IF NOT EXISTS chat_pinned_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_slug VARCHAR(100) NOT NULL,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    pinned_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
    original_author_name VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL,
    pinned_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_pinned_channel
    ON chat_pinned_messages(channel_slug);

-- ============================================
-- TRIGGERS
-- ============================================

-- Auto-update updated_at on channels
CREATE OR REPLACE FUNCTION update_chat_channels_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_chat_channels_updated_at ON chat_channels;
CREATE TRIGGER trigger_chat_channels_updated_at
    BEFORE UPDATE ON chat_channels
    FOR EACH ROW EXECUTE FUNCTION update_chat_channels_updated_at();

-- Auto-update member_count on join/leave
CREATE OR REPLACE FUNCTION update_chat_member_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE chat_channels SET member_count = member_count + 1
        WHERE id = NEW.channel_id;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE chat_channels SET member_count = GREATEST(member_count - 1, 0)
        WHERE id = OLD.channel_id;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_chat_member_count ON chat_members;
CREATE TRIGGER trigger_chat_member_count
    AFTER INSERT OR DELETE ON chat_members
    FOR EACH ROW EXECUTE FUNCTION update_chat_member_count();

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================

ALTER TABLE chat_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_dm_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_pinned_messages ENABLE ROW LEVEL SECURITY;

-- Service role (API server) gets full access
CREATE POLICY "service_role_chat_channels" ON chat_channels
    FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_chat_members" ON chat_members
    FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_chat_dm_messages" ON chat_dm_messages
    FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_chat_pinned_messages" ON chat_pinned_messages
    FOR ALL USING (auth.role() = 'service_role');

-- Public channels visible to all authenticated
CREATE POLICY "public_channels_visible" ON chat_channels
    FOR SELECT USING (channel_type = 'public' AND is_active = true);

-- DM channels visible to members only
CREATE POLICY "dm_channels_visible_to_members" ON chat_channels
    FOR SELECT USING (
        channel_type = 'dm' AND
        id IN (SELECT channel_id FROM chat_members WHERE user_id = auth.uid())
    );

-- Members visible to fellow channel members
CREATE POLICY "members_visible_to_channel_members" ON chat_members
    FOR SELECT USING (
        channel_id IN (SELECT channel_id FROM chat_members WHERE user_id = auth.uid())
    );

-- DM messages visible to channel members
CREATE POLICY "dm_messages_visible_to_members" ON chat_dm_messages
    FOR SELECT USING (
        channel_id IN (SELECT channel_id FROM chat_members WHERE user_id = auth.uid())
    );

-- Users can send DM messages
CREATE POLICY "users_can_send_dm" ON chat_dm_messages
    FOR INSERT WITH CHECK (user_id = auth.uid());

-- Users can edit own DM messages
CREATE POLICY "users_can_edit_own_dm" ON chat_dm_messages
    FOR UPDATE USING (user_id = auth.uid());

-- Pinned messages visible to all authenticated
CREATE POLICY "pinned_visible_to_authenticated" ON chat_pinned_messages
    FOR SELECT USING (auth.role() = 'authenticated');

-- ============================================
-- DM CLEANUP: purge DMs older than 180 days
-- ============================================

CREATE OR REPLACE FUNCTION purge_old_dm_messages(retention_days INTEGER DEFAULT 180)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM chat_dm_messages
    WHERE created_at < NOW() - (retention_days || ' days')::INTERVAL
      AND is_deleted = false;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- SEED: Default public channels
-- ============================================

INSERT INTO chat_channels (name, slug, description, icon, color, channel_type, display_order)
VALUES
    ('General', 'general', 'General chat for the EliteTCG community', 'message-circle', '#3B82F6', 'public', 1),
    ('Trading', 'trading', 'Looking to buy, sell, or trade? Chat here', 'repeat', '#10B981', 'public', 2),
    ('Pack Openings', 'pack-openings', 'Share your pulls and opening excitement live', 'sparkles', '#F59E0B', 'public', 3),
    ('Price Discussion', 'price-discussion', 'Discuss card values and market trends', 'trending-up', '#8B5CF6', 'public', 4),
    ('Deck Building', 'deck-building', 'Competitive and casual deck strategy chat', 'layers', '#EC4899', 'public', 5),
    ('SA Collectors', 'sa-collectors', 'South African Pokemon TCG collectors chat', 'map-pin', '#006B3F', 'public', 6)
ON CONFLICT (slug) DO NOTHING;
