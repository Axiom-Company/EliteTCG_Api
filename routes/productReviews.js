import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

// Recalculate and persist avg rating + review count on the product
const syncProductRating = async (productId) => {
  const { data } = await supabaseAdmin
    .from('product_reviews')
    .select('rating')
    .eq('product_id', productId);

  const count = data?.length || 0;
  const avg = count > 0
    ? Math.round((data.reduce((s, r) => s + r.rating, 0) / count) * 10) / 10
    : 0;

  await supabaseAdmin
    .from('products')
    .update({ rating: avg, review_count: count })
    .eq('id', productId);
};

// GET reviews for a product (public) — paginated
router.get('/product/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 3, 50);
    const offset = parseInt(req.query.offset) || 0;

    const { data, error, count } = await supabaseAdmin
      .from('product_reviews')
      .select('id, name, rating, title, comment, created_at, helpful_count', { count: 'exact' })
      .eq('product_id', productId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    res.json({ reviews: data || [], total: count || 0, hasMore: offset + limit < (count || 0) });
  } catch (err) {
    console.error('Get product reviews error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST a review for a product (public — no auth required)
router.post('/product/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const { name, email, rating, comment, title } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length < 1) {
      return res.status(400).json({ error: 'Name is required' });
    }
    if (!rating || typeof rating !== 'number' || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }
    if (comment && comment.length > 2000) {
      return res.status(400).json({ error: 'Comment must be under 2000 characters' });
    }

    // Verify product exists
    const { data: product, error: productError } = await supabaseAdmin
      .from('products')
      .select('id')
      .eq('id', productId)
      .single();

    if (productError || !product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const { data, error } = await supabaseAdmin
      .from('product_reviews')
      .insert({
        product_id: productId,
        name: name.trim(),
        email: email?.trim() || null,
        rating: Math.round(rating),
        title: title?.trim() || null,
        comment: comment?.trim() || null,
      })
      .select('id, name, rating, title, comment, created_at')
      .single();

    if (error) throw error;

    // Update product's cached rating + count
    await syncProductRating(productId);

    res.status(201).json({ review: data });
  } catch (err) {
    console.error('Create product review error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST helpful — increment helpful_count
router.post('/:id/helpful', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: review, error: fetchErr } = await supabaseAdmin
      .from('product_reviews')
      .select('helpful_count')
      .eq('id', id)
      .single();

    if (fetchErr || !review) return res.status(404).json({ error: 'Review not found' });

    const { error } = await supabaseAdmin
      .from('product_reviews')
      .update({ helpful_count: (review.helpful_count || 0) + 1 })
      .eq('id', id);

    if (error) throw error;
    res.json({ helpful_count: (review.helpful_count || 0) + 1 });
  } catch (err) {
    console.error('Helpful error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST report a review
router.post('/:id/report', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Reason is required' });

    const { error } = await supabaseAdmin
      .from('review_reports')
      .insert({ review_id: id, reason });

    if (error) throw error;
    res.json({ message: 'Report submitted' });
  } catch (err) {
    console.error('Report error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET all reviews — admin only
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { product_id, limit = 100, offset = 0 } = req.query;

    let query = supabaseAdmin
      .from('product_reviews')
      .select('id, name, email, rating, title, comment, helpful_count, created_at, product_id, products(id, name, slug), review_reports(id, reason, created_at)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (product_id) query = query.eq('product_id', product_id);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({ reviews: data || [], total: count || 0 });
  } catch (err) {
    console.error('Admin get reviews error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE a review — admin only
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Grab product_id before deleting so we can sync
    const { data: existing } = await supabaseAdmin
      .from('product_reviews')
      .select('product_id')
      .eq('id', id)
      .single();

    const { error } = await supabaseAdmin
      .from('product_reviews')
      .delete()
      .eq('id', id);

    if (error) throw error;

    if (existing?.product_id) {
      await syncProductRating(existing.product_id);
    }

    res.json({ message: 'Review deleted' });
  } catch (err) {
    console.error('Delete review error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
