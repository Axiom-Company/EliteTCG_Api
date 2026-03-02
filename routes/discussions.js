import { Router } from 'express';
import { z } from 'zod';
import { authenticateCustomer, optionalCustomerAuth, authenticateSupabaseUser, requireRole } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

// ============================================
// VALIDATION SCHEMAS
// ============================================

const createThreadSchema = z.object({
  category_id: z.string().uuid('Invalid category ID'),
  title: z.string().min(3).max(255),
  body: z.string().min(10).max(10000),
  tags: z.array(z.string().max(50)).max(5).optional(),
  set_id: z.string().uuid().optional(),
  product_id: z.string().uuid().optional()
});

const updateThreadSchema = z.object({
  title: z.string().min(3).max(255).optional(),
  body: z.string().min(10).max(10000).optional(),
  tags: z.array(z.string().max(50)).max(5).optional()
});

const createReplySchema = z.object({
  body: z.string().min(1).max(5000),
  parent_id: z.string().uuid().optional()
});

// ============================================
// DISCUSSION CATEGORIES
// ============================================

// List all categories
router.get('/categories', async (req, res) => {
  try {
    const { data: categories, error } = await supabaseAdmin
      .from('discussion_categories')
      .select('*')
      .eq('is_active', true)
      .order('display_order', { ascending: true });

    if (error) {
      console.error('List categories error:', error);
      return res.status(500).json({ error: 'Failed to fetch categories' });
    }

    res.json({ categories: categories || [] });
  } catch (error) {
    console.error('List categories error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get category with recent threads
router.get('/categories/:slug', optionalCustomerAuth, async (req, res) => {
  try {
    const { slug } = req.params;

    const { data: category, error: catError } = await supabaseAdmin
      .from('discussion_categories')
      .select('*')
      .eq('slug', slug)
      .eq('is_active', true)
      .single();

    if (catError || !category) {
      return res.status(404).json({ error: 'Category not found' });
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const { sort } = req.query;

    let query = supabaseAdmin
      .from('discussion_threads')
      .select('*', { count: 'exact' })
      .eq('category_id', category.id);

    // Pinned threads first
    switch (sort) {
      case 'popular':
        query = query.order('is_pinned', { ascending: false }).order('vote_score', { ascending: false });
        break;
      case 'most_replies':
        query = query.order('is_pinned', { ascending: false }).order('reply_count', { ascending: false });
        break;
      case 'latest_reply':
        query = query.order('is_pinned', { ascending: false }).order('last_reply_at', { ascending: false, nullsFirst: false });
        break;
      default:
        query = query.order('is_pinned', { ascending: false }).order('created_at', { ascending: false });
    }

    query = query.range(offset, offset + limit - 1);

    const { data: threads, error, count } = await query;

    if (error) {
      console.error('List threads error:', error);
      return res.status(500).json({ error: 'Failed to fetch threads' });
    }

    // Enrich threads
    const enriched = await enrichThreads(threads || [], req.customer);

    res.json({
      category,
      threads: enriched,
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit)
      }
    });
  } catch (error) {
    console.error('Get category error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// THREADS
// ============================================

// List threads (across all categories, for search/discovery)
router.get('/threads', optionalCustomerAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const { search, tag, set_id, sort, category_id } = req.query;

    let query = supabaseAdmin
      .from('discussion_threads')
      .select('*', { count: 'exact' });

    if (category_id) query = query.eq('category_id', category_id);
    if (set_id) query = query.eq('set_id', set_id);
    if (search) query = query.ilike('title', `%${search}%`);
    if (tag) query = query.contains('tags', [tag]);

    switch (sort) {
      case 'popular':
        query = query.order('vote_score', { ascending: false });
        break;
      case 'most_replies':
        query = query.order('reply_count', { ascending: false });
        break;
      case 'latest_reply':
        query = query.order('last_reply_at', { ascending: false, nullsFirst: false });
        break;
      default:
        query = query.order('created_at', { ascending: false });
    }

    query = query.range(offset, offset + limit - 1);

    const { data: threads, error, count } = await query;

    if (error) {
      console.error('List threads error:', error);
      return res.status(500).json({ error: 'Failed to fetch threads' });
    }

    const enriched = await enrichThreads(threads || [], req.customer);

    res.json({
      threads: enriched,
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit)
      }
    });
  } catch (error) {
    console.error('List threads error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get a single thread with replies
router.get('/threads/:threadId', optionalCustomerAuth, async (req, res) => {
  try {
    const { threadId } = req.params;

    // Try by ID first, then by slug
    let thread;
    const { data: byId } = await supabaseAdmin
      .from('discussion_threads')
      .select('*')
      .eq('id', threadId)
      .single();

    if (byId) {
      thread = byId;
    } else {
      const { data: bySlug } = await supabaseAdmin
        .from('discussion_threads')
        .select('*')
        .eq('slug', threadId)
        .single();
      thread = bySlug;
    }

    if (!thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    // Increment view count
    await supabaseAdmin
      .from('discussion_threads')
      .update({ view_count: thread.view_count + 1 })
      .eq('id', thread.id);

    // Get author info
    const { data: author } = await supabaseAdmin
      .from('profiles')
      .select('first_name, last_name')
      .eq('id', thread.customer_id)
      .single();

    // Get category info
    const { data: category } = await supabaseAdmin
      .from('discussion_categories')
      .select('id, name, slug, icon, color')
      .eq('id', thread.category_id)
      .single();

    // Get user's vote
    let userVote = null;
    if (req.customer) {
      const { data: vote } = await supabaseAdmin
        .from('discussion_votes')
        .select('vote')
        .eq('thread_id', thread.id)
        .eq('customer_id', req.customer.id)
        .single();
      if (vote) userVote = vote.vote;
    }

    // Get replies
    const replyPage = Math.max(1, parseInt(req.query.reply_page) || 1);
    const replyLimit = Math.min(50, Math.max(1, parseInt(req.query.reply_limit) || 20));
    const replyOffset = (replyPage - 1) * replyLimit;

    const { data: replies, error: repliesError, count: replyCount } = await supabaseAdmin
      .from('discussion_replies')
      .select('*', { count: 'exact' })
      .eq('thread_id', thread.id)
      .eq('is_hidden', false)
      .is('parent_id', null)
      .order('created_at', { ascending: true })
      .range(replyOffset, replyOffset + replyLimit - 1);

    // Enrich replies
    const enrichedReplies = [];
    for (const reply of replies || []) {
      const { data: replyAuthor } = await supabaseAdmin
        .from('profiles')
        .select('first_name, last_name')
        .eq('id', reply.customer_id)
        .single();

      let replyUserVote = null;
      if (req.customer) {
        const { data: vote } = await supabaseAdmin
          .from('discussion_votes')
          .select('vote')
          .eq('reply_id', reply.id)
          .eq('customer_id', req.customer.id)
          .single();
        if (vote) replyUserVote = vote.vote;
      }

      // Get nested replies (1 level deep)
      const { data: nestedReplies } = await supabaseAdmin
        .from('discussion_replies')
        .select('*')
        .eq('parent_id', reply.id)
        .eq('is_hidden', false)
        .order('created_at', { ascending: true })
        .limit(10);

      const enrichedNested = [];
      for (const nested of nestedReplies || []) {
        const { data: nestedAuthor } = await supabaseAdmin
          .from('profiles')
          .select('first_name, last_name')
          .eq('id', nested.customer_id)
          .single();

        enrichedNested.push({
          ...nested,
          author_name: nestedAuthor ? `${nestedAuthor.first_name} ${nestedAuthor.last_name ? nestedAuthor.last_name.charAt(0) + '.' : ''}`.trim() : 'Anonymous'
        });
      }

      enrichedReplies.push({
        ...reply,
        author_name: replyAuthor ? `${replyAuthor.first_name} ${replyAuthor.last_name ? replyAuthor.last_name.charAt(0) + '.' : ''}`.trim() : 'Anonymous',
        user_vote: replyUserVote,
        nested_replies: enrichedNested
      });
    }

    res.json({
      thread: {
        ...thread,
        author_name: author ? `${author.first_name} ${author.last_name ? author.last_name.charAt(0) + '.' : ''}`.trim() : 'Anonymous',
        category,
        user_vote: userVote,
        view_count: thread.view_count + 1
      },
      replies: enrichedReplies,
      reply_pagination: {
        page: replyPage,
        limit: replyLimit,
        total: replyCount || 0,
        totalPages: Math.ceil((replyCount || 0) / replyLimit)
      }
    });
  } catch (error) {
    console.error('Get thread error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create a thread
router.post('/threads', authenticateCustomer, async (req, res) => {
  try {
    const validation = createThreadSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    const data = validation.data;

    // Verify category exists
    const { data: category } = await supabaseAdmin
      .from('discussion_categories')
      .select('id')
      .eq('id', data.category_id)
      .eq('is_active', true)
      .single();

    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }

    // Generate slug
    const baseSlug = data.title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .substring(0, 200);

    const slug = `${baseSlug}-${Date.now().toString(36)}`;

    const { data: thread, error } = await supabaseAdmin
      .from('discussion_threads')
      .insert({
        category_id: data.category_id,
        customer_id: req.customer.id,
        title: data.title,
        body: data.body,
        slug,
        tags: data.tags || [],
        set_id: data.set_id || null,
        product_id: data.product_id || null
      })
      .select()
      .single();

    if (error) {
      console.error('Create thread error:', error);
      return res.status(500).json({ error: 'Failed to create thread' });
    }

    res.status(201).json({ message: 'Thread created', thread });
  } catch (error) {
    console.error('Create thread error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update own thread
router.put('/threads/:threadId', authenticateCustomer, async (req, res) => {
  try {
    const { threadId } = req.params;
    const validation = updateThreadSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    const { data: existing } = await supabaseAdmin
      .from('discussion_threads')
      .select('id, customer_id, is_locked')
      .eq('id', threadId)
      .single();

    if (!existing) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    if (existing.customer_id !== req.customer.id) {
      return res.status(403).json({ error: 'Not authorized to update this thread' });
    }

    if (existing.is_locked) {
      return res.status(403).json({ error: 'Thread is locked' });
    }

    const { data: thread, error } = await supabaseAdmin
      .from('discussion_threads')
      .update(validation.data)
      .eq('id', threadId)
      .select()
      .single();

    if (error) {
      console.error('Update thread error:', error);
      return res.status(500).json({ error: 'Failed to update thread' });
    }

    res.json({ message: 'Thread updated', thread });
  } catch (error) {
    console.error('Update thread error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete own thread
router.delete('/threads/:threadId', authenticateCustomer, async (req, res) => {
  try {
    const { threadId } = req.params;

    const { data: thread } = await supabaseAdmin
      .from('discussion_threads')
      .select('id, customer_id')
      .eq('id', threadId)
      .single();

    if (!thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    if (thread.customer_id !== req.customer.id) {
      return res.status(403).json({ error: 'Not authorized to delete this thread' });
    }

    const { error } = await supabaseAdmin
      .from('discussion_threads')
      .delete()
      .eq('id', threadId);

    if (error) {
      console.error('Delete thread error:', error);
      return res.status(500).json({ error: 'Failed to delete thread' });
    }

    res.json({ message: 'Thread deleted' });
  } catch (error) {
    console.error('Delete thread error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// REPLIES
// ============================================

// Add a reply to a thread
router.post('/threads/:threadId/replies', authenticateCustomer, async (req, res) => {
  try {
    const { threadId } = req.params;
    const validation = createReplySchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    // Verify thread exists and is not locked
    const { data: thread } = await supabaseAdmin
      .from('discussion_threads')
      .select('id, is_locked')
      .eq('id', threadId)
      .single();

    if (!thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    if (thread.is_locked) {
      return res.status(403).json({ error: 'Thread is locked' });
    }

    // Verify parent reply if provided
    if (validation.data.parent_id) {
      const { data: parent } = await supabaseAdmin
        .from('discussion_replies')
        .select('id')
        .eq('id', validation.data.parent_id)
        .eq('thread_id', threadId)
        .single();

      if (!parent) {
        return res.status(404).json({ error: 'Parent reply not found' });
      }
    }

    const { data: reply, error } = await supabaseAdmin
      .from('discussion_replies')
      .insert({
        thread_id: threadId,
        customer_id: req.customer.id,
        parent_id: validation.data.parent_id || null,
        body: validation.data.body
      })
      .select()
      .single();

    if (error) {
      console.error('Create reply error:', error);
      return res.status(500).json({ error: 'Failed to create reply' });
    }

    res.status(201).json({ message: 'Reply added', reply });
  } catch (error) {
    console.error('Create reply error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Edit own reply
router.put('/replies/:replyId', authenticateCustomer, async (req, res) => {
  try {
    const { replyId } = req.params;
    const { body } = req.body;

    if (!body || body.length < 1 || body.length > 5000) {
      return res.status(400).json({ error: 'Body must be between 1 and 5000 characters' });
    }

    const { data: existing } = await supabaseAdmin
      .from('discussion_replies')
      .select('id, customer_id')
      .eq('id', replyId)
      .single();

    if (!existing) {
      return res.status(404).json({ error: 'Reply not found' });
    }

    if (existing.customer_id !== req.customer.id) {
      return res.status(403).json({ error: 'Not authorized to edit this reply' });
    }

    const { data: reply, error } = await supabaseAdmin
      .from('discussion_replies')
      .update({ body, is_edited: true })
      .eq('id', replyId)
      .select()
      .single();

    if (error) {
      console.error('Edit reply error:', error);
      return res.status(500).json({ error: 'Failed to edit reply' });
    }

    res.json({ message: 'Reply updated', reply });
  } catch (error) {
    console.error('Edit reply error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete own reply
router.delete('/replies/:replyId', authenticateCustomer, async (req, res) => {
  try {
    const { replyId } = req.params;

    const { data: reply } = await supabaseAdmin
      .from('discussion_replies')
      .select('id, customer_id')
      .eq('id', replyId)
      .single();

    if (!reply) {
      return res.status(404).json({ error: 'Reply not found' });
    }

    if (reply.customer_id !== req.customer.id) {
      return res.status(403).json({ error: 'Not authorized to delete this reply' });
    }

    const { error } = await supabaseAdmin
      .from('discussion_replies')
      .delete()
      .eq('id', replyId);

    if (error) {
      console.error('Delete reply error:', error);
      return res.status(500).json({ error: 'Failed to delete reply' });
    }

    res.json({ message: 'Reply deleted' });
  } catch (error) {
    console.error('Delete reply error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// VOTING
// ============================================

// Vote on a thread
router.post('/threads/:threadId/vote', authenticateCustomer, async (req, res) => {
  try {
    const { threadId } = req.params;
    const { vote } = req.body;

    if (!['upvote', 'downvote'].includes(vote)) {
      return res.status(400).json({ error: 'vote must be "upvote" or "downvote"' });
    }

    const { data: thread } = await supabaseAdmin
      .from('discussion_threads')
      .select('id, vote_score, customer_id')
      .eq('id', threadId)
      .single();

    if (!thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    // Check existing vote
    const { data: existingVote } = await supabaseAdmin
      .from('discussion_votes')
      .select('id, vote')
      .eq('thread_id', threadId)
      .eq('customer_id', req.customer.id)
      .single();

    let scoreChange = 0;

    if (existingVote) {
      if (existingVote.vote === vote) {
        // Remove vote
        await supabaseAdmin
          .from('discussion_votes')
          .delete()
          .eq('id', existingVote.id);
        scoreChange = vote === 'upvote' ? -1 : 1;
      } else {
        // Change vote
        await supabaseAdmin
          .from('discussion_votes')
          .update({ vote })
          .eq('id', existingVote.id);
        scoreChange = vote === 'upvote' ? 2 : -2;
      }
    } else {
      // New vote
      const { error } = await supabaseAdmin
        .from('discussion_votes')
        .insert({
          customer_id: req.customer.id,
          thread_id: threadId,
          vote
        });

      if (error) {
        console.error('Vote error:', error);
        return res.status(500).json({ error: 'Failed to vote' });
      }
      scoreChange = vote === 'upvote' ? 1 : -1;
    }

    // Update thread score
    await supabaseAdmin
      .from('discussion_threads')
      .update({ vote_score: thread.vote_score + scoreChange })
      .eq('id', threadId);

    res.json({
      message: existingVote?.vote === vote ? 'Vote removed' : 'Vote recorded',
      new_score: thread.vote_score + scoreChange
    });
  } catch (error) {
    console.error('Vote error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Vote on a reply
router.post('/replies/:replyId/vote', authenticateCustomer, async (req, res) => {
  try {
    const { replyId } = req.params;
    const { vote } = req.body;

    if (!['upvote', 'downvote'].includes(vote)) {
      return res.status(400).json({ error: 'vote must be "upvote" or "downvote"' });
    }

    const { data: reply } = await supabaseAdmin
      .from('discussion_replies')
      .select('id, vote_score')
      .eq('id', replyId)
      .single();

    if (!reply) {
      return res.status(404).json({ error: 'Reply not found' });
    }

    const { data: existingVote } = await supabaseAdmin
      .from('discussion_votes')
      .select('id, vote')
      .eq('reply_id', replyId)
      .eq('customer_id', req.customer.id)
      .single();

    let scoreChange = 0;

    if (existingVote) {
      if (existingVote.vote === vote) {
        await supabaseAdmin
          .from('discussion_votes')
          .delete()
          .eq('id', existingVote.id);
        scoreChange = vote === 'upvote' ? -1 : 1;
      } else {
        await supabaseAdmin
          .from('discussion_votes')
          .update({ vote })
          .eq('id', existingVote.id);
        scoreChange = vote === 'upvote' ? 2 : -2;
      }
    } else {
      const { error } = await supabaseAdmin
        .from('discussion_votes')
        .insert({
          customer_id: req.customer.id,
          reply_id: replyId,
          vote
        });

      if (error) {
        console.error('Vote error:', error);
        return res.status(500).json({ error: 'Failed to vote' });
      }
      scoreChange = vote === 'upvote' ? 1 : -1;
    }

    await supabaseAdmin
      .from('discussion_replies')
      .update({ vote_score: reply.vote_score + scoreChange })
      .eq('id', replyId);

    res.json({
      message: existingVote?.vote === vote ? 'Vote removed' : 'Vote recorded',
      new_score: reply.vote_score + scoreChange
    });
  } catch (error) {
    console.error('Vote error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// ADMIN ENDPOINTS
// ============================================

// Admin: Pin/unpin thread
router.patch('/threads/:threadId/pin', authenticateSupabaseUser, requireRole('admin'), async (req, res) => {
  try {
    const { threadId } = req.params;
    const { is_pinned } = req.body;

    const { data: thread, error } = await supabaseAdmin
      .from('discussion_threads')
      .update({ is_pinned: !!is_pinned })
      .eq('id', threadId)
      .select()
      .single();

    if (error) {
      console.error('Pin thread error:', error);
      return res.status(500).json({ error: 'Failed to pin/unpin thread' });
    }

    res.json({ message: is_pinned ? 'Thread pinned' : 'Thread unpinned', thread });
  } catch (error) {
    console.error('Pin thread error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Lock/unlock thread
router.patch('/threads/:threadId/lock', authenticateSupabaseUser, requireRole('admin'), async (req, res) => {
  try {
    const { threadId } = req.params;
    const { is_locked } = req.body;

    const { data: thread, error } = await supabaseAdmin
      .from('discussion_threads')
      .update({ is_locked: !!is_locked })
      .eq('id', threadId)
      .select()
      .single();

    if (error) {
      console.error('Lock thread error:', error);
      return res.status(500).json({ error: 'Failed to lock/unlock thread' });
    }

    res.json({ message: is_locked ? 'Thread locked' : 'Thread unlocked', thread });
  } catch (error) {
    console.error('Lock thread error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Delete any thread
router.delete('/admin/threads/:threadId', authenticateSupabaseUser, requireRole('admin'), async (req, res) => {
  try {
    const { threadId } = req.params;

    const { error } = await supabaseAdmin
      .from('discussion_threads')
      .delete()
      .eq('id', threadId);

    if (error) {
      console.error('Admin delete thread error:', error);
      return res.status(500).json({ error: 'Failed to delete thread' });
    }

    res.json({ message: 'Thread deleted by admin' });
  } catch (error) {
    console.error('Admin delete thread error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Hide/flag a reply
router.patch('/replies/:replyId/moderate', authenticateSupabaseUser, requireRole('admin'), async (req, res) => {
  try {
    const { replyId } = req.params;
    const { is_hidden, is_flagged } = req.body;

    const updateData = {};
    if (typeof is_hidden === 'boolean') updateData.is_hidden = is_hidden;
    if (typeof is_flagged === 'boolean') updateData.is_flagged = is_flagged;

    const { data: reply, error } = await supabaseAdmin
      .from('discussion_replies')
      .update(updateData)
      .eq('id', replyId)
      .select()
      .single();

    if (error) {
      console.error('Moderate reply error:', error);
      return res.status(500).json({ error: 'Failed to moderate reply' });
    }

    res.json({ message: 'Reply moderated', reply });
  } catch (error) {
    console.error('Moderate reply error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Manage discussion categories
router.post('/categories', authenticateSupabaseUser, requireRole('admin'), async (req, res) => {
  try {
    const { name, slug, description, icon, color, display_order } = req.body;

    if (!name || !slug) {
      return res.status(400).json({ error: 'name and slug are required' });
    }

    const { data: category, error } = await supabaseAdmin
      .from('discussion_categories')
      .insert({ name, slug, description, icon, color, display_order: display_order || 0 })
      .select()
      .single();

    if (error) {
      console.error('Create category error:', error);
      return res.status(500).json({ error: 'Failed to create category' });
    }

    res.status(201).json({ message: 'Category created', category });
  } catch (error) {
    console.error('Create category error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/categories/:categoryId', authenticateSupabaseUser, requireRole('admin'), async (req, res) => {
  try {
    const { categoryId } = req.params;
    const { name, description, icon, color, display_order, is_active } = req.body;

    const updateData = {};
    if (name) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (icon !== undefined) updateData.icon = icon;
    if (color !== undefined) updateData.color = color;
    if (display_order !== undefined) updateData.display_order = display_order;
    if (typeof is_active === 'boolean') updateData.is_active = is_active;

    const { data: category, error } = await supabaseAdmin
      .from('discussion_categories')
      .update(updateData)
      .eq('id', categoryId)
      .select()
      .single();

    if (error) {
      console.error('Update category error:', error);
      return res.status(500).json({ error: 'Failed to update category' });
    }

    res.json({ message: 'Category updated', category });
  } catch (error) {
    console.error('Update category error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Mark reply as accepted answer
router.patch('/replies/:replyId/accept', authenticateCustomer, async (req, res) => {
  try {
    const { replyId } = req.params;

    const { data: reply } = await supabaseAdmin
      .from('discussion_replies')
      .select('id, thread_id')
      .eq('id', replyId)
      .single();

    if (!reply) {
      return res.status(404).json({ error: 'Reply not found' });
    }

    // Only thread author can accept answers
    const { data: thread } = await supabaseAdmin
      .from('discussion_threads')
      .select('customer_id')
      .eq('id', reply.thread_id)
      .single();

    if (!thread || thread.customer_id !== req.customer.id) {
      return res.status(403).json({ error: 'Only the thread author can accept answers' });
    }

    // Unmark any previously accepted answer
    await supabaseAdmin
      .from('discussion_replies')
      .update({ is_accepted_answer: false })
      .eq('thread_id', reply.thread_id)
      .eq('is_accepted_answer', true);

    // Mark this reply as accepted
    const { data: updated, error } = await supabaseAdmin
      .from('discussion_replies')
      .update({ is_accepted_answer: true })
      .eq('id', replyId)
      .select()
      .single();

    if (error) {
      console.error('Accept answer error:', error);
      return res.status(500).json({ error: 'Failed to accept answer' });
    }

    res.json({ message: 'Answer accepted', reply: updated });
  } catch (error) {
    console.error('Accept answer error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// HELPER FUNCTIONS
// ============================================

async function enrichThreads(threads, customer) {
  const enriched = [];
  for (const thread of threads) {
    const { data: author } = await supabaseAdmin
      .from('profiles')
      .select('first_name, last_name')
      .eq('id', thread.customer_id)
      .single();

    const { data: category } = await supabaseAdmin
      .from('discussion_categories')
      .select('name, slug, icon, color')
      .eq('id', thread.category_id)
      .single();

    let userVote = null;
    if (customer) {
      const { data: vote } = await supabaseAdmin
        .from('discussion_votes')
        .select('vote')
        .eq('thread_id', thread.id)
        .eq('customer_id', customer.id)
        .single();
      if (vote) userVote = vote.vote;
    }

    enriched.push({
      ...thread,
      author_name: author ? `${author.first_name} ${author.last_name ? author.last_name.charAt(0) + '.' : ''}`.trim() : 'Anonymous',
      category: category || null,
      user_vote: userVote
    });
  }
  return enriched;
}

export default router;
