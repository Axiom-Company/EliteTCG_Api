import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';
import {
  sendSubscriptionBoxShipped,
} from '../utils/email.js';

const router = Router();

// All admin subscription routes require admin authentication
router.use(authenticateToken);

// ============================================
// TIER MANAGEMENT
// ============================================

/**
 * GET /api/admin/subscriptions/tiers
 * List all tiers (including inactive) for admin
 */
router.get('/tiers', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const { data, error } = await supabaseAdmin
      .from('subscription_tiers')
      .select('*')
      .order('display_order', { ascending: true });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch tiers' });
    }

    res.json({ tiers: data || [] });
  } catch (error) {
    console.error('Admin get tiers error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Validation: create/update tier
const tierSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100),
  description: z.string().optional(),
  short_description: z.string().max(500).optional(),
  price: z.number().positive(),
  compare_at_price: z.number().positive().nullable().optional(),
  includes: z.array(z.object({
    label: z.string(),
    icon: z.string().optional(),
  })).optional(),
  guaranteed_value: z.number().positive().nullable().optional(),
  pack_count: z.number().int().positive().optional(),
  guaranteed_single_min_value: z.number().positive().nullable().optional(),
  image_url: z.string().url().nullable().optional(),
  badge: z.string().max(50).nullable().optional(),
  max_subscribers: z.number().int().positive().nullable().optional(),
  is_active: z.boolean().optional(),
  display_order: z.number().int().optional(),
});

/**
 * POST /api/admin/subscriptions/tiers
 * Create a new subscription tier
 */
