import { Server } from 'socket.io';
import { supabaseAdmin } from '../config/supabase.js';
import { chatBuffer } from './chatBuffer.js';

// ── Presence tracking ────────────────────────────────────────────────────────
const onlineUsers = new Map();

// ── Rate-limit state ─────────────────────────────────────────────────────────
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateLimitCounters = new Map();

function checkRateLimit(socketId) {
  const entry = rateLimitCounters.get(socketId);
  if (!entry) return false;
  return entry.count >= RATE_LIMIT_MAX;
}

function incrementRateLimit(socketId) {
  let entry = rateLimitCounters.get(socketId);
  if (!entry) {
    entry = { count: 0 };
    rateLimitCounters.set(socketId, entry);
  }
  entry.count += 1;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const MOD_ADMIN_ROLES = ['admin', 'moderator', 'mod'];

function isModOrAdmin(role) {
  return MOD_ADMIN_ROLES.includes(role);
}

function sanitiseContent(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 2000) return null;
  return trimmed;
}

async function resolveChannelId(channelSlug) {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from('chat_channels')
    .select('id')
    .eq('slug', channelSlug)
    .single();
  if (error || !data) return null;
  return data.id;
}

async function checkMuteOrBan(channelId, userId) {
  if (!supabaseAdmin || !channelId) return { muted: false, banned: false };

  const { data, error } = await supabaseAdmin
    .from('chat_members')
    .select('is_muted, muted_until, is_banned')
    .eq('channel_id', channelId)
    .eq('user_id', userId)
    .single();

  if (error || !data) return { muted: false, banned: false };

  let muted = !!data.is_muted;
  if (muted && data.muted_until) {
    if (new Date(data.muted_until) < new Date()) {
      muted = false;
    }
  }

  return { muted, banned: !!data.is_banned };
}

async function getMemberRole(channelId, userId) {
  if (!supabaseAdmin || !channelId) return null;
  const { data, error } = await supabaseAdmin
    .from('chat_members')
    .select('role')
    .eq('channel_id', channelId)
    .eq('user_id', userId)
    .single();
  if (error || !data) return null;
  return data.role;
}

function buildPresenceList() {
  const list = [];
  for (const [userId, info] of onlineUsers) {
    list.push({ userId, name: info.name, avatarUrl: info.avatarUrl });
  }
  return list;
}

// ── Main export ──────────────────────────────────────────────────────────────

