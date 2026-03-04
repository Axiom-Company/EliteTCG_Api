import { Router } from 'express';
import { authenticateSupabaseUser, requireRole } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

// GET all active banners (public) — ordered by display_order
router.get('/', async (req, res) => {
  try {
    const { admin } = req.query;
    let query = supabaseAdmin
      .from('banners')
      .select('*, set:sets(id, name, logo_url, code)')
      .order('display_order', { ascending: true });

    if (admin !== 'true') query = query.eq('is_active', true);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ banners: data || [] });
  } catch (error) {
    console.error('Get banners error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST create banner (admin)
router.post('/', authenticateSupabaseUser, requireRole('admin'), async (req, res) => {
  try {
    const { type, title, subtitle, label, image_url, mobile_image_url, set_id, cta_label, cta_url, is_active, display_order, svg_template } = req.body;

    const { count } = await supabaseAdmin
      .from('banners')
      .select('*', { count: 'exact', head: true });

    const { data, error } = await supabaseAdmin
      .from('banners')
      .insert({
        type:             type || 'set',
        title:            title || null,
        subtitle:         subtitle || null,
        label:            label || null,
        image_url:        image_url || null,
        mobile_image_url: mobile_image_url || null,
        set_id:           set_id || null,
        cta_label:        cta_label || 'Shop Now',
        cta_url:          cta_url || null,
        is_active:        is_active !== false,
        display_order:    display_order ?? (count || 0),
        svg_template:     svg_template || 1,
      })
      .select('*, set:sets(id, name, logo_url, code)')
      .single();

    if (error) throw error;
    res.status(201).json({ banner: data });
  } catch (error) {
    console.error('Create banner error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT update banner (admin)
router.put('/:id', authenticateSupabaseUser, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const updates = Object.fromEntries(
      Object.entries(req.body).map(([k, v]) => [k, v === '' ? null : v])
    );

    const { data, error } = await supabaseAdmin
      .from('banners')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*, set:sets(id, name, logo_url, code)')
      .single();

    if (error) throw error;
    res.json({ banner: data });
  } catch (error) {
    console.error('Update banner error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE banner (admin)
router.delete('/:id', authenticateSupabaseUser, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabaseAdmin.from('banners').delete().eq('id', id);
    if (error) throw error;
    res.json({ message: 'Banner deleted' });
  } catch (error) {
    console.error('Delete banner error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
