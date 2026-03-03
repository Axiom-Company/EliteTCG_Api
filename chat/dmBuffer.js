import { randomUUID } from 'crypto';
import { supabaseAdmin } from '../config/supabase.js';

const MAX_MESSAGES_PER_DM = 200;
const BACKUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STORAGE_BUCKET = 'images';
const STORAGE_PREFIX = 'chat-dm';

function makeDMKey(userId1, userId2) {
  return 'dm-' + [userId1, userId2].sort().join(':');
}

class DMBuffer {
  constructor() {
    this.conversations = new Map();
    this.dirty = new Set();
    this.backupTimer = null;
  }

  _ensureConversation(dmKey, participants = []) {
    if (!this.conversations.has(dmKey)) {
      this.conversations.set(dmKey, {
        participants,
        messages: [],
        lastActivity: new Date().toISOString(),
      });
    }
    return this.conversations.get(dmKey);
  }

  getOrCreateConversation(userId1, userId2) {
    const dmKey = makeDMKey(userId1, userId2);
    const conv = this._ensureConversation(dmKey, [userId1, userId2]);
    this.dirty.add(dmKey);
    return { channelKey: dmKey, conversation: conv };
  }

  addMessage(dmKey, { userId, authorName, avatarUrl, userRole, content, replyTo }) {
    const conv = this.conversations.get(dmKey);
    if (!conv) return null;

    const message = {
      id: randomUUID(),
      dm_key: dmKey,
      user_id: userId,
      author_name: authorName,
      avatar_url: avatarUrl || null,
      author_role: userRole || 'user',
      content,
      reply_to: replyTo || null,
      is_edited: false,
      is_deleted: false,
      reactions: {},
      created_at: new Date().toISOString(),
    };

    conv.messages.push(message);
    conv.lastActivity = message.created_at;

    while (conv.messages.length > MAX_MESSAGES_PER_DM) {
      conv.messages.shift();
    }

    this.dirty.add(dmKey);
    return message;
  }

  getMessages(dmKey, limit = 50, before = null) {
    const conv = this.conversations.get(dmKey);
    if (!conv) return [];

    let msgs = conv.messages;
    if (before) {
      const beforeDate = new Date(before);
      msgs = msgs.filter(m => new Date(m.created_at) < beforeDate);
    }
    return msgs.slice(-limit);
  }

  editMessage(dmKey, messageId, userId, newContent) {
    const conv = this.conversations.get(dmKey);
    if (!conv) return null;

    const msg = conv.messages.find(m => m.id === messageId);
    if (!msg || msg.user_id !== userId || msg.is_deleted) return null;

    msg.content = newContent;
    msg.is_edited = true;
    msg.edited_at = new Date().toISOString();
    this.dirty.add(dmKey);
    return msg;
  }

  deleteMessage(dmKey, messageId, userId, isAdmin = false) {
    const conv = this.conversations.get(dmKey);
    if (!conv) return null;

    const msg = conv.messages.find(m => m.id === messageId);
    if (!msg) return null;
    if (msg.user_id !== userId && !isAdmin) return null;

    msg.is_deleted = true;
    msg.content = '';
    this.dirty.add(dmKey);
    return msg;
  }

  getConversationsForUser(userId) {
    const result = [];
    for (const [dmKey, conv] of this.conversations) {
      if (!conv.participants.includes(userId)) continue;

      const otherUserId = conv.participants.find(id => id !== userId);
      const lastMsg = conv.messages.filter(m => !m.is_deleted).slice(-1)[0] || null;

      result.push({
        channel_id: dmKey,
        other_user_id: otherUserId,
        last_message: lastMsg?.content || null,
        last_message_at: lastMsg?.created_at || conv.lastActivity,
      });
    }

    result.sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
    return result;
  }

  isParticipant(dmKey, userId) {
    const conv = this.conversations.get(dmKey);
    return conv ? conv.participants.includes(userId) : false;
  }

  async backupToStorage() {
    if (!supabaseAdmin || this.dirty.size === 0) return;

    const keysToBackup = [...this.dirty];
    this.dirty.clear();

    for (const dmKey of keysToBackup) {
      const conv = this.conversations.get(dmKey);
      if (!conv) continue;

      const filePath = `${STORAGE_PREFIX}/${dmKey.replace(/:/g, '_')}.json`;
      const json = JSON.stringify(conv);

      const { error } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .upload(filePath, json, {
          contentType: 'application/json',
          upsert: true,
        });

      if (error) {
        console.error(`[DMBuffer] Backup failed for ${dmKey}:`, error.message);
        this.dirty.add(dmKey);
      }
    }

    // Save index
    const index = [];
    for (const [dmKey, conv] of this.conversations) {
      index.push({
        dmKey,
        participants: conv.participants,
        lastActivity: conv.lastActivity,
        messageCount: conv.messages.length,
      });
    }

    const indexPath = `${STORAGE_PREFIX}/index.json`;
    await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .upload(indexPath, JSON.stringify(index), {
        contentType: 'application/json',
        upsert: true,
      });
  }

  async loadFromStorage() {
    if (!supabaseAdmin) return;

    try {
      const { data: indexBlob, error: indexErr } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .download(`${STORAGE_PREFIX}/index.json`);

      if (indexErr || !indexBlob) {
        console.log('[DMBuffer] No existing DM backup found, starting fresh.');
        return;
      }

      const indexText = await indexBlob.text();
      const index = JSON.parse(indexText);

      let loaded = 0;
      for (const entry of index) {
        const filePath = `${STORAGE_PREFIX}/${entry.dmKey.replace(/:/g, '_')}.json`;
        const { data: blob, error } = await supabaseAdmin.storage
          .from(STORAGE_BUCKET)
          .download(filePath);

        if (error || !blob) continue;

        const text = await blob.text();
        const conv = JSON.parse(text);
        this.conversations.set(entry.dmKey, conv);
        loaded++;
      }

      console.log(`[DMBuffer] Loaded ${loaded} DM conversations from storage.`);
    } catch (err) {
      console.error('[DMBuffer] Load from storage error:', err.message);
    }
  }

  startBackupInterval() {
    if (this.backupTimer) return;
    this.backupTimer = setInterval(() => {
      this.backupToStorage().catch(err => {
        console.error('[DMBuffer] Periodic backup error:', err.message);
      });
    }, BACKUP_INTERVAL_MS);

    // Backup on process exit
    const gracefulBackup = () => {
      this.backupToStorage().catch(() => {}).finally(() => process.exit(0));
    };
    process.on('SIGTERM', gracefulBackup);
    process.on('SIGINT', gracefulBackup);
  }

  stopBackupInterval() {
    if (this.backupTimer) {
      clearInterval(this.backupTimer);
      this.backupTimer = null;
    }
  }
}

export const dmBuffer = new DMBuffer();
export { makeDMKey };
export default dmBuffer;
