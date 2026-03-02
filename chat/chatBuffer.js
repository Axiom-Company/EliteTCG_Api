import { randomUUID } from 'crypto';

const MAX_MESSAGES_PER_CHANNEL = 200;

class ChatBuffer {
  constructor() {
    this.buffers = new Map();
  }

  _ensureBuffer(channelSlug) {
    if (!this.buffers.has(channelSlug)) {
      this.buffers.set(channelSlug, []);
    }
    return this.buffers.get(channelSlug);
  }

  addMessage(channelSlug, { userId, authorName, avatarUrl, userRole, content, replyTo, isSystem = false }) {
    const buffer = this._ensureBuffer(channelSlug);

    const message = {
      id: randomUUID(),
      channel_slug: channelSlug,
      user_id: userId,
      author_name: authorName,
      avatar_url: avatarUrl || null,
      role: userRole || 'user',
      content,
      reply_to: replyTo || null,
      is_edited: false,
      is_deleted: false,
      is_system: isSystem,
      reactions: {},
      created_at: new Date().toISOString(),
    };

    buffer.push(message);

    // Ring buffer: drop oldest when exceeding max
    while (buffer.length > MAX_MESSAGES_PER_CHANNEL) {
      buffer.shift();
    }

    return message;
  }

  getMessages(channelSlug, limit = 50, before = null) {
    const buffer = this._ensureBuffer(channelSlug);

    let messages = buffer;
    if (before) {
      const beforeDate = new Date(before);
      messages = buffer.filter(m => new Date(m.created_at) < beforeDate);
    }

    // Return the newest `limit` messages (from the end)
    return messages.slice(-limit);
  }

  getMessage(channelSlug, messageId) {
    const buffer = this._ensureBuffer(channelSlug);
    return buffer.find(m => m.id === messageId) || null;
  }

  editMessage(channelSlug, messageId, userId, newContent) {
    const buffer = this._ensureBuffer(channelSlug);
    const msg = buffer.find(m => m.id === messageId);
    if (!msg) return null;
    if (msg.user_id !== userId) return null;
    if (msg.is_deleted) return null;

    msg.content = newContent;
    msg.is_edited = true;
    msg.edited_at = new Date().toISOString();
    return msg;
  }

  deleteMessage(channelSlug, messageId, userId, isModOrAdmin = false) {
    const buffer = this._ensureBuffer(channelSlug);
    const msg = buffer.find(m => m.id === messageId);
    if (!msg) return null;
    if (msg.user_id !== userId && !isModOrAdmin) return null;

    msg.is_deleted = true;
    msg.content = '';
    return msg;
  }

  toggleReaction(channelSlug, messageId, userId, emoji) {
    const buffer = this._ensureBuffer(channelSlug);
    const msg = buffer.find(m => m.id === messageId);
    if (!msg || msg.is_deleted) return null;

    if (!msg.reactions[emoji]) {
      msg.reactions[emoji] = [];
    }

    const idx = msg.reactions[emoji].indexOf(userId);
    if (idx === -1) {
      msg.reactions[emoji].push(userId);
    } else {
      msg.reactions[emoji].splice(idx, 1);
      if (msg.reactions[emoji].length === 0) {
        delete msg.reactions[emoji];
      }
    }

    return msg;
  }

  getChannelStats() {
    const stats = {};
    for (const [slug, buffer] of this.buffers) {
      stats[slug] = buffer.length;
    }
    return stats;
  }
}

// Singleton
export const chatBuffer = new ChatBuffer();
export default chatBuffer;
