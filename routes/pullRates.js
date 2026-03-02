import { Router } from 'express';
import { z } from 'zod';
import { authenticateCustomer, optionalCustomerAuth, authenticateToken, requireRole } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

// ============================================
// VALIDATION SCHEMAS
// ============================================

const createSessionSchema = z.object({
  set_id: z.string().uuid('Invalid set ID').optional(),
  product_id: z.string().uuid('Invalid product ID').optional(),
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  packs_opened: z.number().int().min(1).max(100),
  product_type: z.enum(['booster_box', 'etb', 'single_pack', 'booster_bundle']).optional(),
  thumbnail_url: z.string().url().max(500).optional(),
  is_public: z.boolean().optional()
});

const pullRecordSchema = z.object({
  card_name: z.string().min(1).max(255),
  card_number: z.string().max(20).optional(),
  rarity: z.enum([
    'common', 'uncommon', 'rare', 'holo_rare', 'ultra_rare',
    'full_art', 'special_art_rare', 'hyper_rare', 'secret_rare',
    'illustration_rare', 'special_illustration_rare', 'gold'
  ]),
  card_image_url: z.string().url().max(500).optional(),
  is_hit: z.boolean().optional(),
  is_chase_card: z.boolean().optional(),
  estimated_value: z.number().positive().optional(),
  pack_number: z.number().int().min(1).optional()
});

const addPullsSchema = z.object({
  pulls: z.array(pullRecordSchema).min(1).max(500)
});

// ============================================
// PACK OPENING SESSIONS
// ============================================

