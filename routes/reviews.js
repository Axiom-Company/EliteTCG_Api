import { Router } from 'express';
import { z } from 'zod';
import { authenticateCustomer, optionalCustomerAuth } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

// Validation schemas
const createReviewSchema = z.object({
  order_id: z.string().uuid('Invalid order ID'),
  rating: z.number().int().min(1, 'Rating must be at least 1').max(5, 'Rating must be at most 5'),
  comment: z.string().max(1000, 'Comment must be 1000 characters or less').optional()
});

/**
 * @openapi
 * /marketplace/reviews:
 *   post:
 *     tags: [Reviews]
 *     summary: Create a review for an order
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [order_id, rating]
 *             properties:
 *               order_id:
 *                 type: string
 *                 format: uuid
 *               rating:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 5
 *               comment:
 *                 type: string
 *                 maxLength: 1000
 *     responses:
 *       201:
 *         description: Review created
 *       400:
 *         description: Validation failed or order not paid
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Only the buyer can review
 *       404:
 *         description: Order not found
 *       409:
 *         description: Review already exists for this order
 *       500:
 *         description: Server error
 */
// Create a review
router.post('/', authenticateCustomer, async (req, res) => {
  try {
    const validation = createReviewSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors
      });
    }

    const { order_id, rating, comment } = validation.data;

    // Fetch the order
    const { data: order, error: orderError } = await supabaseAdmin
      .from('marketplace_orders')
      .select('id, buyer_id, seller_id, listing_id, payment_status')
      .eq('id', order_id)
      .single();

    if (orderError || !order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Verify the reviewer is the buyer
    if (order.buyer_id !== req.customer.id) {
      return res.status(403).json({ error: 'Only the buyer can review this order' });
    }

    // Verify payment is completed
    if (order.payment_status !== 'completed') {
      return res.status(400).json({ error: 'Cannot review an order that has not been paid' });
    }

    // Check if a review already exists for this order
    const { data: existingReview } = await supabaseAdmin
      .from('marketplace_reviews')
      .select('id')
      .eq('order_id', order_id)
      .single();

    if (existingReview) {
      return res.status(409).json({ error: 'A review already exists for this order' });
    }

    // Insert the review
    const { data: review, error: insertError } = await supabaseAdmin
      .from('marketplace_reviews')
      .insert({
        order_id,
        reviewer_id: req.customer.id,
        seller_id: order.seller_id,
        listing_id: order.listing_id,
        rating,
        comment: comment || null
      })
      .select()
      .single();

    if (insertError) {
      console.error('Create review error:', insertError);
      return res.status(500).json({ error: 'Failed to create review' });
    }

    res.status(201).json({
      message: 'Review created successfully',
      review
    });
  } catch (error) {
    console.error('Create review error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /marketplace/reviews/seller/{sellerId}:
 *   get:
 *     tags: [Reviews]
 *     summary: Get reviews for a seller (public)
 *     parameters:
 *       - in: path
 *         name: sellerId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: Paginated seller reviews
 *       500:
 *         description: Server error
 */
// Get reviews for a seller (public)
router.get('/seller/:sellerId', optionalCustomerAuth, async (req, res) => {
  try {
    const { sellerId } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    // Fetch reviews for this seller
    const { data: reviews, error, count } = await supabaseAdmin
      .from('marketplace_reviews')
      .select('*', { count: 'exact' })
      .eq('seller_id', sellerId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('Get seller reviews error:', error);
      return res.status(500).json({ error: 'Failed to fetch reviews' });
    }

    // Enrich reviews with reviewer names
    const enrichedReviews = [];
    for (const review of reviews) {
      let reviewerName = 'Anonymous';

      const { data: customer } = await supabaseAdmin
        .from('profiles')
        .select('first_name, last_name')
        .eq('id', review.reviewer_id)
        .single();

      if (customer) {
        reviewerName = `${customer.first_name} ${customer.last_name ? customer.last_name.charAt(0) + '.' : ''}`.trim();
      }

      enrichedReviews.push({
        ...review,
        reviewer_name: reviewerName
      });
    }

    res.json({
      reviews: enrichedReviews,
      pagination: {
        page,
        limit,
        total: count,
        totalPages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Get seller reviews error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /marketplace/reviews/can-review/{orderId}:
 *   get:
 *     tags: [Reviews]
 *     summary: Check if current user can review an order
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Review eligibility status
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
// Check if current user can review an order
router.get('/can-review/:orderId', authenticateCustomer, async (req, res) => {
  try {
    const { orderId } = req.params;

    // Fetch the order
    const { data: order, error: orderError } = await supabaseAdmin
      .from('marketplace_orders')
      .select('id, buyer_id, payment_status')
      .eq('id', orderId)
      .single();

    if (orderError || !order) {
      return res.json({ canReview: false, reason: 'Order not found' });
    }

    // Check buyer matches
    if (order.buyer_id !== req.customer.id) {
      return res.json({ canReview: false, reason: 'Only the buyer can review this order' });
    }

    // Check payment completed
    if (order.payment_status !== 'completed') {
      return res.json({ canReview: false, reason: 'Order payment has not been completed' });
    }

    // Check if review already exists
    const { data: existingReview } = await supabaseAdmin
      .from('marketplace_reviews')
      .select('id')
      .eq('order_id', orderId)
      .single();

    if (existingReview) {
      return res.json({ canReview: false, reason: 'A review has already been submitted for this order' });
    }

    res.json({ canReview: true });
  } catch (error) {
    console.error('Can review check error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
