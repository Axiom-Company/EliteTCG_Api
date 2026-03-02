import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import path from 'path';
import { authenticateCustomer, optionalCustomerAuth, authenticateSupabaseUser, requireRole } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';
import { chatBuffer } from '../chat/chatBuffer.js';
import { getOnlineUsers } from '../chat/chatSocket.js';

const router = Router();

const BUCKET = 'images';
const DM_MESSAGE_LIMIT = 50;
const DM_CONTENT_MAX = 2000;
const DM_UPLOAD_MAX_BYTES = 2 * 1024 * 1024; // 2MB

// ============================================
// VALIDATION SCHEMAS
// ============================================

const createChannelSchema = z.object({
  name: z.string().min(1, 'Channel name is required').max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with hyphens').optional(),
  description: z.string().max(500).optional(),
  icon: z.string().max(50).optional(),
  color: z.string().max(20).regex(/^#[0-9a-fA-F]{3,8}$/, 'Color must be a valid hex color').optional(),
});

const updateChannelSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  icon: z.string().max(50).optional(),
  color: z.string().max(20).regex(/^#[0-9a-fA-F]{3,8}$/, 'Color must be a valid hex color').optional(),
  is_read_only: z.boolean().optional(),
  is_active: z.boolean().optional(),
  display_order: z.number().int().min(0).optional(),
});

const createDmSchema = z.object({
  recipient_id: z.string().uuid('Invalid recipient ID'),
});

const dmMessageSchema = z.object({
  content: z.string().min(1, 'Message cannot be empty').max(DM_CONTENT_MAX, `Message cannot exceed ${DM_CONTENT_MAX} characters`),
});

const editDmMessageSchema = z.object({
  content: z.string().min(1, 'Message cannot be empty').max(DM_CONTENT_MAX, `Message cannot exceed ${DM_CONTENT_MAX} characters`),
});

const muteUserSchema = z.object({
  duration_minutes: z.number().int().min(1).max(525600).optional().default(60), // max 1 year
});

const banUserSchema = z.object({
  reason: z.string().min(1).max(500).optional(),
});

// ============================================
// MULTER CONFIG FOR DM IMAGE UPLOADS
// ============================================

const dmFileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed (jpeg, jpg, png, gif, webp)'), false);
  }
};

const dmUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: dmFileFilter,
  limits: { fileSize: DM_UPLOAD_MAX_BYTES },
});

// ============================================
// HELPERS
// ============================================

function generateSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 100);
}

async function getProfileInfo(userId) {
  try {
    const { data } = await supabaseAdmin
      .from('profiles')
      .select('id, first_name, last_name, avatar_url')
      .eq('id', userId)
      .single();

    if (data) {
      return {
        id: data.id,
        name: `${data.first_name || ''} ${data.last_name ? data.last_name.charAt(0) + '.' : ''}`.trim() || 'Anonymous',
        avatar_url: data.avatar_url || null,
      };
    }
    return { id: userId, name: 'Anonymous', avatar_url: null };
  } catch {
    return { id: userId, name: 'Anonymous', avatar_url: null };
  }
}

async function getChannelBySlug(slug) {
  const { data, error } = await supabaseAdmin
    .from('chat_channels')
    .select('*')
    .eq('slug', slug)
    .single();

  if (error || !data) return null;
  return data;
}

async function verifyDmMembership(channelId, userId) {
  const { data, error } = await supabaseAdmin
    .from('chat_members')
    .select('id')
    .eq('channel_id', channelId)
    .eq('user_id', userId)
    .single();

  return !error && !!data;
}

