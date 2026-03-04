import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

// GET /api/search?q=term&limit=5
router.get('/', async (req, res) => {
  try {
    const { q = '', limit = 5 } = req.query;
    const term = q.trim();

    if (term.length < 2) return res.json({ products: [], sets: [], categories: [] });

    const pattern = `%${term}%`;
    const n = Math.min(parseInt(limit), 10);

    const [productsRes, setsRes, categoriesRes] = await Promise.all([
      supabaseAdmin
        .from('products')
        .select('id, name, slug, price, compare_at_price, images, category')
        .ilike('name', pattern)
        .eq('is_active', true)
        .limit(n),
      supabaseAdmin
        .from('sets')
        .select('id, name, code, logo_url')
        .ilike('name', pattern)
        .eq('is_active', true)
        .limit(n),
      supabaseAdmin
        .from('categories')
        .select('id, name, slug, image_url')
        .ilike('name', pattern)
        .eq('is_active', true)
        .limit(n),
    ]);

    res.json({
      products:   productsRes.data   || [],
      sets:       setsRes.data       || [],
      categories: categoriesRes.data || [],
    });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
