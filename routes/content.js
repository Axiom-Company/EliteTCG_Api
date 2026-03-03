import { Router } from 'express';
import { z } from 'zod';
import { authenticateCustomer, optionalCustomerAuth, authenticateSupabaseUser, requireRole } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

// ============================================
// VALIDATION SCHEMAS
// ============================================

const createPostSchema = z.object({
  title: z.string().min(1).max(255),
  slug: z.string().min(1).max(255).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase with hyphens').optional(),
  excerpt: z.string().max(500).optional(),
  body: z.string().min(1),
  content_type: z.enum(['article', 'pack_opening', 'guide', 'news']),
  featured_image_url: z.string().url().max(500).optional(),
  gallery_images: z.array(z.string().url()).max(10).optional(),
  tags: z.array(z.string().max(50)).max(10).optional(),
  set_id: z.string().uuid().optional(),
  related_product_ids: z.array(z.string().uuid()).max(10).optional(),
  status: z.enum(['draft', 'published', 'archived']).optional(),
  is_featured: z.boolean().optional(),
  is_pinned: z.boolean().optional(),
  meta_title: z.string().max(255).optional(),
  meta_description: z.string().max(500).optional(),
  opening_session_id: z.string().uuid().optional()
});

const updatePostSchema = createPostSchema.partial();

const createCommentSchema = z.object({
  body: z.string().min(1).max(2000),
  parent_id: z.string().uuid().optional()
});

// ============================================
// PUBLIC ENDPOINTS
// ============================================