export function initChatSocket(httpServer, allowedOrigins) {
  const io = new Server(httpServer, {
    cors: {
      origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return callback(null, true);
        if (Array.isArray(allowedOrigins) && allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        callback(new Error('Not allowed by CORS'));
      },
      credentials: true,
    },
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  // ── Auth middleware ──────────────────────────────────────────────────────
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token || typeof token !== 'string') {
        return next(new Error('Authentication required'));
      }

      if (!supabaseAdmin) {
        return next(new Error('Server auth unavailable'));
      }

      const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
      if (error || !user) {
        return next(new Error('Invalid or expired token'));
      }

      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('first_name, last_name, avatar_url, role')
        .eq('id', user.id)
        .single();

      if (!profile) {
        return next(new Error('Profile not found'));
      }

      const displayName = [profile.first_name, profile.last_name]
        .filter(Boolean)
        .join(' ') || 'Anonymous';

      socket.user = {
        id: user.id,
        email: user.email,
        name: displayName,
        avatarUrl: profile.avatar_url || null,
        role: profile.role || 'user',
      };

      next();
    } catch (err) {
      console.error('[ChatSocket] Auth middleware error:', err.message);
      next(new Error('Authentication failed'));
    }
  });

  // ── Rate-limit reset interval ───────────────────────────────────────────
  const rateLimitInterval = setInterval(() => {
    rateLimitCounters.clear();
  }, RATE_LIMIT_WINDOW_MS);

  // Clean up interval if server closes
  io.engine?.on('close', () => clearInterval(rateLimitInterval));

  // ── Connection handler ──────────────────────────────────────────────────
  io.on('connection', (socket) => {
    const { user } = socket;

    // Track presence
    onlineUsers.set(user.id, {
      name: user.name,
      avatarUrl: user.avatarUrl,
      socketId: socket.id,
    });
    io.emit('presence:update', buildPresenceList());

    // ── channel:join ────────────────────────────────────────────────────
    socket.on('channel:join', async ({ channelSlug } = {}) => {
      try {
        if (!channelSlug || typeof channelSlug !== 'string') {
          return socket.emit('error', { message: 'Invalid channel slug' });
        }

        const slug = channelSlug.trim();
        socket.join(slug);

        // Send channel history
        const messages = chatBuffer.getMessages(slug, 50);
        socket.emit('channel:history', { channelSlug: slug, messages });

        // System join message
        const systemMsg = chatBuffer.addMessage(slug, {
          userId: 'system',
          authorName: 'System',
          avatarUrl: null,
          userRole: 'system',
          content: `${user.name} joined the channel`,
          isSystem: true,
        });
        io.to(slug).emit('message:new', { channelSlug: slug, message: systemMsg });
      } catch (err) {
        console.error('[ChatSocket] channel:join error:', err.message);
        socket.emit('error', { message: 'Failed to join channel' });
      }
    });

    // ── channel:leave ───────────────────────────────────────────────────
    socket.on('channel:leave', ({ channelSlug } = {}) => {
      if (!channelSlug || typeof channelSlug !== 'string') return;
      socket.leave(channelSlug.trim());
    });

    // ── message:send ────────────────────────────────────────────────────
    socket.on('message:send', async ({ channelSlug, content, replyTo } = {}) => {
      try {
        if (!channelSlug || typeof channelSlug !== 'string') {
          return socket.emit('error', { message: 'Invalid channel slug' });
        }

        // Rate limit
        if (checkRateLimit(socket.id)) {
          return socket.emit('error', { message: 'Rate limit exceeded. Wait a moment.' });
        }

        // Validate content
        const clean = sanitiseContent(content);
        if (!clean) {
          return socket.emit('error', { message: 'Message must be 1-2000 characters' });
        }

        const slug = channelSlug.trim();

        // Mute/ban check
        const channelId = await resolveChannelId(slug);
        if (channelId) {
          const { muted, banned } = await checkMuteOrBan(channelId, user.id);
          if (banned) {
            return socket.emit('error', { message: 'You are banned from this channel' });
          }
          if (muted) {
            return socket.emit('error', { message: 'You are muted in this channel' });
          }
        }

        incrementRateLimit(socket.id);

        const isDM = slug.startsWith('dm-');

        if (isDM) {
          // DM: persist to Supabase
          if (!supabaseAdmin) {
            return socket.emit('error', { message: 'DM service unavailable' });
          }

          const { data: dmMsg, error: dmErr } = await supabaseAdmin
            .from('chat_dm_messages')
            .insert({
              channel_slug: slug,
              user_id: user.id,
              author_name: user.name,
              avatar_url: user.avatarUrl,
              role: user.role,
              content: clean,
              reply_to: replyTo || null,
            })
            .select()
            .single();

          if (dmErr) {
            console.error('[ChatSocket] DM insert error:', dmErr.message);
            return socket.emit('error', { message: 'Failed to send message' });
          }

          io.to(slug).emit('message:new', { channelSlug: slug, message: dmMsg });
        } else {
          // Public channel: use in-memory buffer
          const msg = chatBuffer.addMessage(slug, {
            userId: user.id,
            authorName: user.name,
            avatarUrl: user.avatarUrl,
            userRole: user.role,
            content: clean,
            replyTo: replyTo || null,
          });

          io.to(slug).emit('message:new', { channelSlug: slug, message: msg });
        }
      } catch (err) {
        console.error('[ChatSocket] message:send error:', err.message);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    // ── message:edit ────────────────────────────────────────────────────
    socket.on('message:edit', async ({ channelSlug, messageId, content } = {}) => {
      try {
        if (!channelSlug || !messageId || typeof channelSlug !== 'string') {
          return socket.emit('error', { message: 'Invalid edit parameters' });
        }

        const clean = sanitiseContent(content);
        if (!clean) {
          return socket.emit('error', { message: 'Message must be 1-2000 characters' });
        }

        const slug = channelSlug.trim();
        const isDM = slug.startsWith('dm-');

        if (isDM) {
          if (!supabaseAdmin) {
            return socket.emit('error', { message: 'DM service unavailable' });
          }

          const { data: updated, error } = await supabaseAdmin
            .from('chat_dm_messages')
            .update({ content: clean, is_edited: true, edited_at: new Date().toISOString() })
            .eq('id', messageId)
            .eq('user_id', user.id)
            .select()
            .single();

          if (error || !updated) {
            return socket.emit('error', { message: 'Cannot edit this message' });
          }

          io.to(slug).emit('message:edited', { channelSlug: slug, message: updated });
        } else {
          const edited = chatBuffer.editMessage(slug, messageId, user.id, clean);
          if (!edited) {
            return socket.emit('error', { message: 'Cannot edit this message' });
          }

          io.to(slug).emit('message:edited', { channelSlug: slug, message: edited });
        }
      } catch (err) {
        console.error('[ChatSocket] message:edit error:', err.message);
        socket.emit('error', { message: 'Failed to edit message' });
      }
    });

    // ── message:delete ──────────────────────────────────────────────────
    socket.on('message:delete', async ({ channelSlug, messageId } = {}) => {
      try {
        if (!channelSlug || !messageId || typeof channelSlug !== 'string') {
          return socket.emit('error', { message: 'Invalid delete parameters' });
        }

        const slug = channelSlug.trim();
        const isDM = slug.startsWith('dm-');
        const userIsModAdmin = isModOrAdmin(user.role);

        if (isDM) {
          if (!supabaseAdmin) {
            return socket.emit('error', { message: 'DM service unavailable' });
          }

          // Build the soft-delete query -- own message OR mod/admin
          let query = supabaseAdmin
            .from('chat_dm_messages')
            .update({ is_deleted: true, content: '' })
            .eq('id', messageId);

          if (!userIsModAdmin) {
            query = query.eq('user_id', user.id);
          }

          const { data: deleted, error } = await query.select().single();

          if (error || !deleted) {
            return socket.emit('error', { message: 'Cannot delete this message' });
          }

          io.to(slug).emit('message:deleted', { channelSlug: slug, messageId });
        } else {
          const deleted = chatBuffer.deleteMessage(slug, messageId, user.id, userIsModAdmin);
          if (!deleted) {
            return socket.emit('error', { message: 'Cannot delete this message' });
          }

          io.to(slug).emit('message:deleted', { channelSlug: slug, messageId });
        }
      } catch (err) {
        console.error('[ChatSocket] message:delete error:', err.message);
        socket.emit('error', { message: 'Failed to delete message' });
      }
    });

    // ── message:pin ─────────────────────────────────────────────────────
    socket.on('message:pin', async ({ channelSlug, messageId } = {}) => {
      try {
        if (!channelSlug || !messageId || typeof channelSlug !== 'string') {
          return socket.emit('error', { message: 'Invalid pin parameters' });
        }

        const slug = channelSlug.trim();

        // Check mod/admin via profile role or chat_members role
        let canPin = isModOrAdmin(user.role);
        if (!canPin) {
          const channelId = await resolveChannelId(slug);
          if (channelId) {
            const memberRole = await getMemberRole(channelId, user.id);
            canPin = isModOrAdmin(memberRole);
          }
        }

        if (!canPin) {
          return socket.emit('error', { message: 'Only moderators and admins can pin messages' });
        }

        const message = chatBuffer.getMessage(slug, messageId);
        if (!message) {
          return socket.emit('error', { message: 'Message not found' });
        }

        if (!supabaseAdmin) {
          return socket.emit('error', { message: 'Pin service unavailable' });
        }

        const { error } = await supabaseAdmin
          .from('chat_pinned_messages')
          .insert({
            channel_slug: slug,
            message_id: message.id,
            user_id: message.user_id,
            author_name: message.author_name,
            content: message.content,
            pinned_by: user.id,
          });

        if (error) {
          console.error('[ChatSocket] Pin insert error:', error.message);
          return socket.emit('error', { message: 'Failed to pin message' });
        }

        io.to(slug).emit('message:pinned', {
          channelSlug: slug,
          message,
          pinnedBy: { id: user.id, name: user.name },
        });
      } catch (err) {
        console.error('[ChatSocket] message:pin error:', err.message);
        socket.emit('error', { message: 'Failed to pin message' });
      }
    });

    // ── message:react ───────────────────────────────────────────────────
    socket.on('message:react', async ({ channelSlug, messageId, emoji } = {}) => {
      try {
        if (!channelSlug || !messageId || !emoji) {
          return socket.emit('error', { message: 'Invalid reaction parameters' });
        }
        if (typeof emoji !== 'string' || emoji.length > 32) {
          return socket.emit('error', { message: 'Invalid emoji' });
        }

        const slug = channelSlug.trim();
        const updated = chatBuffer.toggleReaction(slug, messageId, user.id, emoji);
        if (!updated) {
          return socket.emit('error', { message: 'Message not found or deleted' });
        }

        io.to(slug).emit('reaction:updated', {
          channelSlug: slug,
          messageId,
          reactions: updated.reactions,
        });
      } catch (err) {
        console.error('[ChatSocket] message:react error:', err.message);
        socket.emit('error', { message: 'Failed to toggle reaction' });
      }
    });

    // ── typing:start ────────────────────────────────────────────────────
    socket.on('typing:start', ({ channelSlug } = {}) => {
      if (!channelSlug || typeof channelSlug !== 'string') return;
      socket.to(channelSlug.trim()).emit('typing:update', {
        channelSlug: channelSlug.trim(),
        user: { id: user.id, name: user.name },
      });
    });

    // ── disconnect ──────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      onlineUsers.delete(user.id);
      rateLimitCounters.delete(socket.id);
      io.emit('presence:update', buildPresenceList());
    });
  });

  return io;
}

// ── REST helper ──────────────────────────────────────────────────────────────
export function getOnlineUsers() {
  return buildPresenceList();
}