router.post('/tiers', requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const validation = tierSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    const { data, error } = await supabaseAdmin
      .from('subscription_tiers')
      .insert(validation.data)
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'A tier with this slug already exists' });
      }
      console.error('Create tier error:', error);
      return res.status(500).json({ error: 'Failed to create tier' });
    }

    res.status(201).json({ tier: data });
  } catch (error) {
    console.error('Admin create tier error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/admin/subscriptions/tiers/:id
 * Update a subscription tier
 */
router.put('/tiers/:id', requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const { id } = req.params;
    const validation = tierSchema.partial().safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    const { data, error } = await supabaseAdmin
      .from('subscription_tiers')
      .update(validation.data)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to update tier' });
    }

    if (!data) {
      return res.status(404).json({ error: 'Tier not found' });
    }

    res.json({ tier: data });
  } catch (error) {
    console.error('Admin update tier error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/admin/subscriptions/tiers/:id
 * Deactivate a tier (soft delete)
 */
router.delete('/tiers/:id', requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const { id } = req.params;

    // Check for active subscribers
    const { data: activeSubs } = await supabaseAdmin
      .from('subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('tier_id', id)
      .in('status', ['active', 'paused']);

    if (activeSubs && activeSubs.length > 0) {
      return res.status(409).json({
        error: 'Cannot deactivate tier with active subscribers. Please migrate them first.',
      });
    }

    const { error } = await supabaseAdmin
      .from('subscription_tiers')
      .update({ is_active: false })
      .eq('id', id);

    if (error) {
      return res.status(500).json({ error: 'Failed to deactivate tier' });
    }

    res.json({ message: 'Tier deactivated' });
  } catch (error) {
    console.error('Admin delete tier error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// SUBSCRIPTION MANAGEMENT
// ============================================

/**
 * GET /api/admin/subscriptions
 * List all subscriptions with filters
 */
router.get('/', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const { status, tier_id, search, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabaseAdmin
      .from('subscriptions')
      .select(`
        *,
        tier:subscription_tiers(id, name, slug, price),
        customer:customers(id, email, name, first_name, last_name, phone)
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (status) query = query.eq('status', status);
    if (tier_id) query = query.eq('tier_id', tier_id);

    const { data, error, count } = await query;

    if (error) {
      console.error('Admin fetch subscriptions error:', error);
      return res.status(500).json({ error: 'Failed to fetch subscriptions' });
    }

    // Client-side search filtering (Supabase doesn't support join filters easily)
    let results = data || [];
    if (search) {
      const q = search.toLowerCase();
      results = results.filter(s =>
        s.subscription_number?.toLowerCase().includes(q) ||
        s.customer?.email?.toLowerCase().includes(q) ||
        s.customer?.name?.toLowerCase().includes(q)
      );
    }

    res.json({
      subscriptions: results,
      pagination: {
        total: count || 0,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil((count || 0) / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Admin get subscriptions error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/admin/subscriptions/stats
 * Subscription dashboard stats
 */
router.get('/stats', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    // Get subscription counts by status
    const { data: allSubs } = await supabaseAdmin
      .from('subscriptions')
      .select('id, status, monthly_amount, tier_id');

    const subs = allSubs || [];
    const active = subs.filter(s => s.status === 'active');
    const paused = subs.filter(s => s.status === 'paused');
    const cancelled = subs.filter(s => s.status === 'cancelled');

    // Monthly recurring revenue (MRR)
    const mrr = active.reduce((sum, s) => sum + parseFloat(s.monthly_amount || 0), 0);

    // Subscribers by tier
    const { data: tiers } = await supabaseAdmin
      .from('subscription_tiers')
      .select('id, name, price, current_subscribers');

    // Boxes pending fulfillment
    const { data: pendingBoxes, count: pendingCount } = await supabaseAdmin
      .from('subscription_boxes')
      .select('id', { count: 'exact', head: true })
      .in('status', ['pending', 'curating', 'packed'])
      .eq('payment_status', 'completed');

    // Revenue from subscriptions this month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { data: monthPayments } = await supabaseAdmin
      .from('subscription_payments')
      .select('amount')
      .eq('status', 'completed')
      .gte('paid_at', startOfMonth.toISOString());

    const monthRevenue = (monthPayments || []).reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);

    res.json({
      stats: {
        total_subscribers: subs.length,
        active_subscribers: active.length,
        paused_subscribers: paused.length,
        cancelled_subscribers: cancelled.length,
        monthly_recurring_revenue: mrr,
        revenue_this_month: monthRevenue,
        boxes_pending_fulfillment: pendingCount || 0,
      },
      tiers: tiers || [],
    });
  } catch (error) {
    console.error('Admin subscription stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/admin/subscriptions/:id
 * Get single subscription detail
 */
router.get('/:id', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const { id } = req.params;

    // Avoid matching the /stats route
    if (id === 'stats' || id === 'tiers' || id === 'boxes' || id === 'generate-boxes') {
      return res.status(404).json({ error: 'Not found' });
    }

    const { data, error } = await supabaseAdmin
      .from('subscriptions')
      .select(`
        *,
        tier:subscription_tiers(*),
        customer:customers(id, email, name, first_name, last_name, phone, city, state, postal_code)
      `)
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    // Get boxes for this subscription
    const { data: boxes } = await supabaseAdmin
      .from('subscription_boxes')
      .select('*')
      .eq('subscription_id', id)
      .order('billing_month', { ascending: false });

    // Get payments
    const { data: payments } = await supabaseAdmin
      .from('subscription_payments')
      .select('*')
      .eq('subscription_id', id)
      .order('created_at', { ascending: false });

    res.json({
      subscription: data,
      boxes: boxes || [],
      payments: payments || [],
    });
  } catch (error) {
    console.error('Admin get subscription error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// BOX MANAGEMENT & CURATION
// ============================================

/**
 * GET /api/admin/subscriptions/boxes
 * List all subscription boxes with filters
 */
router.get('/boxes', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const { status, billing_month, tier_id, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabaseAdmin
      .from('subscription_boxes')
      .select(`
        *,
        tier:subscription_tiers(id, name, slug),
        customer:customers(id, email, name),
        items:subscription_box_items(*)
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (status) query = query.eq('status', status);
    if (billing_month) query = query.eq('billing_month', billing_month);
    if (tier_id) query = query.eq('tier_id', tier_id);

    const { data, error, count } = await query;

    if (error) {
      console.error('Admin fetch boxes error:', error);
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
    console.error('Admin get boxes error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/admin/subscriptions/generate-boxes
 * Generate monthly boxes for all active subscriptions
 * Called at the start of each billing cycle
 */
router.post('/generate-boxes', requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const { billing_month } = req.body;
    if (!billing_month) {
      return res.status(400).json({ error: 'billing_month is required (YYYY-MM-DD format, e.g. 2026-03-01)' });
    }

    // Get all active subscriptions
    const { data: activeSubs, error: subsError } = await supabaseAdmin
      .from('subscriptions')
      .select('*, tier:subscription_tiers(id, name, price)')
      .eq('status', 'active');

    if (subsError) {
      return res.status(500).json({ error: 'Failed to fetch subscriptions' });
    }

    if (!activeSubs || activeSubs.length === 0) {
      return res.json({ message: 'No active subscriptions', boxes_created: 0 });
    }

    // Check which subscriptions already have boxes for this month
    const { data: existingBoxes } = await supabaseAdmin
      .from('subscription_boxes')
      .select('subscription_id')
      .eq('billing_month', billing_month);

    const existingSubIds = new Set((existingBoxes || []).map(b => b.subscription_id));

    // Create boxes for subscriptions that don't have one yet
    const newBoxes = activeSubs
      .filter(sub => !existingSubIds.has(sub.id))
      .map(sub => ({
        id: uuidv4(),
        box_number: `BOX-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
        subscription_id: sub.id,
        customer_id: sub.customer_id,
        tier_id: sub.tier_id,
        billing_month,
        status: 'pending',
        amount_charged: sub.monthly_amount,
        payment_status: 'pending',
        shipping_address: sub.shipping_address,
      }));

    if (newBoxes.length === 0) {
      return res.json({ message: 'All boxes already generated for this month', boxes_created: 0 });
    }

    const { data: created, error: insertError } = await supabaseAdmin
      .from('subscription_boxes')
      .insert(newBoxes)
      .select();

    if (insertError) {
      console.error('Generate boxes error:', insertError);
      return res.status(500).json({ error: 'Failed to generate boxes' });
    }

    res.json({
      message: `Generated ${created.length} subscription boxes for ${billing_month}`,
      boxes_created: created.length,
      boxes: created,
    });
  } catch (error) {
    console.error('Generate boxes error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/admin/subscriptions/boxes/:id
 * Get single box detail with items
 */
router.get('/boxes/:id', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const { id } = req.params;

    const { data, error } = await supabaseAdmin
      .from('subscription_boxes')
      .select(`
        *,
        tier:subscription_tiers(*),
        customer:customers(id, email, name, first_name, last_name, phone),
        subscription:subscriptions(id, subscription_number),
        items:subscription_box_items(*)
      `)
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Box not found' });
    }

    res.json({ box: data });
  } catch (error) {
    console.error('Admin get box error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/admin/subscriptions/boxes/:id/items
 * Add items to a subscription box (curation)
 */
router.post('/boxes/:id/items', requireRole('super_admin', 'admin', 'manager'), async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const { id } = req.params;
    const itemSchema = z.object({
      item_type: z.enum(['booster_pack', 'single_card', 'accessory', 'exclusive', 'bonus']),
      name: z.string().min(1).max(255),
      description: z.string().max(500).optional(),
      product_id: z.string().uuid().nullable().optional(),
      set_id: z.string().uuid().nullable().optional(),
      quantity: z.number().int().positive().default(1),
      unit_value: z.number().positive().nullable().optional(),
      image_url: z.string().url().nullable().optional(),
    });

    const itemsSchema = z.object({
      items: z.array(itemSchema).min(1),
    });

    const validation = itemsSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    // Verify box exists
    const { data: box } = await supabaseAdmin
      .from('subscription_boxes')
      .select('id, status')
      .eq('id', id)
      .single();

    if (!box) {
      return res.status(404).json({ error: 'Box not found' });
    }

    // Add items with calculated total_value
    const itemsToInsert = validation.data.items.map(item => ({
      box_id: id,
      item_type: item.item_type,
      name: item.name,
      description: item.description || null,
      product_id: item.product_id || null,
      set_id: item.set_id || null,
      quantity: item.quantity,
      unit_value: item.unit_value || null,
      total_value: item.unit_value ? item.unit_value * item.quantity : null,
      image_url: item.image_url || null,
    }));

    const { data: inserted, error } = await supabaseAdmin
      .from('subscription_box_items')
      .insert(itemsToInsert)
      .select();

    if (error) {
      console.error('Add box items error:', error);
      return res.status(500).json({ error: 'Failed to add items' });
    }

    // Update box status to curating if it was pending
    if (box.status === 'pending') {
      await supabaseAdmin
        .from('subscription_boxes')
        .update({ status: 'curating' })
        .eq('id', id);
    }

    res.status(201).json({ items: inserted });
  } catch (error) {
    console.error('Admin add box items error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/admin/subscriptions/boxes/:boxId/items/:itemId
 * Remove an item from a box
 */
router.delete('/boxes/:boxId/items/:itemId', requireRole('super_admin', 'admin', 'manager'), async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const { boxId, itemId } = req.params;

    const { error } = await supabaseAdmin
      .from('subscription_box_items')
      .delete()
      .eq('id', itemId)
      .eq('box_id', boxId);

    if (error) {
      return res.status(500).json({ error: 'Failed to remove item' });
    }

    res.json({ message: 'Item removed from box' });
  } catch (error) {
    console.error('Admin remove box item error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/admin/subscriptions/boxes/:id/curate-bulk
 * Bulk curate: apply the same items to all boxes of a specific tier for a billing month
 */
router.post('/boxes/:id/curate-bulk', requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const templateBoxId = req.params.id;

    // Get the template box and its items
    const { data: templateBox } = await supabaseAdmin
      .from('subscription_boxes')
      .select('id, tier_id, billing_month')
      .eq('id', templateBoxId)
      .single();

    if (!templateBox) {
      return res.status(404).json({ error: 'Template box not found' });
    }

    const { data: templateItems } = await supabaseAdmin
      .from('subscription_box_items')
      .select('item_type, name, description, product_id, set_id, quantity, unit_value, total_value, image_url')
      .eq('box_id', templateBoxId);

    if (!templateItems || templateItems.length === 0) {
      return res.status(400).json({ error: 'Template box has no items. Curate it first.' });
    }

    // Get all boxes for the same tier and month that don't have items
    const { data: targetBoxes } = await supabaseAdmin
      .from('subscription_boxes')
      .select('id')
      .eq('tier_id', templateBox.tier_id)
      .eq('billing_month', templateBox.billing_month)
      .neq('id', templateBoxId);

    if (!targetBoxes || targetBoxes.length === 0) {
      return res.json({ message: 'No other boxes to curate', boxes_curated: 0 });
    }

    // Create items for each target box
    const allItems = [];
    for (const box of targetBoxes) {
      for (const item of templateItems) {
        allItems.push({
          box_id: box.id,
          ...item,
        });
      }
    }

    const { error: insertError } = await supabaseAdmin
      .from('subscription_box_items')
      .insert(allItems);

    if (insertError) {
      console.error('Bulk curate error:', insertError);
      return res.status(500).json({ error: 'Failed to bulk curate boxes' });
    }

    // Update all target boxes status to curating
    const targetIds = targetBoxes.map(b => b.id);
    await supabaseAdmin
      .from('subscription_boxes')
      .update({ status: 'curating' })
      .in('id', targetIds)
      .eq('status', 'pending');

    res.json({
      message: `Curated ${targetBoxes.length} boxes with ${templateItems.length} items each`,
      boxes_curated: targetBoxes.length,
    });
  } catch (error) {
    console.error('Bulk curate error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// FULFILLMENT
// ============================================

/**
 * PATCH /api/admin/subscriptions/boxes/:id/status
 * Update box status (packed, shipped, delivered)
 */
router.patch('/boxes/:id/status', requireRole('super_admin', 'admin', 'manager', 'staff'), async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const { id } = req.params;
    const { status, tracking_number, shipping_carrier, notes } = req.body;

    const validStatuses = ['pending', 'curating', 'packed', 'shipped', 'delivered', 'cancelled'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    const { data: box } = await supabaseAdmin
      .from('subscription_boxes')
      .select('*, customer:customers(id, email, name)')
      .eq('id', id)
      .single();

    if (!box) {
      return res.status(404).json({ error: 'Box not found' });
    }

    const updates = { status };

    if (status === 'shipped') {
      updates.shipped_at = new Date().toISOString();
      if (tracking_number) updates.tracking_number = tracking_number;
      if (shipping_carrier) updates.shipping_carrier = shipping_carrier;
    }

    if (status === 'delivered') {
      updates.delivered_at = new Date().toISOString();
    }

    if (notes !== undefined) {
      updates.notes = notes;
    }

    const { data: updated, error } = await supabaseAdmin
      .from('subscription_boxes')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to update box status' });
    }

    // Send shipping notification email
    if (status === 'shipped' && box.customer) {
      sendSubscriptionBoxShipped(
        box.customer.email,
        box.customer.name,
        box.box_number,
        tracking_number || null
      ).catch(err => console.error('Box shipped email error:', err));
    }

    res.json({ box: updated });
  } catch (error) {
    console.error('Admin update box status error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/admin/subscriptions/boxes/bulk-ship
 * Bulk ship multiple boxes
 */
router.post('/boxes/bulk-ship', requireRole('super_admin', 'admin', 'manager'), async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database connection required' });
    }

    const bulkSchema = z.object({
      shipments: z.array(z.object({
        box_id: z.string().uuid(),
        tracking_number: z.string().min(1),
        shipping_carrier: z.string().default('courier_guy'),
      })).min(1),
    });

    const validation = bulkSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    const results = [];
    const now = new Date().toISOString();

    for (const shipment of validation.data.shipments) {
      const { data: box, error } = await supabaseAdmin
        .from('subscription_boxes')
        .update({
          status: 'shipped',
          tracking_number: shipment.tracking_number,
          shipping_carrier: shipment.shipping_carrier,
          shipped_at: now,
        })
        .eq('id', shipment.box_id)
        .eq('status', 'packed')
        .select('*, customer:customers(id, email, name)')
        .single();

      if (error || !box) {
        results.push({ box_id: shipment.box_id, success: false, error: 'Box not found or not in packed status' });
        continue;
      }

      results.push({ box_id: shipment.box_id, success: true, tracking_number: shipment.tracking_number });

      // Send email
      if (box.customer) {
        sendSubscriptionBoxShipped(
          box.customer.email,
          box.customer.name,
          box.box_number,
          shipment.tracking_number
        ).catch(err => console.error('Bulk ship email error:', err));
      }
    }

    const shipped = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    res.json({
      message: `Shipped ${shipped} boxes, ${failed} failed`,
      results,
    });
  } catch (error) {
    console.error('Bulk ship error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