async function uploadToSupabase(buffer, mimetype, originalname, folder = 'chat') {
  const ext = path.extname(originalname);
  const filename = `${folder}/${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;

  const { error } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(filename, buffer, { contentType: mimetype, upsert: false });

  if (error) throw error;

  const { data: urlData } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(filename);
  return { url: urlData.publicUrl, filename };
}

// ============================================
// CHANNEL CONFIG (DB-backed)
// ============================================

// GET /channels - list public channels
router.get('/channels', optionalCustomerAuth, async (req, res) => {
  try {
    const { data: channels, error } = await supabaseAdmin
      .from('chat_channels')
      .select('*')
      .eq('channel_type', 'public')
      .eq('is_active', true)
      .order('display_order', { ascending: true });

    if (error) {
      console.error('List channels error:', error);
      return res.status(500).json({ error: 'Failed to fetch channels' });
    }

    res.json({ channels: channels || [] });
  } catch (error) {
    console.error('List channels error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /channels - create channel (admin only)
router.post('/channels', authenticateSupabaseUser, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const validation = createChannelSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    const { name, slug, description, icon, color } = validation.data;
    const channelSlug = slug || generateSlug(name);

    // Check for slug collision
    const { data: existing } = await supabaseAdmin
      .from('chat_channels')
      .select('id')
      .eq('slug', channelSlug)
      .single();

    if (existing) {
      return res.status(409).json({ error: 'A channel with this slug already exists' });
    }

    const { data: channel, error } = await supabaseAdmin
      .from('chat_channels')
      .insert({
        name,
        slug: channelSlug,
        description: description || null,
        icon: icon || null,
        color: color || null,
        channel_type: 'public',
        is_active: true,
        created_by: req.user.id,
      })
      .select()
      .single();

    if (error) {
      console.error('Create channel error:', error);
      return res.status(500).json({ error: 'Failed to create channel' });
    }

    res.status(201).json({ message: 'Channel created', channel });
  } catch (error) {
    console.error('Create channel error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /channels/:slug - update channel (admin only)
router.put('/channels/:slug', authenticateSupabaseUser, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { slug } = req.params;
    const validation = updateChannelSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    const updateData = {};
    const parsed = validation.data;
    if (parsed.name !== undefined) updateData.name = parsed.name;
    if (parsed.description !== undefined) updateData.description = parsed.description;
    if (parsed.icon !== undefined) updateData.icon = parsed.icon;
    if (parsed.color !== undefined) updateData.color = parsed.color;
    if (parsed.is_read_only !== undefined) updateData.is_read_only = parsed.is_read_only;
    if (parsed.is_active !== undefined) updateData.is_active = parsed.is_active;
    if (parsed.display_order !== undefined) updateData.display_order = parsed.display_order;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const { data: channel, error } = await supabaseAdmin
      .from('chat_channels')
      .update(updateData)
      .eq('slug', slug)
      .select()
      .single();

    if (error) {
      console.error('Update channel error:', error);
      return res.status(500).json({ error: 'Failed to update channel' });
    }

    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    res.json({ message: 'Channel updated', channel });
  } catch (error) {
    console.error('Update channel error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /channels/:slug - delete channel (admin only)
router.delete('/channels/:slug', authenticateSupabaseUser, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { slug } = req.params;

    const { data: channel, error: fetchError } = await supabaseAdmin
      .from('chat_channels')
      .select('id')
      .eq('slug', slug)
      .single();

    if (fetchError || !channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const { error } = await supabaseAdmin
      .from('chat_channels')
      .delete()
      .eq('slug', slug);

    if (error) {
      console.error('Delete channel error:', error);
      return res.status(500).json({ error: 'Failed to delete channel' });
    }

    res.json({ message: 'Channel deleted' });
  } catch (error) {
    console.error('Delete channel error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /channels/:slug/pinned - get pinned messages
router.get('/channels/:slug/pinned', authenticateCustomer, async (req, res) => {
  try {
    const { slug } = req.params;

    const channel = await getChannelBySlug(slug);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const { data: pinned, error } = await supabaseAdmin
      .from('chat_pinned_messages')
      .select('*')
      .eq('channel_slug', slug)
      .order('pinned_at', { ascending: false });

    if (error) {
      console.error('Get pinned messages error:', error);
      return res.status(500).json({ error: 'Failed to fetch pinned messages' });
    }

    res.json({ pinned: pinned || [] });
  } catch (error) {
    console.error('Get pinned messages error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /channels/:slug/members - get online members for public channel
router.get('/channels/:slug/members', authenticateCustomer, async (req, res) => {
  try {
    const { slug } = req.params;

    const channel = await getChannelBySlug(slug);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const onlineUsers = getOnlineUsers();
    const members = [];

    for (const [userId, userData] of onlineUsers) {
      members.push({
        id: userId,
        name: userData.name || userData.authorName || 'Anonymous',
        avatar_url: userData.avatar_url || userData.avatarUrl || null,
      });
    }

    res.json({ members, count: members.length });
  } catch (error) {
    console.error('Get channel members error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// DM ENDPOINTS
// ============================================

// POST /dm - create or get existing DM channel
router.post('/dm', authenticateCustomer, async (req, res) => {
  try {
    const validation = createDmSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    const { recipient_id } = validation.data;
    const senderId = req.customer.id;

    if (recipient_id === senderId) {
      return res.status(400).json({ error: 'Cannot create a DM with yourself' });
    }

    // Verify the recipient exists
    const { data: recipientProfile } = await supabaseAdmin
      .from('profiles')
      .select('id, first_name, last_name, avatar_url')
      .eq('id', recipient_id)
      .single();

    if (!recipientProfile) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    // Check if a DM channel already exists between these two users.
    // Find channels where the sender is a member...
    const { data: senderChannels } = await supabaseAdmin
      .from('chat_members')
      .select('channel_id')
      .eq('user_id', senderId);

    let existingChannelId = null;

    if (senderChannels && senderChannels.length > 0) {
      const channelIds = senderChannels.map(m => m.channel_id);

      // ...then check which of those channels also have the recipient as a member
      // and are of type 'dm'
      for (const cId of channelIds) {
        const { data: channelData } = await supabaseAdmin
          .from('chat_channels')
          .select('id, channel_type')
          .eq('id', cId)
          .eq('channel_type', 'dm')
          .single();

        if (!channelData) continue;

        const { data: recipientMember } = await supabaseAdmin
          .from('chat_members')
          .select('id')
          .eq('channel_id', cId)
          .eq('user_id', recipient_id)
          .single();

        if (recipientMember) {
          existingChannelId = cId;
          break;
        }
      }
    }

    if (existingChannelId) {
      const { data: existingChannel } = await supabaseAdmin
        .from('chat_channels')
        .select('*')
        .eq('id', existingChannelId)
        .single();

      const recipientInfo = await getProfileInfo(recipient_id);

      return res.json({
        channel: existingChannel,
        recipient: recipientInfo,
        created: false,
      });
    }

    // Create new DM channel
    const { data: newChannel, error: channelError } = await supabaseAdmin
      .from('chat_channels')
      .insert({
        name: `dm-${senderId}-${recipient_id}`,
        slug: `dm-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
        channel_type: 'dm',
        is_active: true,
      })
      .select()
      .single();

    if (channelError) {
      console.error('Create DM channel error:', channelError);
      return res.status(500).json({ error: 'Failed to create DM channel' });
    }

    // Add both users as members
    const { error: memberError } = await supabaseAdmin
      .from('chat_members')
      .insert([
        { channel_id: newChannel.id, user_id: senderId },
        { channel_id: newChannel.id, user_id: recipient_id },
      ]);

    if (memberError) {
      console.error('Add DM members error:', memberError);
      // Attempt cleanup
      await supabaseAdmin.from('chat_channels').delete().eq('id', newChannel.id);
      return res.status(500).json({ error: 'Failed to create DM channel' });
    }

    const recipientInfo = await getProfileInfo(recipient_id);

    res.status(201).json({
      channel: newChannel,
      recipient: recipientInfo,
      created: true,
    });
  } catch (error) {
    console.error('Create DM error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /dm - list user's DM channels
router.get('/dm', authenticateCustomer, async (req, res) => {
  try {
    const userId = req.customer.id;

    // Get all channels the user is a member of
    const { data: memberships, error: memberError } = await supabaseAdmin
      .from('chat_members')
      .select('channel_id')
      .eq('user_id', userId);

    if (memberError) {
      console.error('List DMs member query error:', memberError);
      return res.status(500).json({ error: 'Failed to fetch DMs' });
    }

    if (!memberships || memberships.length === 0) {
      return res.json({ dms: [] });
    }

    const channelIds = memberships.map(m => m.channel_id);

    // Filter to DM-type channels only
    const { data: dmChannels, error: channelError } = await supabaseAdmin
      .from('chat_channels')
      .select('*')
      .in('id', channelIds)
      .eq('channel_type', 'dm');

    if (channelError) {
      console.error('List DMs channel query error:', channelError);
      return res.status(500).json({ error: 'Failed to fetch DMs' });
    }

    if (!dmChannels || dmChannels.length === 0) {
      return res.json({ dms: [] });
    }

    // For each DM channel, get the other member's profile and last message
    const dms = [];

    for (const channel of dmChannels) {
      // Get the other member
      const { data: members } = await supabaseAdmin
        .from('chat_members')
        .select('user_id')
        .eq('channel_id', channel.id)
        .neq('user_id', userId);

      const otherUserId = members && members.length > 0 ? members[0].user_id : null;
      const otherProfile = otherUserId ? await getProfileInfo(otherUserId) : null;

      // Get the last message
      const { data: lastMessages } = await supabaseAdmin
        .from('chat_dm_messages')
        .select('id, content, author_id, created_at, is_deleted')
        .eq('channel_id', channel.id)
        .order('created_at', { ascending: false })
        .limit(1);

      const lastMessage = lastMessages && lastMessages.length > 0 ? lastMessages[0] : null;

      dms.push({
        channel,
        recipient: otherProfile,
        last_message: lastMessage
          ? {
              id: lastMessage.id,
              content: lastMessage.is_deleted ? '' : lastMessage.content,
              author_id: lastMessage.author_id,
              created_at: lastMessage.created_at,
              is_deleted: lastMessage.is_deleted,
            }
          : null,
      });
    }

    // Sort by last message time (most recent first), channels with no messages go to the end
    dms.sort((a, b) => {
      const aTime = a.last_message?.created_at || a.channel.created_at;
      const bTime = b.last_message?.created_at || b.channel.created_at;
      return new Date(bTime) - new Date(aTime);
    });

    res.json({ dms });
  } catch (error) {
    console.error('List DMs error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /dm/:channelId/messages - paginated DM message history
router.get('/dm/:channelId/messages', authenticateCustomer, async (req, res) => {
  try {
    const { channelId } = req.params;
    const userId = req.customer.id;

    // Verify membership
    const isMember = await verifyDmMembership(channelId, userId);
    if (!isMember) {
      return res.status(403).json({ error: 'Not a member of this DM channel' });
    }

    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || DM_MESSAGE_LIMIT));
    const before = req.query.before; // ISO timestamp cursor

    let query = supabaseAdmin
      .from('chat_dm_messages')
      .select('*')
      .eq('channel_id', channelId)
      .order('created_at', { ascending: false })
      .limit(limit + 1); // fetch one extra to determine has_more

    if (before) {
      query = query.lt('created_at', before);
    }

    const { data: messages, error } = await query;

    if (error) {
      console.error('Get DM messages error:', error);
      return res.status(500).json({ error: 'Failed to fetch messages' });
    }

    const hasMore = messages && messages.length > limit;
    const result = (messages || []).slice(0, limit);

    // Enrich with author profile info
    const authorCache = new Map();
    const enriched = [];

    for (const msg of result) {
      if (!authorCache.has(msg.author_id)) {
        authorCache.set(msg.author_id, await getProfileInfo(msg.author_id));
      }
      const author = authorCache.get(msg.author_id);

      enriched.push({
        ...msg,
        content: msg.is_deleted ? '' : msg.content,
        author_name: author.name,
        author_avatar_url: author.avatar_url,
      });
    }

    res.json({
      messages: enriched,
      has_more: hasMore,
    });
  } catch (error) {
    console.error('Get DM messages error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /dm/:channelId/messages - send a DM message
router.post('/dm/:channelId/messages', authenticateCustomer, async (req, res) => {
  try {
    const { channelId } = req.params;
    const userId = req.customer.id;

    // Verify membership
    const isMember = await verifyDmMembership(channelId, userId);
    if (!isMember) {
      return res.status(403).json({ error: 'Not a member of this DM channel' });
    }

    const validation = dmMessageSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    const { content } = validation.data;

    const { data: message, error } = await supabaseAdmin
      .from('chat_dm_messages')
      .insert({
        channel_id: channelId,
        author_id: userId,
        content,
      })
      .select()
      .single();

    if (error) {
      console.error('Send DM error:', error);
      return res.status(500).json({ error: 'Failed to send message' });
    }

    const authorInfo = await getProfileInfo(userId);

    res.status(201).json({
      message: {
        ...message,
        author_name: authorInfo.name,
        author_avatar_url: authorInfo.avatar_url,
      },
    });
  } catch (error) {
    console.error('Send DM error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /dm/:channelId/messages/:msgId - edit own DM message
router.put('/dm/:channelId/messages/:msgId', authenticateCustomer, async (req, res) => {
  try {
    const { channelId, msgId } = req.params;
    const userId = req.customer.id;

    // Verify membership
    const isMember = await verifyDmMembership(channelId, userId);
    if (!isMember) {
      return res.status(403).json({ error: 'Not a member of this DM channel' });
    }

    const validation = editDmMessageSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    // Verify the message exists and is owned by this user
    const { data: existing } = await supabaseAdmin
      .from('chat_dm_messages')
      .select('id, author_id, is_deleted')
      .eq('id', msgId)
      .eq('channel_id', channelId)
      .single();

    if (!existing) {
      return res.status(404).json({ error: 'Message not found' });
    }

    if (existing.author_id !== userId) {
      return res.status(403).json({ error: 'Not authorized to edit this message' });
    }

    if (existing.is_deleted) {
      return res.status(400).json({ error: 'Cannot edit a deleted message' });
    }

    const { content } = validation.data;

    const { data: updated, error } = await supabaseAdmin
      .from('chat_dm_messages')
      .update({
        content,
        is_edited: true,
        edited_at: new Date().toISOString(),
      })
      .eq('id', msgId)
      .select()
      .single();

    if (error) {
      console.error('Edit DM error:', error);
      return res.status(500).json({ error: 'Failed to edit message' });
    }

    res.json({ message: updated });
  } catch (error) {
    console.error('Edit DM error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /dm/:channelId/messages/:msgId - soft delete DM message
router.delete('/dm/:channelId/messages/:msgId', authenticateCustomer, async (req, res) => {
  try {
    const { channelId, msgId } = req.params;
    const userId = req.customer.id;

    // Verify membership
    const isMember = await verifyDmMembership(channelId, userId);
    if (!isMember) {
      return res.status(403).json({ error: 'Not a member of this DM channel' });
    }

    // Get the message
    const { data: existing } = await supabaseAdmin
      .from('chat_dm_messages')
      .select('id, author_id, is_deleted')
      .eq('id', msgId)
      .eq('channel_id', channelId)
      .single();

    if (!existing) {
      return res.status(404).json({ error: 'Message not found' });
    }

    if (existing.is_deleted) {
      return res.status(400).json({ error: 'Message already deleted' });
    }

    // Check ownership. Also allow admins (check if the user has an admin profile).
    let isAdmin = false;
    if (existing.author_id !== userId) {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('role')
        .eq('id', userId)
        .single();

      isAdmin = profile && ['admin', 'super_admin'].includes(profile.role);

      if (!isAdmin) {
        return res.status(403).json({ error: 'Not authorized to delete this message' });
      }
    }

    const { error } = await supabaseAdmin
      .from('chat_dm_messages')
      .update({ is_deleted: true })
      .eq('id', msgId);

    if (error) {
      console.error('Delete DM error:', error);
      return res.status(500).json({ error: 'Failed to delete message' });
    }

    res.json({ message: 'Message deleted' });
  } catch (error) {
    console.error('Delete DM error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /dm/:channelId/upload - upload DM image
router.post('/dm/:channelId/upload', authenticateCustomer, dmUpload.single('image'), async (req, res) => {
  try {
    const { channelId } = req.params;
    const userId = req.customer.id;

    // Verify membership
    const isMember = await verifyDmMembership(channelId, userId);
    if (!isMember) {
      return res.status(403).json({ error: 'Not a member of this DM channel' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    const { url, filename } = await uploadToSupabase(
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname,
      'chat'
    );

    res.json({ url, filename });
  } catch (error) {
    console.error('DM upload error:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// ============================================
// MODERATION
// ============================================

// POST /channels/:slug/mute/:userId - mute a user in a channel
router.post('/channels/:slug/mute/:userId', authenticateSupabaseUser, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { slug, userId } = req.params;

    const validation = muteUserSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    const channel = await getChannelBySlug(slug);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const { duration_minutes } = validation.data;
    const mutedUntil = new Date(Date.now() + duration_minutes * 60 * 1000).toISOString();

    // Upsert: update if member exists, insert if not
    const { data: existingMember } = await supabaseAdmin
      .from('chat_members')
      .select('id')
      .eq('channel_id', channel.id)
      .eq('user_id', userId)
      .single();

    if (existingMember) {
      const { error } = await supabaseAdmin
        .from('chat_members')
        .update({
          is_muted: true,
          muted_until: mutedUntil,
        })
        .eq('id', existingMember.id);

      if (error) {
        console.error('Mute user update error:', error);
        return res.status(500).json({ error: 'Failed to mute user' });
      }
    } else {
      const { error } = await supabaseAdmin
        .from('chat_members')
        .insert({
          channel_id: channel.id,
          user_id: userId,
          is_muted: true,
          muted_until: mutedUntil,
        });

      if (error) {
        console.error('Mute user insert error:', error);
        return res.status(500).json({ error: 'Failed to mute user' });
      }
    }

    res.json({
      message: 'User muted',
      muted_until: mutedUntil,
      duration_minutes,
    });
  } catch (error) {
    console.error('Mute user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /channels/:slug/unmute/:userId - unmute a user
router.post('/channels/:slug/unmute/:userId', authenticateSupabaseUser, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { slug, userId } = req.params;

    const channel = await getChannelBySlug(slug);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const { error } = await supabaseAdmin
      .from('chat_members')
      .update({
        is_muted: false,
        muted_until: null,
      })
      .eq('channel_id', channel.id)
      .eq('user_id', userId);

    if (error) {
      console.error('Unmute user error:', error);
      return res.status(500).json({ error: 'Failed to unmute user' });
    }

    res.json({ message: 'User unmuted' });
  } catch (error) {
    console.error('Unmute user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /channels/:slug/ban/:userId - ban a user from a channel
router.post('/channels/:slug/ban/:userId', authenticateSupabaseUser, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { slug, userId } = req.params;

    const validation = banUserSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    const channel = await getChannelBySlug(slug);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const { reason } = validation.data;

    // Upsert member record
    const { data: existingMember } = await supabaseAdmin
      .from('chat_members')
      .select('id')
      .eq('channel_id', channel.id)
      .eq('user_id', userId)
      .single();

    const banData = {
      is_banned: true,
      banned_at: new Date().toISOString(),
      banned_by: req.user.id,
      ban_reason: reason || null,
    };

    if (existingMember) {
      const { error } = await supabaseAdmin
        .from('chat_members')
        .update(banData)
        .eq('id', existingMember.id);

      if (error) {
        console.error('Ban user update error:', error);
        return res.status(500).json({ error: 'Failed to ban user' });
      }
    } else {
      const { error } = await supabaseAdmin
        .from('chat_members')
        .insert({
          channel_id: channel.id,
          user_id: userId,
          ...banData,
        });

      if (error) {
        console.error('Ban user insert error:', error);
        return res.status(500).json({ error: 'Failed to ban user' });
      }
    }

    res.json({ message: 'User banned', reason: reason || null });
  } catch (error) {
    console.error('Ban user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /channels/:slug/unban/:userId - unban a user
router.post('/channels/:slug/unban/:userId', authenticateSupabaseUser, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { slug, userId } = req.params;

    const channel = await getChannelBySlug(slug);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const { error } = await supabaseAdmin
      .from('chat_members')
      .update({
        is_banned: false,
        banned_at: null,
        banned_by: null,
        ban_reason: null,
      })
      .eq('channel_id', channel.id)
      .eq('user_id', userId);

    if (error) {
      console.error('Unban user error:', error);
      return res.status(500).json({ error: 'Failed to unban user' });
    }

    res.json({ message: 'User unbanned' });
  } catch (error) {
    console.error('Unban user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// MULTER ERROR HANDLER
// ============================================

router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 2MB' });
    }
    return res.status(400).json({ error: error.message });
  }
  if (error) return res.status(400).json({ error: error.message });
  next();
});

export default router;
