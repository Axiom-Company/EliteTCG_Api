import { Router } from 'express';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

/**
 * @openapi
 * /sets:
 *   get:
 *     tags: [Sets]
 *     summary: Get all sets
 *     parameters:
 *       - in: query
 *         name: active
 *         schema:
 *           type: string
 *           enum: ['all']
 *         description: Pass "all" to include inactive sets
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *     responses:
 *       200:
 *         description: List of sets
 *       500:
 *         description: Server error
 */
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

/**
 * @openapi
 * /sets/{id}:
 *   get:
 *     tags: [Sets]
 *     summary: Get set by ID or code
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Set ID or code
 *     responses:
 *       200:
 *         description: Set details
 *       404:
 *         description: Set not found
 *       500:
 *         description: Server error
 */
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

/**
 * @openapi
 * /sets:
 *   post:
 *     tags: [Sets]
 *     summary: Create a set (admin)
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *               code:
 *                 type: string
 *               release_date:
 *                 type: string
 *                 format: date
 *               is_active:
 *                 type: boolean
 *               is_new:
 *                 type: boolean
 *               image:
 *                 type: string
 *     responses:
 *       201:
 *         description: Set created
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
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
        image: setData.image || null,
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

/**
 * @openapi
 * /sets/{id}:
 *   put:
 *     tags: [Sets]
 *     summary: Update a set (admin)
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
 *               name:
 *                 type: string
 *               code:
 *                 type: string
 *               release_date:
 *                 type: string
 *                 format: date
 *               is_active:
 *                 type: boolean
 *               is_new:
 *                 type: boolean
 *               image:
 *                 type: string
 *     responses:
 *       200:
 *         description: Set updated
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
// PUT update set
router.put('/:id', authenticateToken, requireRole('super_admin', 'admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const { data, error } = await supabaseAdmin
      .from('sets')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ set: data });
  } catch (error) {
    console.error('Update set error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /sets/{id}:
 *   delete:
 *     tags: [Sets]
 *     summary: Delete a set (admin)
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
 *         description: Set deleted
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
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

/**
 * @openapi
 * /sets/reorder:
 *   post:
 *     tags: [Sets]
 *     summary: Reorder sets (admin)
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [orders]
 *             properties:
 *               orders:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     display_order:
 *                       type: integer
 *     responses:
 *       200:
 *         description: Sets reordered
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
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
