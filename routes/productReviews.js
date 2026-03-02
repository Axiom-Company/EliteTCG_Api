import { Router } from 'express';
import { z } from 'zod';
import { authenticateCustomer, optionalCustomerAuth, authenticateSupabaseUser, requireRole } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

// ============================================
// VALIDATION SCHEMAS
// ============================================

const createReviewSchema = z.object({
  product_id: z.string().uuid('Invalid product ID').optional(),
  set_id: z.string().uuid('Invalid set ID').optional(),
  rating: z.number().int().min(1).max(5),
  title: z.string().min(1).max(255).optional(),
  body: z.string().max(5000).optional(),
  value_rating: z.number().int().min(1).max(5).optional(),
  pull_rates_rating: z.number().int().min(1).max(5).optional(),
  quality_rating: z.number().int().min(1).max(5).optional(),
  images: z.array(z.string().url()).max(5).optional(),
  order_id: z.string().uuid().optional()
}).refine(data => data.product_id || data.set_id, {
  message: 'Either product_id or set_id is required'
});

const updateReviewSchema = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  title: z.string().min(1).max(255).optional(),
  body: z.string().max(5000).optional(),
  value_rating: z.number().int().min(1).max(5).optional(),
  pull_rates_rating: z.number().int().min(1).max(5).optional(),
  quality_rating: z.number().int().min(1).max(5).optional(),
  images: z.array(z.string().url()).max(5).optional()
});

// ============================================
// PUBLIC ENDPOINTS
// ============================================

