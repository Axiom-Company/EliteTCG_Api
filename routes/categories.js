import { Router } from 'express';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

// GET all categories
router.get('/', async (req, res) => {
  try {
    const { active, limit = 50 } = req.query;

    let query = supabaseAdmin
      .from('categories')
      .select('*', { count: 'exact' })
      .order('display_order', { ascending: true })
      .limit(parseInt(limit));

    if (active !== 'all') query = query.eq('is_active', true);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({ categories: data || [], total: count || 0 });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET single category by id or slug
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    let { data } = await supabaseAdmin.from('categories').select('*').eq('slug', id).maybeSingle();
    if (!data) {
      ({ data } = await supabaseAdmin.from('categories').select('*').eq('id', id).maybeSingle());
    }

    if (!data) return res.status(404).json({ error: 'Category not found' });
    res.json({ category: data });
  } catch (error) {
    console.error('Get category error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST create category
router.post('/', authenticateToken, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const categoryData = req.body;

    if (!categoryData.slug) {
      categoryData.slug = categoryData.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/(^_|_$)/g, '');
    }

    const { count } = await supabaseAdmin
      .from('categories')
      .select('*', { count: 'exact', head: true });

    const { data, error } = await supabaseAdmin
      .from('categories')
      .insert({
        name: categoryData.name,
        slug: categoryData.slug,
        description: categoryData.description || '',
        icon: categoryData.icon || 'box',
        is_active: categoryData.is_active !== false,
        display_order: (count || 0) + 1,
        image: categoryData.image || null,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ category: data });
  } catch (error) {
    console.error('Create category error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT update category
router.put('/:id', authenticateToken, requireRole('super_admin', 'admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const { data, error } = await supabaseAdmin
      .from('categories')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ category: data });
  } catch (error) {
    console.error('Update category error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE category
router.delete('/:id', authenticateToken, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabaseAdmin.from('categories').delete().eq('id', id);
    if (error) throw error;
    res.json({ message: 'Category deleted' });
  } catch (error) {
    console.error('Delete category error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST reorder categories
router.post('/reorder', authenticateToken, requireRole('super_admin', 'admin', 'manager'), async (req, res) => {
  try {
    const { orders } = req.body;
    await Promise.all(
      orders.map(({ id, display_order }) =>
        supabaseAdmin.from('categories').update({ display_order }).eq('id', id)
      )
    );
    res.json({ message: 'Categories reordered' });
  } catch (error) {
    console.error('Reorder categories error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
