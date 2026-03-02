import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { authenticateCustomer, optionalCustomerAuth } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';
import PayFast from '../utils/payfast.js';
import {
  sendSubscriptionConfirmation,
  sendSubscriptionCancelled,
  sendSubscriptionBoxShipped,
} from '../utils/email.js';

const router = Router();

// Generate subscription number
function generateSubscriptionNumber() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `SUB-${timestamp}-${random}`;
}

// Generate box number
function generateBoxNumber() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `BOX-${timestamp}-${random}`;
}

// ============================================
// PUBLIC ENDPOINTS
// ============================================

/**
 * GET /api/subscriptions/tiers
 * List all active subscription tiers (public)
 */
router.get('/tiers', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const { data, error } = await supabaseAdmin
      .from('subscription_tiers')
      .select('id, name, slug, description, short_description, price, compare_at_price, includes, guaranteed_value, pack_count, guaranteed_single_min_value, image_url, badge, max_subscribers, current_subscribers, display_order')
      .eq('is_active', true)
      .order('display_order', { ascending: true });

    if (error) {
      console.error('Fetch tiers error:', error);
      return res.status(500).json({ error: 'Failed to fetch subscription tiers' });
    }

    // Add availability flag
    const tiers = data.map(tier => ({
      ...tier,
      is_available: tier.max_subscribers === null || tier.current_subscribers < tier.max_subscribers,
    }));

    res.json({ tiers });
  } catch (error) {
    console.error('Get tiers error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/subscriptions/tiers/:slug
 * Get a single tier by slug (public)
 */
router.get('/tiers/:slug', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const { slug } = req.params;

    const { data, error } = await supabaseAdmin
      .from('subscription_tiers')
      .select('*')
      .eq('slug', slug)
      .eq('is_active', true)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Subscription tier not found' });
    }

    res.json({
      tier: {
        ...data,
        is_available: data.max_subscribers === null || data.current_subscribers < data.max_subscribers,
      },
    });
  } catch (error) {
    console.error('Get tier error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// CUSTOMER ENDPOINTS (Authenticated)
// ============================================

// Validation: subscribe
const subscribeSchema = z.object({
  tier_id: z.string().uuid(),
  shipping_address: z.object({
    first_name: z.string().min(1),
    last_name: z.string().min(1),
    email: z.string().email(),
    phone: z.string().min(1),
    street_address: z.string().min(1),
    apartment: z.string().nullable().optional(),
    city: z.string().min(1),
    province: z.string().min(1),
    postal_code: z.string().min(1),
    country: z.string().default('South Africa'),
  }),
  billing_day: z.number().int().min(1).max(28).default(1),
});

/**
 * POST /api/subscriptions/subscribe
 * Create a new subscription and redirect to payment
 */
router.post('/subscribe', authenticateCustomer, async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const validation = subscribeSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors,
      });
    }

    const { tier_id, shipping_address, billing_day } = validation.data;

    // Get the tier
    const { data: tier, error: tierError } = await supabaseAdmin
      .from('subscription_tiers')
      .select('*')
      .eq('id', tier_id)
      .eq('is_active', true)
      .single();

    if (tierError || !tier) {
      return res.status(404).json({ error: 'Subscription tier not found' });
    }

    // Check availability
    if (tier.max_subscribers !== null && tier.current_subscribers >= tier.max_subscribers) {
      return res.status(409).json({ error: 'This subscription tier is currently full' });
    }

    // Check if customer already has an active subscription for this tier
    const { data: existing } = await supabaseAdmin
      .from('subscriptions')
      .select('id')
      .eq('customer_id', req.customer.id)
      .eq('tier_id', tier_id)
      .in('status', ['active', 'paused'])
      .single();

    if (existing) {
      return res.status(409).json({ error: 'You already have an active subscription for this tier' });
    }

    // Get customer details
    const { data: customer } = await supabaseAdmin
      .from('customers')
      .select('email, name, first_name, last_name, phone')
      .eq('id', req.customer.id)
      .single();

    // Calculate billing dates
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), billing_day);
    if (periodStart < now) {
      periodStart.setMonth(periodStart.getMonth() + 1);
    }
    const periodEnd = new Date(periodStart);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    // Create subscription
    const subscriptionData = {
      id: uuidv4(),
      subscription_number: generateSubscriptionNumber(),
      customer_id: req.customer.id,
      tier_id: tier.id,
      status: 'active',
      monthly_amount: tier.price,
      currency: 'ZAR',
      current_period_start: periodStart.toISOString(),
      current_period_end: periodEnd.toISOString(),
      next_billing_date: periodStart.toISOString(),
      billing_day,
      shipping_address,
      started_at: now.toISOString(),
    };

    const { data: subscription, error: subError } = await supabaseAdmin
      .from('subscriptions')
      .insert(subscriptionData)
      .select()
      .single();

    if (subError) {
      console.error('Create subscription error:', subError);
      return res.status(500).json({ error: 'Failed to create subscription' });
    }

    // Create the first monthly box
    const billingMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const boxData = {
      id: uuidv4(),
      box_number: generateBoxNumber(),
      subscription_id: subscription.id,
      customer_id: req.customer.id,
      tier_id: tier.id,
      billing_month: billingMonth.toISOString().split('T')[0],
      status: 'pending',
      amount_charged: tier.price,
      payment_status: 'pending',
      shipping_address,
    };

    const { data: box, error: boxError } = await supabaseAdmin
      .from('subscription_boxes')
      .insert(boxData)
      .select()
      .single();

    if (boxError) {
      console.error('Create first box error:', boxError);
    }

    // Generate PayFast payment for first month
    const buyer = {
      first_name: shipping_address.first_name || customer?.first_name || 'Customer',
      last_name: shipping_address.last_name || customer?.last_name || '',
      email: shipping_address.email || customer?.email,
      phone: shipping_address.phone || customer?.phone,
    };

    const paymentData = PayFast.generateSubscriptionPaymentData(subscription, tier, buyer, box?.id);

    res.status(201).json({
      subscription: {
        id: subscription.id,
        subscription_number: subscription.subscription_number,
        tier_name: tier.name,
        monthly_amount: subscription.monthly_amount,
        status: subscription.status,
        next_billing_date: subscription.next_billing_date,
      },
      first_box: box ? {
        id: box.id,
        box_number: box.box_number,
        billing_month: box.billing_month,
      } : null,
      payment: {
        url: PayFast.buildPaymentUrl(paymentData),
        data: paymentData,
      },
    });
  } catch (error) {
    console.error('Subscribe error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/subscriptions/my
 * Get all subscriptions for the authenticated customer
 */
router.get('/my', authenticateCustomer, async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const { data, error } = await supabaseAdmin
      .from('subscriptions')
      .select(`
        *,
        tier:subscription_tiers(id, name, slug, price, image_url, badge, includes)
      `)
      .eq('customer_id', req.customer.id)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Fetch subscriptions error:', error);
      return res.status(500).json({ error: 'Failed to fetch subscriptions' });
    }

    res.json({ subscriptions: data || [] });
  } catch (error) {
    console.error('Get subscriptions error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/subscriptions/my/:id
 * Get single subscription detail
 */
router.get('/my/:id', authenticateCustomer, async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const { id } = req.params;

    const { data, error } = await supabaseAdmin
      .from('subscriptions')
      .select(`
        *,
        tier:subscription_tiers(*)
      `)
      .eq('id', id)
      .eq('customer_id', req.customer.id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    res.json({ subscription: data });
  } catch (error) {
    console.error('Get subscription error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/subscriptions/my/:id/pause
 * Pause a subscription
 */
router.patch('/my/:id/pause', authenticateCustomer, async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const { id } = req.params;

    const { data: sub, error: fetchError } = await supabaseAdmin
      .from('subscriptions')
      .select('id, status')
      .eq('id', id)
      .eq('customer_id', req.customer.id)
      .single();

    if (fetchError || !sub) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    if (sub.status !== 'active') {
      return res.status(400).json({ error: `Cannot pause subscription with status: ${sub.status}` });
    }

    const { error } = await supabaseAdmin
      .from('subscriptions')
      .update({
        status: 'paused',
        paused_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) {
      return res.status(500).json({ error: 'Failed to pause subscription' });
    }

    res.json({ message: 'Subscription paused successfully' });
  } catch (error) {
    console.error('Pause subscription error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/subscriptions/my/:id/resume
 * Resume a paused subscription
 */
router.patch('/my/:id/resume', authenticateCustomer, async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const { id } = req.params;

    const { data: sub, error: fetchError } = await supabaseAdmin
      .from('subscriptions')
      .select('id, status, billing_day')
      .eq('id', id)
      .eq('customer_id', req.customer.id)
      .single();

    if (fetchError || !sub) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    if (sub.status !== 'paused') {
      return res.status(400).json({ error: `Cannot resume subscription with status: ${sub.status}` });
    }

    // Calculate next billing date from now
    const now = new Date();
    const nextBilling = new Date(now.getFullYear(), now.getMonth(), sub.billing_day);
    if (nextBilling <= now) {
      nextBilling.setMonth(nextBilling.getMonth() + 1);
    }

    const periodEnd = new Date(nextBilling);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    const { error } = await supabaseAdmin
      .from('subscriptions')
      .update({
        status: 'active',
        paused_at: null,
        current_period_start: nextBilling.toISOString(),
        current_period_end: periodEnd.toISOString(),
        next_billing_date: nextBilling.toISOString(),
      })
      .eq('id', id);

    if (error) {
      return res.status(500).json({ error: 'Failed to resume subscription' });
    }

    res.json({
      message: 'Subscription resumed successfully',
      next_billing_date: nextBilling.toISOString(),
    });
  } catch (error) {
    console.error('Resume subscription error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/subscriptions/my/:id/cancel
 * Cancel a subscription (stays active until current period ends)
 */
router.patch('/my/:id/cancel', authenticateCustomer, async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const { id } = req.params;
    const { reason } = req.body || {};

    const { data: sub, error: fetchError } = await supabaseAdmin
      .from('subscriptions')
      .select('id, status, current_period_end, subscription_number, monthly_amount, customer_id, tier_id')
      .eq('id', id)
      .eq('customer_id', req.customer.id)
      .single();

    if (fetchError || !sub) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    if (sub.status === 'cancelled') {
      return res.status(400).json({ error: 'Subscription is already cancelled' });
    }

    const { error } = await supabaseAdmin
      .from('subscriptions')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancellation_reason: reason || null,
        expires_at: sub.current_period_end,
      })
      .eq('id', id);

    if (error) {
      return res.status(500).json({ error: 'Failed to cancel subscription' });
    }

    // Get customer for email
    const { data: customer } = await supabaseAdmin
      .from('customers')
      .select('email, name')
      .eq('id', req.customer.id)
      .single();

    if (customer) {
      sendSubscriptionCancelled(
        customer.email,
        customer.name,
        sub.subscription_number,
        sub.current_period_end
      ).catch(err => console.error('Cancel email error:', err));
    }

    res.json({
      message: 'Subscription cancelled. You will still receive your box for the current billing period.',
      expires_at: sub.current_period_end,
    });
  } catch (error) {
    console.error('Cancel subscription error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/subscriptions/my/:id/shipping
 * Update shipping address for a subscription
 */
router.put('/my/:id/shipping', authenticateCustomer, async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const { id } = req.params;
    const addressSchema = z.object({
      first_name: z.string().min(1),
      last_name: z.string().min(1),
      email: z.string().email(),
      phone: z.string().min(1),
      street_address: z.string().min(1),
      apartment: z.string().nullable().optional(),
      city: z.string().min(1),
      province: z.string().min(1),
      postal_code: z.string().min(1),
      country: z.string().default('South Africa'),
    });

    const validation = addressSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    // Verify ownership
    const { data: sub } = await supabaseAdmin
      .from('subscriptions')
      .select('id')
      .eq('id', id)
      .eq('customer_id', req.customer.id)
      .single();

    if (!sub) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    const { error } = await supabaseAdmin
      .from('subscriptions')
      .update({ shipping_address: validation.data })
      .eq('id', id);

    if (error) {
      return res.status(500).json({ error: 'Failed to update shipping address' });
    }

    res.json({ message: 'Shipping address updated' });
  } catch (error) {
    console.error('Update shipping error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/subscriptions/my/:id/change-tier
 * Change subscription tier (takes effect next billing cycle)
 */
router.patch('/my/:id/change-tier', authenticateCustomer, async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const { id } = req.params;
    const { tier_id } = req.body;

    if (!tier_id) {
      return res.status(400).json({ error: 'tier_id is required' });
    }

    // Get current subscription
    const { data: sub, error: fetchError } = await supabaseAdmin
      .from('subscriptions')
      .select('id, status, tier_id')
      .eq('id', id)
      .eq('customer_id', req.customer.id)
      .single();

    if (fetchError || !sub) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    if (sub.status !== 'active') {
      return res.status(400).json({ error: 'Can only change tier on active subscriptions' });
    }

    if (sub.tier_id === tier_id) {
      return res.status(400).json({ error: 'Already on this tier' });
    }

    // Verify new tier exists and is available
    const { data: newTier, error: tierError } = await supabaseAdmin
      .from('subscription_tiers')
      .select('id, name, price, max_subscribers, current_subscribers')
      .eq('id', tier_id)
      .eq('is_active', true)
      .single();

    if (tierError || !newTier) {
      return res.status(404).json({ error: 'Target tier not found' });
    }

    if (newTier.max_subscribers !== null && newTier.current_subscribers >= newTier.max_subscribers) {
      return res.status(409).json({ error: 'Target tier is currently full' });
    }

    const { error } = await supabaseAdmin
      .from('subscriptions')
      .update({
        tier_id: newTier.id,
        monthly_amount: newTier.price,
      })
      .eq('id', id);

    if (error) {
      return res.status(500).json({ error: 'Failed to change tier' });
    }

    res.json({
      message: `Subscription changed to ${newTier.name}. New price: R${newTier.price}/month. Takes effect from next billing cycle.`,
      new_tier: newTier.name,
      new_amount: newTier.price,
    });
  } catch (error) {
    console.error('Change tier error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// BOX HISTORY ENDPOINTS
// ============================================

/**
 * GET /api/subscriptions/my/boxes
 * Get all subscription boxes for the customer
 */
router.get('/my/boxes', authenticateCustomer, async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const { status, page = 1, limit = 12 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabaseAdmin
      .from('subscription_boxes')
      .select(`
        *,
        tier:subscription_tiers(id, name, slug, image_url),
        items:subscription_box_items(*)
      `, { count: 'exact' })
      .eq('customer_id', req.customer.id)
      .order('billing_month', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error, count } = await query;

    if (error) {
      console.error('Fetch boxes error:', error);
      return res.status(500).json({ error: 'Failed to fetch boxes' });
    }

    res.json({
      boxes: data || [],
      pagination: {
        total: count || 0,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil((count || 0) / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Get boxes error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/subscriptions/my/boxes/:id
 * Get single box detail with items
 */
router.get('/my/boxes/:id', authenticateCustomer, async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const { id } = req.params;

    const { data, error } = await supabaseAdmin
      .from('subscription_boxes')
      .select(`
        *,
        tier:subscription_tiers(id, name, slug, image_url, includes),
        items:subscription_box_items(*)
      `)
      .eq('id', id)
      .eq('customer_id', req.customer.id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Box not found' });
    }

    res.json({ box: data });
  } catch (error) {
    console.error('Get box error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/subscriptions/my/boxes/:id/rate
 * Rate a delivered subscription box
 */
router.post('/my/boxes/:id/rate', authenticateCustomer, async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const { id } = req.params;
    const ratingSchema = z.object({
      rating: z.number().int().min(1).max(5),
      feedback: z.string().max(1000).optional(),
    });

    const validation = ratingSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    const { data: box } = await supabaseAdmin
      .from('subscription_boxes')
      .select('id, status')
      .eq('id', id)
      .eq('customer_id', req.customer.id)
      .single();

    if (!box) {
      return res.status(404).json({ error: 'Box not found' });
    }

    if (box.status !== 'delivered' && box.status !== 'shipped') {
      return res.status(400).json({ error: 'Can only rate shipped or delivered boxes' });
    }

    const { error } = await supabaseAdmin
      .from('subscription_boxes')
      .update({
        rating: validation.data.rating,
        feedback: validation.data.feedback || null,
      })
      .eq('id', id);

    if (error) {
      return res.status(500).json({ error: 'Failed to rate box' });
    }

    res.json({ message: 'Thank you for your feedback!' });
  } catch (error) {
    console.error('Rate box error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/subscriptions/my/payments
 * Get payment history for all subscriptions
 */
router.get('/my/payments', authenticateCustomer, async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const { data, error } = await supabaseAdmin
      .from('subscription_payments')
      .select(`
        *,
        subscription:subscriptions(subscription_number, tier:subscription_tiers(name))
      `)
      .in('subscription_id', supabaseAdmin
        .from('subscriptions')
        .select('id')
        .eq('customer_id', req.customer.id)
      )
      .order('created_at', { ascending: false });

    // Fallback approach if subquery doesn't work
    if (error) {
      // Get subscription IDs first, then payments
      const { data: subs } = await supabaseAdmin
        .from('subscriptions')
        .select('id')
        .eq('customer_id', req.customer.id);

      if (!subs || subs.length === 0) {
        return res.json({ payments: [] });
      }

      const subIds = subs.map(s => s.id);
      const { data: payments, error: payError } = await supabaseAdmin
        .from('subscription_payments')
        .select('*')
        .in('subscription_id', subIds)
        .order('created_at', { ascending: false });

      if (payError) {
        return res.status(500).json({ error: 'Failed to fetch payments' });
      }

      return res.json({ payments: payments || [] });
    }

    res.json({ payments: data || [] });
  } catch (error) {
    console.error('Get payments error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// PAYFAST ITN WEBHOOK FOR SUBSCRIPTIONS
// ============================================

/**
 * POST /api/subscriptions/notify
 * PayFast ITN webhook for subscription payments
 */
router.post('/notify', async (req, res) => {
  try {
    const pfData = req.body;
    console.log('Subscription ITN received:', pfData);

    // Validate source IP in production
    if (process.env.NODE_ENV === 'production') {
      const sourceIP = req.ip || req.connection?.remoteAddress;
      if (!PayFast.validateIP(sourceIP)) {
        console.warn('Invalid PayFast IP:', sourceIP);
        return res.status(403).send('Invalid source IP');
      }
    }

    // Verify signature
    if (!PayFast.verifySignature(pfData, pfData.signature, PayFast.config.passphrase)) {
      console.warn('Invalid PayFast signature');
      return res.status(400).send('Invalid signature');
    }

    if (!supabaseAdmin) {
      console.log('ITN received but no database');
      return res.status(200).send('OK');
    }

    const subscriptionId = pfData.custom_str1;
    const boxId = pfData.custom_str2;

    if (!subscriptionId) {
      console.error('No subscription ID in ITN');
      return res.status(400).send('Missing subscription ID');
    }

    // Get subscription
    const { data: subscription, error: subError } = await supabaseAdmin
      .from('subscriptions')
      .select('*, tier:subscription_tiers(name)')
      .eq('id', subscriptionId)
      .single();

    if (subError || !subscription) {
      console.error('Subscription not found:', subscriptionId);
      return res.status(404).send('Subscription not found');
    }

    const paymentStatus = pfData.payment_status;

    if (paymentStatus === 'COMPLETE') {
      // Store PayFast token for future recurring charges
      const updates = {
        payment_status: 'completed',
        payfast_payment_id: pfData.pf_payment_id,
      };

      if (pfData.token) {
        updates.payfast_token = pfData.token;
      }

      // Update subscription with PayFast details
      await supabaseAdmin
        .from('subscriptions')
        .update({
          payfast_token: pfData.token || subscription.payfast_token,
          payfast_subscription_id: pfData.pf_payment_id,
        })
        .eq('id', subscriptionId);

      // Update box payment status
      if (boxId) {
        await supabaseAdmin
          .from('subscription_boxes')
          .update({
            payment_status: 'completed',
            payfast_payment_id: pfData.pf_payment_id,
            paid_at: new Date().toISOString(),
          })
          .eq('id', boxId);
      }

      // Record payment
      await supabaseAdmin
        .from('subscription_payments')
        .insert({
          subscription_id: subscriptionId,
          box_id: boxId || null,
          amount: parseFloat(pfData.amount_gross),
          currency: 'ZAR',
          status: 'completed',
          payfast_payment_id: pfData.pf_payment_id,
          billing_month: subscription.current_period_start
            ? new Date(subscription.current_period_start).toISOString().split('T')[0].substring(0, 8) + '01'
            : new Date().toISOString().split('T')[0].substring(0, 8) + '01',
          paid_at: new Date().toISOString(),
        });

      // Send confirmation email
      const { data: customer } = await supabaseAdmin
        .from('customers')
        .select('email, name')
        .eq('id', subscription.customer_id)
        .single();

      if (customer) {
        sendSubscriptionConfirmation(
          customer.email,
          customer.name,
          subscription.subscription_number,
          subscription.tier?.name || 'Subscription Box',
          subscription.monthly_amount
        ).catch(err => console.error('Subscription email error:', err));
      }

      console.log('Subscription payment completed:', subscription.subscription_number);
    } else if (paymentStatus === 'CANCELLED') {
      // Mark payment as failed
      if (boxId) {
        await supabaseAdmin
          .from('subscription_boxes')
          .update({ payment_status: 'failed' })
          .eq('id', boxId);
      }

      // Record failed payment
      await supabaseAdmin
        .from('subscription_payments')
        .insert({
          subscription_id: subscriptionId,
          box_id: boxId || null,
          amount: parseFloat(pfData.amount_gross || 0),
          currency: 'ZAR',
          status: 'failed',
          billing_month: new Date().toISOString().split('T')[0].substring(0, 8) + '01',
          failed_at: new Date().toISOString(),
          failure_reason: 'Payment cancelled by user',
        });

      // Mark subscription as past_due
      await supabaseAdmin
        .from('subscriptions')
        .update({ status: 'past_due' })
        .eq('id', subscriptionId);

      console.log('Subscription payment cancelled:', subscription.subscription_number);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Subscription ITN error:', error);
    res.status(500).send('Server error');
  }
});

// Payment return/cancel URLs
router.get('/payment/success', (req, res) => {
  res.redirect('/subscriptions/payment/success');
});

router.get('/payment/cancel', (req, res) => {
  res.redirect('/subscriptions/payment/cancel');
});

export default router;