// Create a new pack opening session
router.post('/sessions', authenticateCustomer, async (req, res) => {
  try {
    const validation = createSessionSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    const data = validation.data;

    const { data: session, error } = await supabaseAdmin
      .from('pack_opening_sessions')
      .insert({
        customer_id: req.customer.id,
        set_id: data.set_id || null,
        product_id: data.product_id || null,
        title: data.title || null,
        description: data.description || null,
        packs_opened: data.packs_opened,
        product_type: data.product_type || null,
        thumbnail_url: data.thumbnail_url || null,
        is_public: data.is_public !== false
      })
      .select()
      .single();

    if (error) {
      console.error('Create session error:', error);
      return res.status(500).json({ error: 'Failed to create pack opening session' });
    }

    res.status(201).json({ message: 'Pack opening session created', session });
  } catch (error) {
    console.error('Create session error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add pull records to a session
router.post('/sessions/:sessionId/pulls', authenticateCustomer, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const validation = addPullsSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    // Verify session ownership
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('pack_opening_sessions')
      .select('id, customer_id, set_id')
      .eq('id', sessionId)
      .single();

    if (sessionError || !session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.customer_id !== req.customer.id) {
      return res.status(403).json({ error: 'Not authorized to modify this session' });
    }

    const pullRecords = validation.data.pulls.map(pull => ({
      session_id: sessionId,
      customer_id: req.customer.id,
      set_id: session.set_id,
      card_name: pull.card_name,
      card_number: pull.card_number || null,
      rarity: pull.rarity,
      card_image_url: pull.card_image_url || null,
      is_hit: pull.is_hit || false,
      is_chase_card: pull.is_chase_card || false,
      estimated_value: pull.estimated_value || null,
      pack_number: pull.pack_number || null
    }));

    const { data: pulls, error } = await supabaseAdmin
      .from('pull_records')
      .insert(pullRecords)
      .select();

    if (error) {
      console.error('Add pulls error:', error);
      return res.status(500).json({ error: 'Failed to add pull records' });
    }

    // Update session stats
    const hitRarities = ['ultra_rare', 'full_art', 'special_art_rare', 'hyper_rare', 'secret_rare', 'illustration_rare', 'special_illustration_rare', 'gold'];
    const notablePulls = pullRecords.filter(p => hitRarities.includes(p.rarity)).length;

    await supabaseAdmin
      .from('pack_opening_sessions')
      .update({
        total_cards_pulled: session.total_cards_pulled + pullRecords.length,
        notable_pulls: session.notable_pulls + notablePulls
      })
      .eq('id', sessionId);

    res.status(201).json({
      message: `${pulls.length} pull record(s) added`,
      pulls,
      session_stats: {
        cards_added: pulls.length,
        notable_pulls_added: notablePulls
      }
    });
  } catch (error) {
    console.error('Add pulls error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get a specific session with its pulls
router.get('/sessions/:sessionId', optionalCustomerAuth, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const { data: session, error } = await supabaseAdmin
      .from('pack_opening_sessions')
      .select('*')
      .eq('id', sessionId)
      .single();

    if (error || !session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // If private, only owner can view
    if (!session.is_public && (!req.customer || req.customer.id !== session.customer_id)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Fetch pulls
    const { data: pulls } = await supabaseAdmin
      .from('pull_records')
      .select('*')
      .eq('session_id', sessionId)
      .order('pack_number', { ascending: true, nullsFirst: false });

    // Fetch customer name
    const { data: customer } = await supabaseAdmin
      .from('customers')
      .select('first_name, last_name')
      .eq('id', session.customer_id)
      .single();

    // Fetch set name
    let setName = null;
    if (session.set_id) {
      const { data: set } = await supabaseAdmin
        .from('sets')
        .select('name, code')
        .eq('id', session.set_id)
        .single();
      setName = set;
    }

    res.json({
      session: {
        ...session,
        opener_name: customer ? `${customer.first_name} ${customer.last_name ? customer.last_name.charAt(0) + '.' : ''}`.trim() : 'Anonymous',
        set: setName
      },
      pulls: pulls || [],
      summary: {
        total_cards: pulls?.length || 0,
        by_rarity: pulls?.reduce((acc, p) => {
          acc[p.rarity] = (acc[p.rarity] || 0) + 1;
          return acc;
        }, {}) || {},
        hits: pulls?.filter(p => p.is_hit) || [],
        estimated_total_value: pulls?.reduce((sum, p) => sum + (p.estimated_value || 0), 0) || 0
      }
    });
  } catch (error) {
    console.error('Get session error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// List public pack opening sessions
router.get('/sessions', optionalCustomerAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const { set_id, product_type, sort } = req.query;

    let query = supabaseAdmin
      .from('pack_opening_sessions')
      .select('*', { count: 'exact' })
      .eq('is_public', true);

    if (set_id) query = query.eq('set_id', set_id);
    if (product_type) query = query.eq('product_type', product_type);

    // Sorting
    if (sort === 'most_pulls') {
      query = query.order('notable_pulls', { ascending: false });
    } else if (sort === 'most_packs') {
      query = query.order('packs_opened', { ascending: false });
    } else {
      query = query.order('created_at', { ascending: false });
    }

    query = query.range(offset, offset + limit - 1);

    const { data: sessions, error, count } = await query;

    if (error) {
      console.error('List sessions error:', error);
      return res.status(500).json({ error: 'Failed to fetch sessions' });
    }

    // Enrich with customer names
    const enriched = [];
    for (const session of sessions || []) {
      const { data: customer } = await supabaseAdmin
        .from('customers')
        .select('first_name, last_name')
        .eq('id', session.customer_id)
        .single();

      enriched.push({
        ...session,
        opener_name: customer ? `${customer.first_name} ${customer.last_name ? customer.last_name.charAt(0) + '.' : ''}`.trim() : 'Anonymous'
      });
    }

    res.json({
      sessions: enriched,
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit)
      }
    });
  } catch (error) {
    console.error('List sessions error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get my pack opening sessions
router.get('/my-sessions', authenticateCustomer, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const { data: sessions, error, count } = await supabaseAdmin
      .from('pack_opening_sessions')
      .select('*', { count: 'exact' })
      .eq('customer_id', req.customer.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('My sessions error:', error);
      return res.status(500).json({ error: 'Failed to fetch sessions' });
    }

    res.json({
      sessions: sessions || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit)
      }
    });
  } catch (error) {
    console.error('My sessions error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a session (owner only)
router.delete('/sessions/:sessionId', authenticateCustomer, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const { data: session } = await supabaseAdmin
      .from('pack_opening_sessions')
      .select('id, customer_id')
      .eq('id', sessionId)
      .single();

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.customer_id !== req.customer.id) {
      return res.status(403).json({ error: 'Not authorized to delete this session' });
    }

    // Cascade deletes pull_records via FK
    const { error } = await supabaseAdmin
      .from('pack_opening_sessions')
      .delete()
      .eq('id', sessionId);

    if (error) {
      console.error('Delete session error:', error);
      return res.status(500).json({ error: 'Failed to delete session' });
    }

    res.json({ message: 'Session deleted successfully' });
  } catch (error) {
    console.error('Delete session error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// PULL RATE STATISTICS (PUBLIC)
// ============================================

// Get pull rate stats for a set
router.get('/stats/:setId', async (req, res) => {
  try {
    const { setId } = req.params;

    // Get set info
    const { data: set } = await supabaseAdmin
      .from('sets')
      .select('id, name, code, card_count')
      .eq('id', setId)
      .single();

    if (!set) {
      return res.status(404).json({ error: 'Set not found' });
    }

    // Get pull rate stats
    const { data: stats, error } = await supabaseAdmin
      .from('pull_rate_stats')
      .select('*')
      .eq('set_id', setId)
      .order('rarity');

    if (error) {
      console.error('Pull rate stats error:', error);
      return res.status(500).json({ error: 'Failed to fetch pull rate stats' });
    }

    // Get total sessions and packs for this set
    const { data: sessionAgg } = await supabaseAdmin
      .from('pack_opening_sessions')
      .select('id', { count: 'exact' })
      .eq('set_id', setId)
      .eq('is_public', true);

    const { data: packSum } = await supabaseAdmin
      .from('pack_opening_sessions')
      .select('packs_opened')
      .eq('set_id', setId)
      .eq('is_public', true);

    const totalPacks = (packSum || []).reduce((sum, s) => sum + s.packs_opened, 0);

    res.json({
      set,
      stats: stats || [],
      overview: {
        total_sessions: sessionAgg?.length || 0,
        total_packs_opened: totalPacks,
        last_updated: stats?.[0]?.last_calculated_at || null
      }
    });
  } catch (error) {
    console.error('Pull rate stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get available sets with pull rate data
router.get('/stats', async (req, res) => {
  try {
    // Get sets that have pull rate data
    const { data: statsData, error } = await supabaseAdmin
      .from('pull_rate_stats')
      .select('set_id')
      .order('last_calculated_at', { ascending: false });

    if (error) {
      console.error('Available stats error:', error);
      return res.status(500).json({ error: 'Failed to fetch stats' });
    }

    const uniqueSetIds = [...new Set((statsData || []).map(s => s.set_id))];

    if (uniqueSetIds.length === 0) {
      return res.json({ sets: [] });
    }

    const { data: sets } = await supabaseAdmin
      .from('sets')
      .select('id, name, code, card_count, logo_url')
      .in('id', uniqueSetIds);

    // Enrich with pack counts
    const enrichedSets = [];
    for (const set of sets || []) {
      const { data: packData } = await supabaseAdmin
        .from('pack_opening_sessions')
        .select('packs_opened')
        .eq('set_id', set.id)
        .eq('is_public', true);

      enrichedSets.push({
        ...set,
        total_packs_opened: (packData || []).reduce((sum, s) => sum + s.packs_opened, 0),
        total_sessions: packData?.length || 0
      });
    }

    res.json({ sets: enrichedSets });
  } catch (error) {
    console.error('Available stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Trigger pull rate recalculation for a set
router.post('/stats/:setId/recalculate', authenticateToken, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { setId } = req.params;

    const { error } = await supabaseAdmin.rpc('recalculate_pull_rates', { target_set_id: setId });

    if (error) {
      console.error('Recalculate error:', error);
      return res.status(500).json({ error: 'Failed to recalculate pull rates' });
    }

    res.json({ message: 'Pull rates recalculated successfully' });
  } catch (error) {
    console.error('Recalculate error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Verify a pack opening session
router.patch('/sessions/:sessionId/verify', authenticateToken, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { sessionId } = req.params;

    const { data: session, error } = await supabaseAdmin
      .from('pack_opening_sessions')
      .update({ is_verified: true })
      .eq('id', sessionId)
      .select()
      .single();

    if (error) {
      console.error('Verify session error:', error);
      return res.status(500).json({ error: 'Failed to verify session' });
    }

    res.json({ message: 'Session verified', session });
  } catch (error) {
    console.error('Verify session error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