// Get reviews for a product
router.get('/product/:productId', optionalCustomerAuth, async (req, res) => {
  try {
    const { productId } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const { sort, rating } = req.query;

    let query = supabaseAdmin
      .from('product_reviews')
      .select('*', { count: 'exact' })
      .eq('product_id', productId)
      .eq('is_approved', true);

    if (rating) query = query.eq('rating', parseInt(rating));

    switch (sort) {
      case 'highest':
        query = query.order('rating', { ascending: false });
        break;
      case 'lowest':
        query = query.order('rating', { ascending: true });
        break;
      case 'most_helpful':
        query = query.order('helpful_count', { ascending: false });
        break;
      default:
        query = query.order('created_at', { ascending: false });
    }

    query = query.range(offset, offset + limit - 1);

    const { data: reviews, error, count } = await query;

    if (error) {
      console.error('List product reviews error:', error);
      return res.status(500).json({ error: 'Failed to fetch reviews' });
    }

    // Enrich with reviewer names and check user votes
    const enriched = [];
    for (const review of reviews || []) {
      const { data: customer } = await supabaseAdmin
        .from('profiles')
        .select('first_name, last_name')
        .eq('id', review.customer_id)
        .single();

      let userVote = null;
      if (req.customer) {
        const { data: vote } = await supabaseAdmin
          .from('review_votes')
          .select('is_helpful')
          .eq('review_id', review.id)
          .eq('customer_id', req.customer.id)
          .single();
        if (vote) userVote = vote.is_helpful ? 'helpful' : 'not_helpful';
      }

      enriched.push({
        ...review,
        reviewer_name: customer ? `${customer.first_name} ${customer.last_name ? customer.last_name.charAt(0) + '.' : ''}`.trim() : 'Anonymous',
        user_vote: userVote
      });
    }

    // Calculate rating distribution
    const { data: allRatings } = await supabaseAdmin
      .from('product_reviews')
      .select('rating')
      .eq('product_id', productId)
      .eq('is_approved', true);

    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let totalRating = 0;
    for (const r of allRatings || []) {
      distribution[r.rating]++;
      totalRating += r.rating;
    }
    const avgRating = allRatings?.length > 0
      ? parseFloat((totalRating / allRatings.length).toFixed(1))
      : 0;

    res.json({
      reviews: enriched,
      summary: {
        average_rating: avgRating,
        total_reviews: allRatings?.length || 0,
        distribution
      },
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit)
      }
    });
  } catch (error) {
    console.error('List product reviews error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get reviews for a set
router.get('/set/:setId', optionalCustomerAuth, async (req, res) => {
  try {
    const { setId } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const { data: reviews, error, count } = await supabaseAdmin
      .from('product_reviews')
      .select('*', { count: 'exact' })
      .eq('set_id', setId)
      .eq('is_approved', true)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('List set reviews error:', error);
      return res.status(500).json({ error: 'Failed to fetch reviews' });
    }

    const enriched = [];
    for (const review of reviews || []) {
      const { data: customer } = await supabaseAdmin
        .from('profiles')
        .select('first_name, last_name')
        .eq('id', review.customer_id)
        .single();

      enriched.push({
        ...review,
        reviewer_name: customer ? `${customer.first_name} ${customer.last_name ? customer.last_name.charAt(0) + '.' : ''}`.trim() : 'Anonymous'
      });
    }

    // Rating summary
    const { data: allRatings } = await supabaseAdmin
      .from('product_reviews')
      .select('rating, value_rating, pull_rates_rating, quality_rating')
      .eq('set_id', setId)
      .eq('is_approved', true);

    const total = allRatings?.length || 0;
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let sumRating = 0, sumValue = 0, sumPull = 0, sumQuality = 0;
    let countValue = 0, countPull = 0, countQuality = 0;

    for (const r of allRatings || []) {
      distribution[r.rating]++;
      sumRating += r.rating;
      if (r.value_rating) { sumValue += r.value_rating; countValue++; }
      if (r.pull_rates_rating) { sumPull += r.pull_rates_rating; countPull++; }
      if (r.quality_rating) { sumQuality += r.quality_rating; countQuality++; }
    }

    res.json({
      reviews: enriched,
      summary: {
        average_rating: total > 0 ? parseFloat((sumRating / total).toFixed(1)) : 0,
        average_value_rating: countValue > 0 ? parseFloat((sumValue / countValue).toFixed(1)) : null,
        average_pull_rates_rating: countPull > 0 ? parseFloat((sumPull / countPull).toFixed(1)) : null,
        average_quality_rating: countQuality > 0 ? parseFloat((sumQuality / countQuality).toFixed(1)) : null,
        total_reviews: total,
        distribution
      },
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit)
      }
    });
  } catch (error) {
    console.error('List set reviews error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// AUTHENTICATED ENDPOINTS
// ============================================

// Create a review
router.post('/', authenticateCustomer, async (req, res) => {
  try {
    const validation = createReviewSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    const data = validation.data;

    // Check for duplicate review
    if (data.product_id) {
      const { data: existing } = await supabaseAdmin
        .from('product_reviews')
        .select('id')
        .eq('customer_id', req.customer.id)
        .eq('product_id', data.product_id)
        .single();

      if (existing) {
        return res.status(409).json({ error: 'You have already reviewed this product' });
      }
    }

    // Verify purchase if order_id provided
    let isVerifiedPurchase = false;
    if (data.order_id) {
      const { data: order } = await supabaseAdmin
        .from('orders')
        .select('id, customer_id, status')
        .eq('id', data.order_id)
        .eq('customer_id', req.customer.id)
        .single();

      if (order && ['delivered', 'shipped', 'confirmed'].includes(order.status)) {
        isVerifiedPurchase = true;
      }
    }

    const { data: review, error } = await supabaseAdmin
      .from('product_reviews')
      .insert({
        customer_id: req.customer.id,
        product_id: data.product_id || null,
        set_id: data.set_id || null,
        rating: data.rating,
        title: data.title || null,
        body: data.body || null,
        value_rating: data.value_rating || null,
        pull_rates_rating: data.pull_rates_rating || null,
        quality_rating: data.quality_rating || null,
        images: data.images || [],
        is_verified_purchase: isVerifiedPurchase,
        order_id: data.order_id || null
      })
      .select()
      .single();

    if (error) {
      console.error('Create review error:', error);
      return res.status(500).json({ error: 'Failed to create review' });
    }

    // Update product rating if product_id
    if (data.product_id) {
      const { data: allRatings } = await supabaseAdmin
        .from('product_reviews')
        .select('rating')
        .eq('product_id', data.product_id)
        .eq('is_approved', true);

      if (allRatings && allRatings.length > 0) {
        const avgRating = parseFloat((allRatings.reduce((s, r) => s + r.rating, 0) / allRatings.length).toFixed(1));
        await supabaseAdmin
          .from('products')
          .update({ rating: avgRating, review_count: allRatings.length })
          .eq('id', data.product_id);
      }
    }

    res.status(201).json({ message: 'Review created', review });
  } catch (error) {
    console.error('Create review error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update own review
router.put('/:reviewId', authenticateCustomer, async (req, res) => {
  try {
    const { reviewId } = req.params;
    const validation = updateReviewSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    const { data: existing } = await supabaseAdmin
      .from('product_reviews')
      .select('id, customer_id')
      .eq('id', reviewId)
      .single();

    if (!existing) {
      return res.status(404).json({ error: 'Review not found' });
    }

    if (existing.customer_id !== req.customer.id) {
      return res.status(403).json({ error: 'Not authorized to update this review' });
    }

    const { data: review, error } = await supabaseAdmin
      .from('product_reviews')
      .update(validation.data)
      .eq('id', reviewId)
      .select()
      .single();

    if (error) {
      console.error('Update review error:', error);
      return res.status(500).json({ error: 'Failed to update review' });
    }

    res.json({ message: 'Review updated', review });
  } catch (error) {
    console.error('Update review error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete own review
router.delete('/:reviewId', authenticateCustomer, async (req, res) => {
  try {
    const { reviewId } = req.params;

    const { data: review } = await supabaseAdmin
      .from('product_reviews')
      .select('id, customer_id, product_id')
      .eq('id', reviewId)
      .single();

    if (!review) {
      return res.status(404).json({ error: 'Review not found' });
    }

    if (review.customer_id !== req.customer.id) {
      return res.status(403).json({ error: 'Not authorized to delete this review' });
    }

    const { error } = await supabaseAdmin
      .from('product_reviews')
      .delete()
      .eq('id', reviewId);

    if (error) {
      console.error('Delete review error:', error);
      return res.status(500).json({ error: 'Failed to delete review' });
    }

    // Recalculate product rating
    if (review.product_id) {
      const { data: allRatings } = await supabaseAdmin
        .from('product_reviews')
        .select('rating')
        .eq('product_id', review.product_id)
        .eq('is_approved', true);

      const avgRating = allRatings && allRatings.length > 0
        ? parseFloat((allRatings.reduce((s, r) => s + r.rating, 0) / allRatings.length).toFixed(1))
        : 0;

      await supabaseAdmin
        .from('products')
        .update({ rating: avgRating, review_count: allRatings?.length || 0 })
        .eq('id', review.product_id);
    }

    res.json({ message: 'Review deleted' });
  } catch (error) {
    console.error('Delete review error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Vote on review helpfulness
router.post('/:reviewId/vote', authenticateCustomer, async (req, res) => {
  try {
    const { reviewId } = req.params;
    const { is_helpful } = req.body;

    if (typeof is_helpful !== 'boolean') {
      return res.status(400).json({ error: 'is_helpful (boolean) is required' });
    }

    // Check review exists
    const { data: review } = await supabaseAdmin
      .from('product_reviews')
      .select('id, customer_id, helpful_count, not_helpful_count')
      .eq('id', reviewId)
      .single();

    if (!review) {
      return res.status(404).json({ error: 'Review not found' });
    }

    // Can't vote on own review
    if (review.customer_id === req.customer.id) {
      return res.status(400).json({ error: 'Cannot vote on your own review' });
    }

    // Check existing vote
    const { data: existingVote } = await supabaseAdmin
      .from('review_votes')
      .select('id, is_helpful')
      .eq('review_id', reviewId)
      .eq('customer_id', req.customer.id)
      .single();

    if (existingVote) {
      if (existingVote.is_helpful === is_helpful) {
        return res.status(409).json({ error: 'Already voted' });
      }

      // Change vote
      await supabaseAdmin
        .from('review_votes')
        .update({ is_helpful })
        .eq('id', existingVote.id);

      // Update counts
      await supabaseAdmin
        .from('product_reviews')
        .update({
          helpful_count: is_helpful ? review.helpful_count + 1 : Math.max(0, review.helpful_count - 1),
          not_helpful_count: is_helpful ? Math.max(0, review.not_helpful_count - 1) : review.not_helpful_count + 1
        })
        .eq('id', reviewId);
    } else {
      // New vote
      const { error } = await supabaseAdmin
        .from('review_votes')
        .insert({
          review_id: reviewId,
          customer_id: req.customer.id,
          is_helpful
        });

      if (error) {
        console.error('Vote error:', error);
        return res.status(500).json({ error: 'Failed to vote' });
      }

      await supabaseAdmin
        .from('product_reviews')
        .update({
          helpful_count: is_helpful ? review.helpful_count + 1 : review.helpful_count,
          not_helpful_count: is_helpful ? review.not_helpful_count : review.not_helpful_count + 1
        })
        .eq('id', reviewId);
    }

    res.json({ message: 'Vote recorded' });
  } catch (error) {
    console.error('Vote error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get my reviews
router.get('/my-reviews', authenticateCustomer, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const { data: reviews, error, count } = await supabaseAdmin
      .from('product_reviews')
      .select('*', { count: 'exact' })
      .eq('customer_id', req.customer.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('My reviews error:', error);
      return res.status(500).json({ error: 'Failed to fetch reviews' });
    }

    res.json({
      reviews: reviews || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit)
      }
    });
  } catch (error) {
    console.error('My reviews error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// ADMIN ENDPOINTS
// ============================================

// List all reviews (admin - includes flagged/unapproved)
router.get('/admin/all', authenticateSupabaseUser, requireRole('admin'), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const { is_flagged, is_approved } = req.query;

    let query = supabaseAdmin
      .from('product_reviews')
      .select('*', { count: 'exact' });

    if (is_flagged === 'true') query = query.eq('is_flagged', true);
    if (is_approved === 'false') query = query.eq('is_approved', false);

    query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data: reviews, error, count } = await query;

    if (error) {
      console.error('Admin reviews error:', error);
      return res.status(500).json({ error: 'Failed to fetch reviews' });
    }

    res.json({
      reviews: reviews || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit)
      }
    });
  } catch (error) {
    console.error('Admin reviews error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Moderate a review (admin)
router.patch('/:reviewId/moderate', authenticateSupabaseUser, requireRole('admin'), async (req, res) => {
  try {
    const { reviewId } = req.params;
    const { is_approved, is_flagged } = req.body;

    const updateData = {};
    if (typeof is_approved === 'boolean') updateData.is_approved = is_approved;
    if (typeof is_flagged === 'boolean') updateData.is_flagged = is_flagged;

    const { data: review, error } = await supabaseAdmin
      .from('product_reviews')
      .update(updateData)
      .eq('id', reviewId)
      .select()
      .single();

    if (error) {
      console.error('Moderate review error:', error);
      return res.status(500).json({ error: 'Failed to moderate review' });
    }

    res.json({ message: 'Review moderated', review });
  } catch (error) {
    console.error('Moderate review error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
