import { Router } from 'express';
import { authenticateSupabaseUser, requireRole } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

// Mock preorders for development
const mockPreorders = [
  { id: '1', product_id: '1', release_date: '2025-03-28', deposit_percentage: 20, max_quantity: 100, current_quantity: 45, is_active: true, product: { name: 'Journey Together Booster Box', price: 144.99 } },
  { id: '2', product_id: '2', release_date: '2025-05-30', deposit_percentage: 20, max_quantity: 100, current_quantity: 23, is_active: true, product: { name: 'Destined Rivals ETB', price: 49.99 } },
  { id: '3', product_id: '3', release_date: '2025-08-08', deposit_percentage: 20, max_quantity: 50, current_quantity: 12, is_active: true, product: { name: 'Space-Time Smackdown Booster Box', price: 149.99 } },
];

/**
 * @openapi
 * /preorders:
 *   get:
 *     tags: [Preorders]
 *     summary: Get all preorders
 *     parameters:
 *       - in: query
 *         name: active
 *         schema:
 *           type: string
 *           default: 'true'
 *     responses:
 *       200:
 *         description: List of preorders
 *       500:
 *         description: Server error
 */
// Get all preorders (public)
router.get('/', async (req, res) => {
  try {
    const { active = 'true' } = req.query;

    if (!supabaseAdmin) {
      let filtered = [...mockPreorders];
      if (active === 'true') filtered = filtered.filter(p => p.is_active);
      return res.json({ preorders: filtered });
    }

    let query = supabaseAdmin
      .from('preorders')
      .select(`
        *,
        products (id, name, slug, price, images, category)
      `)
      .order('release_date', { ascending: true });

    if (active === 'true') {
      query = query.eq('is_active', true);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json({ preorders: data });
  } catch (error) {
    console.error('Get preorders error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /preorders/{id}:
 *   get:
 *     tags: [Preorders]
 *     summary: Get preorder by ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Preorder details
 *       404:
 *         description: Preorder not found
 *       500:
 *         description: Server error
 */
// Get single preorder
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!supabaseAdmin) {
      const preorder = mockPreorders.find(p => p.id === id);
      if (!preorder) return res.status(404).json({ error: 'Preorder not found' });
      return res.json({ preorder });
    }

    const { data, error } = await supabaseAdmin
      .from('preorders')
      .select(`
        *,
        products (*)
      `)
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Preorder not found' });
    }

    res.json({ preorder: data });
  } catch (error) {
    console.error('Get preorder error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /preorders:
 *   post:
 *     tags: [Preorders]
 *     summary: Create a preorder (admin)
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [product_id]
 *             properties:
 *               product_id:
 *                 type: string
 *               release_date:
 *                 type: string
 *                 format: date
 *               deposit_percentage:
 *                 type: number
 *               max_quantity:
 *                 type: integer
 *               is_active:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Preorder created
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
// Create preorder (admin only)
router.post('/', authenticateSupabaseUser, requireRole('admin'), async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(400).json({ error: 'Database not configured' });
    }

    const { data, error } = await supabaseAdmin
      .from('preorders')
      .insert(req.body)
      .select(`
        *,
        products (id, name, slug, price)
      `)
      .single();

    if (error) throw error;

    // Update product badge to preorder
    await supabaseAdmin
      .from('products')
      .update({ badge: 'preorder' })
      .eq('id', req.body.product_id);

    res.status(201).json({ preorder: data });
  } catch (error) {
    console.error('Create preorder error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /preorders/{id}:
 *   put:
 *     tags: [Preorders]
 *     summary: Update a preorder (admin)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               release_date:
 *                 type: string
 *                 format: date
 *               deposit_percentage:
 *                 type: number
 *               max_quantity:
 *                 type: integer
 *               is_active:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Preorder updated
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
// Update preorder (admin only)
router.put('/:id', authenticateSupabaseUser, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;

    if (!supabaseAdmin) {
      return res.status(400).json({ error: 'Database not configured' });
    }

    const updates = { ...req.body };
    delete updates.id;
    delete updates.created_at;
    delete updates.product_id; // Don't allow changing product

    const { data, error } = await supabaseAdmin
      .from('preorders')
      .update(updates)
      .eq('id', id)
      .select(`
        *,
        products (id, name, slug, price)
      `)
      .single();

    if (error) throw error;

    res.json({ preorder: data });
  } catch (error) {
    console.error('Update preorder error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /preorders/{id}:
 *   delete:
 *     tags: [Preorders]
 *     summary: Delete a preorder (admin)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Preorder deleted
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
// Delete preorder (admin only)
router.delete('/:id', authenticateSupabaseUser, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;

    if (!supabaseAdmin) {
      return res.status(400).json({ error: 'Database not configured' });
    }

    // Get preorder to find product_id
    const { data: preorder } = await supabaseAdmin
      .from('preorders')
      .select('product_id')
      .eq('id', id)
      .single();

    const { error } = await supabaseAdmin
      .from('preorders')
      .delete()
      .eq('id', id);

    if (error) throw error;

    // Remove preorder badge from product
    if (preorder) {
      await supabaseAdmin
        .from('products')
        .update({ badge: 'none' })
        .eq('id', preorder.product_id);
    }

    res.json({ message: 'Preorder deleted' });
  } catch (error) {
    console.error('Delete preorder error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
