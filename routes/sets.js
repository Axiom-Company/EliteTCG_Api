import { Router } from 'express';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

// GET all sets
router.get('/', async (req, res) => {
  try {
    const { active, limit = 50 } = req.query;

    let query = supabaseAdmin
      .from('sets')
      .select('*', { count: 'exact' })
      .order('display_order', { ascending: true })
      .limit(parseInt(limit));

    if (active !== 'all') query = query.eq('is_active', true);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({ sets: data || [], total: count || 0 });
  } catch (error) {
    console.error('Get sets error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET single set by id or code
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    let { data } = await supabaseAdmin.from('sets').select('*').eq('id', id).maybeSingle();
    if (!data) {
      ({ data } = await supabaseAdmin.from('sets').select('*').eq('code', id).maybeSingle());
    }

    if (!data) return res.status(404).json({ error: 'Set not found' });
    res.json({ set: data });
  } catch (error) {
    console.error('Get set error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST create set
router.post('/', authenticateToken, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const setData = req.body;

    const { count } = await supabaseAdmin
      .from('sets')
      .select('*', { count: 'exact', head: true });

    const { data, error } = await supabaseAdmin
      .from('sets')
      .insert({
        name: setData.name,
        code: setData.code || '',
        release_date: setData.release_date || null,
        is_active: setData.is_active !== false,
        is_new: setData.is_new || false,
        display_order: (count || 0) + 1,
        logo_url: setData.image || null,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ set: data });
  } catch (error) {
    console.error('Create set error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT update set
router.put('/:id', authenticateToken, requireRole('super_admin', 'admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, code, release_date, is_active, is_new, image, display_order } = req.body;

    const dbUpdates = {};
    if (name !== undefined) dbUpdates.name = name;
    if (code !== undefined) dbUpdates.code = code;
    if (release_date !== undefined) dbUpdates.release_date = release_date === '' ? null : release_date;
    if (is_active !== undefined) dbUpdates.is_active = is_active;
    if (is_new !== undefined) dbUpdates.is_new = is_new;
    if (image !== undefined) dbUpdates.logo_url = image;
    if (display_order !== undefined) dbUpdates.display_order = display_order;

    const { data, error } = await supabaseAdmin
      .from('sets')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ set: data });
  } catch (error) {
    console.error('Update set error:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

// DELETE set
router.delete('/:id', authenticateToken, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabaseAdmin.from('sets').delete().eq('id', id);
    if (error) throw error;
    res.json({ message: 'Set deleted' });
  } catch (error) {
    console.error('Delete set error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST reorder sets
router.post('/reorder', authenticateToken, requireRole('super_admin', 'admin', 'manager'), async (req, res) => {
  try {
    const { orders } = req.body;
    await Promise.all(
      orders.map(({ id, display_order }) =>
        supabaseAdmin.from('sets').update({ display_order }).eq('id', id)
      )
    );
    res.json({ message: 'Sets reordered' });
  } catch (error) {
    console.error('Reorder sets error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