// List published posts
router.get('/', optionalCustomerAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const { content_type, tag, set_id, search, sort, featured } = req.query;

    let query = supabaseAdmin
      .from('content_posts')
      .select('id, title, slug, excerpt, content_type, featured_image_url, tags, status, is_featured, is_pinned, published_at, view_count, like_count, comment_count, author_id, admin_author_id, set_id, created_at', { count: 'exact' })
      .eq('status', 'published');

    if (content_type) query = query.eq('content_type', content_type);
    if (set_id) query = query.eq('set_id', set_id);
    if (featured === 'true') query = query.eq('is_featured', true);
    if (search) query = query.ilike('title', `%${search}%`);
    if (tag) query = query.contains('tags', [tag]);

    // Pinned posts first, then sort
    switch (sort) {
      case 'popular':
        query = query.order('is_pinned', { ascending: false }).order('view_count', { ascending: false });
        break;
      case 'most_liked':
        query = query.order('is_pinned', { ascending: false }).order('like_count', { ascending: false });
        break;
      case 'most_discussed':
        query = query.order('is_pinned', { ascending: false }).order('comment_count', { ascending: false });
        break;
      default:
        query = query.order('is_pinned', { ascending: false }).order('published_at', { ascending: false });
    }

    query = query.range(offset, offset + limit - 1);

    const { data: posts, error, count } = await query;

    if (error) {
      console.error('List posts error:', error);
      return res.status(500).json({ error: 'Failed to fetch posts' });
    }

    // Enrich with author names
    const enriched = [];
    for (const post of posts || []) {
      let authorName = 'EliteTCG';

      if (post.author_id) {
        const { data: customer } = await supabaseAdmin
          .from('profiles')
          .select('first_name, last_name')
          .eq('id', post.author_id)
          .single();
        if (customer) {
          authorName = `${customer.first_name} ${customer.last_name ? customer.last_name.charAt(0) + '.' : ''}`.trim();
        }
      } else if (post.admin_author_id) {
        const { data: admin } = await supabaseAdmin
          .from('admin_users')
          .select('name')
          .eq('id', post.admin_author_id)
          .single();
        if (admin) authorName = admin.name;
      }

      enriched.push({ ...post, author_name: authorName });
    }

    res.json({
      posts: enriched,
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit)
      }
    });
  } catch (error) {
    console.error('List posts error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get a single post by slug
router.get('/by-slug/:slug', optionalCustomerAuth, async (req, res) => {
  try {
    const { slug } = req.params;

    const { data: post, error } = await supabaseAdmin
      .from('content_posts')
      .select('*')
      .eq('slug', slug)
      .eq('status', 'published')
      .single();

    if (error || !post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Increment view count
    await supabaseAdmin
      .from('content_posts')
      .update({ view_count: post.view_count + 1 })
      .eq('id', post.id);

    // Get author info
    let authorName = 'EliteTCG';
    if (post.author_id) {
      const { data: customer } = await supabaseAdmin
        .from('profiles')
        .select('first_name, last_name')
        .eq('id', post.author_id)
        .single();
      if (customer) authorName = `${customer.first_name} ${customer.last_name ? customer.last_name.charAt(0) + '.' : ''}`.trim();
    } else if (post.admin_author_id) {
      const { data: admin } = await supabaseAdmin
        .from('admin_users')
        .select('name')
        .eq('id', post.admin_author_id)
        .single();
      if (admin) authorName = admin.name;
    }

    // Check if current user liked this post
    let isLiked = false;
    if (req.customer) {
      const { data: like } = await supabaseAdmin
        .from('content_likes')
        .select('id')
        .eq('post_id', post.id)
        .eq('customer_id', req.customer.id)
        .single();
      isLiked = !!like;
    }

    // Get related set info
    let setInfo = null;
    if (post.set_id) {
      const { data: set } = await supabaseAdmin
        .from('sets')
        .select('id, name, code, logo_url')
        .eq('id', post.set_id)
        .single();
      setInfo = set;
    }

    res.json({
      post: {
        ...post,
        author_name: authorName,
        is_liked: isLiked,
        set: setInfo,
        view_count: post.view_count + 1
      }
    });
  } catch (error) {
    console.error('Get post error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get a single post by ID
router.get('/:postId', optionalCustomerAuth, async (req, res) => {
  try {
    const { postId } = req.params;

    const { data: post, error } = await supabaseAdmin
      .from('content_posts')
      .select('*')
      .eq('id', postId)
      .eq('status', 'published')
      .single();

    if (error || !post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Increment view count
    await supabaseAdmin
      .from('content_posts')
      .update({ view_count: post.view_count + 1 })
      .eq('id', post.id);

    let authorName = 'EliteTCG';
    if (post.author_id) {
      const { data: customer } = await supabaseAdmin
        .from('profiles')
        .select('first_name, last_name')
        .eq('id', post.author_id)
        .single();
      if (customer) authorName = `${customer.first_name} ${customer.last_name ? customer.last_name.charAt(0) + '.' : ''}`.trim();
    } else if (post.admin_author_id) {
      const { data: admin } = await supabaseAdmin
        .from('admin_users')
        .select('name')
        .eq('id', post.admin_author_id)
        .single();
      if (admin) authorName = admin.name;
    }

    let isLiked = false;
    if (req.customer) {
      const { data: like } = await supabaseAdmin
        .from('content_likes')
        .select('id')
        .eq('post_id', post.id)
        .eq('customer_id', req.customer.id)
        .single();
      isLiked = !!like;
    }

    res.json({
      post: {
        ...post,
        author_name: authorName,
        is_liked: isLiked,
        view_count: post.view_count + 1
      }
    });
  } catch (error) {
    console.error('Get post error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// COMMENTS (PUBLIC READ, AUTH WRITE)
// ============================================

// Get comments for a post
router.get('/:postId/comments', optionalCustomerAuth, async (req, res) => {
  try {
    const { postId } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const { data: comments, error, count } = await supabaseAdmin
      .from('content_comments')
      .select('*', { count: 'exact' })
      .eq('post_id', postId)
      .eq('is_hidden', false)
      .is('parent_id', null)
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('List comments error:', error);
      return res.status(500).json({ error: 'Failed to fetch comments' });
    }

    // Enrich with author names and fetch replies
    const enriched = [];
    for (const comment of comments || []) {
      const { data: customer } = await supabaseAdmin
        .from('profiles')
        .select('first_name, last_name')
        .eq('id', comment.customer_id)
        .single();

      // Get replies for this comment
      const { data: replies } = await supabaseAdmin
        .from('content_comments')
        .select('*')
        .eq('parent_id', comment.id)
        .eq('is_hidden', false)
        .order('created_at', { ascending: true });

      const enrichedReplies = [];
      for (const reply of replies || []) {
        const { data: replyCustomer } = await supabaseAdmin
          .from('profiles')
          .select('first_name, last_name')
          .eq('id', reply.customer_id)
          .single();

        enrichedReplies.push({
          ...reply,
          author_name: replyCustomer ? `${replyCustomer.first_name} ${replyCustomer.last_name ? replyCustomer.last_name.charAt(0) + '.' : ''}`.trim() : 'Anonymous'
        });
      }

      enriched.push({
        ...comment,
        author_name: customer ? `${customer.first_name} ${customer.last_name ? customer.last_name.charAt(0) + '.' : ''}`.trim() : 'Anonymous',
        replies: enrichedReplies
      });
    }

    res.json({
      comments: enriched,
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit)
      }
    });
  } catch (error) {
    console.error('List comments error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add a comment to a post
router.post('/:postId/comments', authenticateCustomer, async (req, res) => {
  try {
    const { postId } = req.params;
    const validation = createCommentSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    // Verify post exists and is published
    const { data: post } = await supabaseAdmin
      .from('content_posts')
      .select('id')
      .eq('id', postId)
      .eq('status', 'published')
      .single();

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // If replying to a comment, verify parent exists
    if (validation.data.parent_id) {
      const { data: parent } = await supabaseAdmin
        .from('content_comments')
        .select('id')
        .eq('id', validation.data.parent_id)
        .eq('post_id', postId)
        .single();

      if (!parent) {
        return res.status(404).json({ error: 'Parent comment not found' });
      }
    }

    const { data: comment, error } = await supabaseAdmin
      .from('content_comments')
      .insert({
        post_id: postId,
        customer_id: req.customer.id,
        parent_id: validation.data.parent_id || null,
        body: validation.data.body
      })
      .select()
      .single();

    if (error) {
      console.error('Create comment error:', error);
      return res.status(500).json({ error: 'Failed to create comment' });
    }

    res.status(201).json({ message: 'Comment added', comment });
  } catch (error) {
    console.error('Create comment error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete own comment
router.delete('/:postId/comments/:commentId', authenticateCustomer, async (req, res) => {
  try {
    const { commentId } = req.params;

    const { data: comment } = await supabaseAdmin
      .from('content_comments')
      .select('id, customer_id')
      .eq('id', commentId)
      .single();

    if (!comment) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    if (comment.customer_id !== req.customer.id) {
      return res.status(403).json({ error: 'Not authorized to delete this comment' });
    }

    const { error } = await supabaseAdmin
      .from('content_comments')
      .delete()
      .eq('id', commentId);

    if (error) {
      console.error('Delete comment error:', error);
      return res.status(500).json({ error: 'Failed to delete comment' });
    }

    res.json({ message: 'Comment deleted' });
  } catch (error) {
    console.error('Delete comment error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// LIKES
// ============================================

// Like a post
router.post('/:postId/like', authenticateCustomer, async (req, res) => {
  try {
    const { postId } = req.params;

    // Check if already liked
    const { data: existing } = await supabaseAdmin
      .from('content_likes')
      .select('id')
      .eq('post_id', postId)
      .eq('customer_id', req.customer.id)
      .single();

    if (existing) {
      return res.status(409).json({ error: 'Already liked this post' });
    }

    const { error } = await supabaseAdmin
      .from('content_likes')
      .insert({
        post_id: postId,
        customer_id: req.customer.id
      });

    if (error) {
      console.error('Like post error:', error);
      return res.status(500).json({ error: 'Failed to like post' });
    }

    // Update like count
    await supabaseAdmin.rpc('increment', { table_name: 'content_posts', column_name: 'like_count', row_id: postId });

    // Fallback: manual increment
    const { data: post } = await supabaseAdmin
      .from('content_posts')
      .select('like_count')
      .eq('id', postId)
      .single();

    if (post) {
      await supabaseAdmin
        .from('content_posts')
        .update({ like_count: post.like_count + 1 })
        .eq('id', postId);
    }

    res.json({ message: 'Post liked' });
  } catch (error) {
    console.error('Like post error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Unlike a post
router.delete('/:postId/like', authenticateCustomer, async (req, res) => {
  try {
    const { postId } = req.params;

    const { data: existing } = await supabaseAdmin
      .from('content_likes')
      .select('id')
      .eq('post_id', postId)
      .eq('customer_id', req.customer.id)
      .single();

    if (!existing) {
      return res.status(404).json({ error: 'Like not found' });
    }

    const { error } = await supabaseAdmin
      .from('content_likes')
      .delete()
      .eq('post_id', postId)
      .eq('customer_id', req.customer.id);

    if (error) {
      console.error('Unlike post error:', error);
      return res.status(500).json({ error: 'Failed to unlike post' });
    }

    // Decrement like count
    const { data: post } = await supabaseAdmin
      .from('content_posts')
      .select('like_count')
      .eq('id', postId)
      .single();

    if (post) {
      await supabaseAdmin
        .from('content_posts')
        .update({ like_count: Math.max(0, post.like_count - 1) })
        .eq('id', postId);
    }

    res.json({ message: 'Post unliked' });
  } catch (error) {
    console.error('Unlike post error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// ADMIN ENDPOINTS
// ============================================

// Create a post (admin)
router.post('/', authenticateSupabaseUser, requireRole('super_admin', 'admin', 'manager'), async (req, res) => {
  try {
    const validation = createPostSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    const data = validation.data;

    // Auto-generate slug if not provided
    const slug = data.slug || data.title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .substring(0, 255);

    // Check slug uniqueness
    const { data: existingSlug } = await supabaseAdmin
      .from('content_posts')
      .select('id')
      .eq('slug', slug)
      .single();

    if (existingSlug) {
      return res.status(409).json({ error: 'A post with this slug already exists' });
    }

    const { data: post, error } = await supabaseAdmin
      .from('content_posts')
      .insert({
        admin_author_id: req.user.id,
        title: data.title,
        slug,
        excerpt: data.excerpt || null,
        body: data.body,
        content_type: data.content_type,
        featured_image_url: data.featured_image_url || null,
        gallery_images: data.gallery_images || [],
        tags: data.tags || [],
        set_id: data.set_id || null,
        related_product_ids: data.related_product_ids || [],
        status: data.status || 'draft',
        is_featured: data.is_featured || false,
        is_pinned: data.is_pinned || false,
        published_at: data.status === 'published' ? new Date().toISOString() : null,
        meta_title: data.meta_title || null,
        meta_description: data.meta_description || null,
        opening_session_id: data.opening_session_id || null
      })
      .select()
      .single();

    if (error) {
      console.error('Create post error:', error);
      return res.status(500).json({ error: 'Failed to create post' });
    }

    res.status(201).json({ message: 'Post created', post });
  } catch (error) {
    console.error('Create post error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update a post (admin)
router.put('/:postId', authenticateSupabaseUser, requireRole('super_admin', 'admin', 'manager'), async (req, res) => {
  try {
    const { postId } = req.params;
    const validation = updatePostSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    const updateData = { ...validation.data };

    // If publishing for the first time, set published_at
    if (updateData.status === 'published') {
      const { data: existing } = await supabaseAdmin
        .from('content_posts')
        .select('published_at')
        .eq('id', postId)
        .single();

      if (existing && !existing.published_at) {
        updateData.published_at = new Date().toISOString();
      }
    }

    const { data: post, error } = await supabaseAdmin
      .from('content_posts')
      .update(updateData)
      .eq('id', postId)
      .select()
      .single();

    if (error) {
      console.error('Update post error:', error);
      return res.status(500).json({ error: 'Failed to update post' });
    }

    res.json({ message: 'Post updated', post });
  } catch (error) {
    console.error('Update post error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a post (admin)
router.delete('/:postId', authenticateSupabaseUser, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { postId } = req.params;

    const { error } = await supabaseAdmin
      .from('content_posts')
      .delete()
      .eq('id', postId);

    if (error) {
      console.error('Delete post error:', error);
      return res.status(500).json({ error: 'Failed to delete post' });
    }

    res.json({ message: 'Post deleted' });
  } catch (error) {
    console.error('Delete post error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// List all posts including drafts (admin)
router.get('/admin/all', authenticateSupabaseUser, requireRole('super_admin', 'admin', 'manager'), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const { status, content_type } = req.query;

    let query = supabaseAdmin
      .from('content_posts')
      .select('*', { count: 'exact' });

    if (status) query = query.eq('status', status);
    if (content_type) query = query.eq('content_type', content_type);

    query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data: posts, error, count } = await query;

    if (error) {
      console.error('Admin list posts error:', error);
      return res.status(500).json({ error: 'Failed to fetch posts' });
    }

    res.json({
      posts: posts || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit)
      }
    });
  } catch (error) {
    console.error('Admin list posts error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Hide/flag a comment
router.patch('/comments/:commentId/moderate', authenticateSupabaseUser, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { commentId } = req.params;
    const { is_hidden, is_flagged } = req.body;

    const updateData = {};
    if (typeof is_hidden === 'boolean') updateData.is_hidden = is_hidden;
    if (typeof is_flagged === 'boolean') updateData.is_flagged = is_flagged;

    const { data: comment, error } = await supabaseAdmin
      .from('content_comments')
      .update(updateData)
      .eq('id', commentId)
      .select()
      .single();

    if (error) {
      console.error('Moderate comment error:', error);
      return res.status(500).json({ error: 'Failed to moderate comment' });
    }

    res.json({ message: 'Comment moderated', comment });
  } catch (error) {
    console.error('Moderate comment error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
