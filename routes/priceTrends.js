import { Router } from 'express';
import { z } from 'zod';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

// ============================================
// VALIDATION SCHEMAS
// ============================================

const createTrackedItemSchema = z.object({
  product_id: z.string().uuid().optional(),
  card_name: z.string().min(1).max(255),
  card_number: z.string().max(20).optional(),
  set_id: z.string().uuid().optional(),
  set_code: z.string().max(10).optional(),
  current_price: z.number().positive(),
  image_url: z.string().url().max(500).optional(),
  is_featured: z.boolean().optional()
});

const updateTrackedItemSchema = createTrackedItemSchema.partial();

const recordPriceSchema = z.object({
  price: z.number().positive(),
  source: z.enum(['manual', 'store', 'marketplace', 'external']).optional(),
  source_details: z.string().max(255).optional()
});

const bulkRecordPriceSchema = z.object({
  prices: z.array(z.object({
    tracked_item_id: z.string().uuid(),
    price: z.number().positive(),
    source: z.enum(['manual', 'store', 'marketplace', 'external']).optional(),
    source_details: z.string().max(255).optional()
  })).min(1).max(100)
});

// ============================================
// PUBLIC ENDPOINTS
// ============================================

// List tracked items with current prices (public)
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const { set_id, set_code, search, sort, featured, direction } = req.query;

    let query = supabaseAdmin
      .from('price_tracked_items')
      .select('*', { count: 'exact' })
      .eq('is_active', true);

    if (set_id) query = query.eq('set_id', set_id);
    if (set_code) query = query.eq('set_code', set_code);
    if (featured === 'true') query = query.eq('is_featured', true);
    if (direction && ['up', 'down', 'stable'].includes(direction)) {
      query = query.eq('price_direction', direction);
    }
    if (search) query = query.ilike('card_name', `%${search}%`);

    // Sorting
    switch (sort) {
      case 'price_high':
        query = query.order('current_price', { ascending: false });
        break;
      case 'price_low':
        query = query.order('current_price', { ascending: true });
        break;
      case 'biggest_gain':
        query = query.order('price_change_percentage', { ascending: false });
        break;
      case 'biggest_drop':
        query = query.order('price_change_percentage', { ascending: true });
        break;
      default:
        query = query.order('updated_at', { ascending: false });
    }

    query = query.range(offset, offset + limit - 1);

    const { data: items, error, count } = await query;

    if (error) {
      console.error('List tracked items error:', error);
      return res.status(500).json({ error: 'Failed to fetch price data' });
    }

    res.json({
      items: items || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit)
      }
    });
  } catch (error) {
    console.error('List tracked items error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get featured movers (top gainers and losers)
router.get('/movers', async (req, res) => {
  try {
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 5));

    const [gainersResult, losersResult] = await Promise.all([
      supabaseAdmin
        .from('price_tracked_items')
        .select('*')
        .eq('is_active', true)
        .eq('price_direction', 'up')
        .order('price_change_percentage', { ascending: false })
        .limit(limit),
      supabaseAdmin
        .from('price_tracked_items')
        .select('*')
        .eq('is_active', true)
        .eq('price_direction', 'down')
        .order('price_change_percentage', { ascending: true })
        .limit(limit)
    ]);

    res.json({
      gainers: gainersResult.data || [],
      losers: losersResult.data || []
    });
  } catch (error) {
    console.error('Movers error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get price history for a specific item (for charting)
router.get('/:itemId/history', async (req, res) => {
  try {
    const { itemId } = req.params;
    const { period } = req.query; // '7d', '30d', '90d', '1y', 'all'

    // Verify item exists
    const { data: item, error: itemError } = await supabaseAdmin
      .from('price_tracked_items')
      .select('*')
      .eq('id', itemId)
      .eq('is_active', true)
      .single();

    if (itemError || !item) {
      return res.status(404).json({ error: 'Tracked item not found' });
    }

    // Build date filter
    let dateFilter = null;
    const now = new Date();
    switch (period) {
      case '7d':
        dateFilter = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
        break;
      case '30d':
        dateFilter = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
        break;
      case '90d':
        dateFilter = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
        break;
      case '1y':
        dateFilter = new Date(now - 365 * 24 * 60 * 60 * 1000).toISOString();
        break;
      default:
        // 'all' - no filter
        break;
    }

    let query = supabaseAdmin
      .from('price_history')
      .select('*')
      .eq('tracked_item_id', itemId)
      .order('recorded_at', { ascending: true });

    if (dateFilter) {
      query = query.gte('recorded_at', dateFilter);
    }

    const { data: history, error } = await query;

    if (error) {
      console.error('Price history error:', error);
      return res.status(500).json({ error: 'Failed to fetch price history' });
    }

    // Calculate stats from history
    const prices = (history || []).map(h => h.price);
    const stats = prices.length > 0 ? {
      current: item.current_price,
      high: Math.max(...prices),
      low: Math.min(...prices),
      average: parseFloat((prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2)),
      change: item.price_change_percentage,
      direction: item.price_direction,
      data_points: prices.length
    } : null;

    res.json({
      item,
      history: history || [],
      stats
    });
  } catch (error) {
    console.error('Price history error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get price data for a specific item
router.get('/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;

    const { data: item, error } = await supabaseAdmin
      .from('price_tracked_items')
      .select('*')
      .eq('id', itemId)
      .eq('is_active', true)
      .single();

    if (error || !item) {
      return res.status(404).json({ error: 'Tracked item not found' });
    }

    res.json({ item });
  } catch (error) {
    console.error('Get item error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// ADMIN ENDPOINTS
// ============================================

// Create a new tracked item (admin)
router.post('/', authenticateToken, requireRole('super_admin', 'admin', 'manager'), async (req, res) => {
  try {
    const validation = createTrackedItemSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    const data = validation.data;

    const { data: item, error } = await supabaseAdmin
      .from('price_tracked_items')
      .insert({
        product_id: data.product_id || null,
        card_name: data.card_name,
        card_number: data.card_number || null,
        set_id: data.set_id || null,
        set_code: data.set_code || null,
        current_price: data.current_price,
        previous_price: data.current_price,
        image_url: data.image_url || null,
        is_featured: data.is_featured || false
      })
      .select()
      .single();

    if (error) {
      console.error('Create tracked item error:', error);
      return res.status(500).json({ error: 'Failed to create tracked item' });
    }

    // Record initial price point
    await supabaseAdmin
      .from('price_history')
      .insert({
        tracked_item_id: item.id,
        price: data.current_price,
        source: 'manual',
        source_details: 'Initial price entry'
      });

    res.status(201).json({ message: 'Tracked item created', item });
  } catch (error) {
    console.error('Create tracked item error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update a tracked item (admin)
router.put('/:itemId', authenticateToken, requireRole('super_admin', 'admin', 'manager'), async (req, res) => {
  try {
    const { itemId } = req.params;
    const validation = updateTrackedItemSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    const { data: item, error } = await supabaseAdmin
      .from('price_tracked_items')
      .update(validation.data)
      .eq('id', itemId)
      .select()
      .single();

    if (error) {
      console.error('Update tracked item error:', error);
      return res.status(500).json({ error: 'Failed to update tracked item' });
    }

    res.json({ message: 'Tracked item updated', item });
  } catch (error) {
    console.error('Update tracked item error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Record a new price data point (admin)
router.post('/:itemId/record', authenticateToken, requireRole('super_admin', 'admin', 'manager'), async (req, res) => {
  try {
    const { itemId } = req.params;
    const validation = recordPriceSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    const { price, source, source_details } = validation.data;

    // Get current item
    const { data: item, error: itemError } = await supabaseAdmin
      .from('price_tracked_items')
      .select('current_price')
      .eq('id', itemId)
      .single();

    if (itemError || !item) {
      return res.status(404).json({ error: 'Tracked item not found' });
    }

    // Record the price point
    const { error: historyError } = await supabaseAdmin
      .from('price_history')
      .insert({
        tracked_item_id: itemId,
        price,
        source: source || 'manual',
        source_details: source_details || null
      });

    if (historyError) {
      console.error('Record price error:', historyError);
      return res.status(500).json({ error: 'Failed to record price' });
    }

    // Update the tracked item with new price
    const previousPrice = item.current_price;
    const changePercentage = previousPrice > 0
      ? parseFloat(((price - previousPrice) / previousPrice * 100).toFixed(2))
      : 0;
    const direction = price > previousPrice ? 'up' : price < previousPrice ? 'down' : 'stable';

    // Calculate 30d stats
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recentHistory } = await supabaseAdmin
      .from('price_history')
      .select('price')
      .eq('tracked_item_id', itemId)
      .gte('recorded_at', thirtyDaysAgo);

    const recentPrices = (recentHistory || []).map(h => h.price).concat([price]);

    const { error: updateError } = await supabaseAdmin
      .from('price_tracked_items')
      .update({
        current_price: price,
        previous_price: previousPrice,
        price_change_percentage: changePercentage,
        price_direction: direction,
        price_high_30d: Math.max(...recentPrices),
        price_low_30d: Math.min(...recentPrices),
        price_avg_30d: parseFloat((recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length).toFixed(2))
      })
      .eq('id', itemId);

    if (updateError) {
      console.error('Update price item error:', updateError);
    }

    res.status(201).json({
      message: 'Price recorded',
      price_update: {
        previous: previousPrice,
        current: price,
        change_percentage: changePercentage,
        direction
      }
    });
  } catch (error) {
    console.error('Record price error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Bulk record prices (admin)
router.post('/bulk-record', authenticateToken, requireRole('super_admin', 'admin', 'manager'), async (req, res) => {
  try {
    const validation = bulkRecordPriceSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    const results = { recorded: 0, failed: 0, errors: [] };

    for (const entry of validation.data.prices) {
      try {
        const { data: item } = await supabaseAdmin
          .from('price_tracked_items')
          .select('current_price')
          .eq('id', entry.tracked_item_id)
          .single();

        if (!item) {
          results.failed++;
          results.errors.push({ id: entry.tracked_item_id, error: 'Item not found' });
          continue;
        }

        await supabaseAdmin
          .from('price_history')
          .insert({
            tracked_item_id: entry.tracked_item_id,
            price: entry.price,
            source: entry.source || 'manual',
            source_details: entry.source_details || null
          });

        const previousPrice = item.current_price;
        const changePercentage = previousPrice > 0
          ? parseFloat(((entry.price - previousPrice) / previousPrice * 100).toFixed(2))
          : 0;
        const direction = entry.price > previousPrice ? 'up' : entry.price < previousPrice ? 'down' : 'stable';

        await supabaseAdmin
          .from('price_tracked_items')
          .update({
            current_price: entry.price,
            previous_price: previousPrice,
            price_change_percentage: changePercentage,
            price_direction: direction
          })
          .eq('id', entry.tracked_item_id);

        results.recorded++;
      } catch (err) {
        results.failed++;
        results.errors.push({ id: entry.tracked_item_id, error: err.message });
      }
    }

    res.json({ message: 'Bulk price recording complete', results });
  } catch (error) {
    console.error('Bulk record error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a tracked item (admin)
router.delete('/:itemId', authenticateToken, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { itemId } = req.params;

    const { error } = await supabaseAdmin
      .from('price_tracked_items')
      .update({ is_active: false })
      .eq('id', itemId);

    if (error) {
      console.error('Delete tracked item error:', error);
      return res.status(500).json({ error: 'Failed to deactivate tracked item' });
    }

    res.json({ message: 'Tracked item deactivated' });
  } catch (error) {
    console.error('Delete tracked item error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
