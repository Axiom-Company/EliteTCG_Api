import { Router } from 'express';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

// Normalize inventory from joined data (can be array or object depending on FK setup)
const formatProduct = (p) => {
  const inv = Array.isArray(p.inventory)
    ? (p.inventory[0] || { quantity: 0, low_stock_threshold: 5 })
    : (p.inventory || { quantity: 0, low_stock_threshold: 5 });
  return { ...p, inventory: inv };
};

/**
 * @openapi
 * /products:
 *   get:
 *     tags: [Products]
 *     summary: Get all products
 *     parameters:
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *       - in: query
 *         name: set_id
 *         schema:
 *           type: string
 *       - in: query
 *         name: featured
 *         schema:
 *           type: string
 *           enum: ['true', 'false']
 *       - in: query
 *         name: active
 *         schema:
 *           type: string
 *           enum: ['all']
 *         description: Pass "all" to include inactive products
 *       - in: query
 *         name: badge
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       200:
 *         description: List of products with total count
 *       500:
 *         description: Server error
 */
// GET all products
router.get('/', async (req, res) => {
  try {
    const { category, set_id, featured, active, badge, limit = 50, offset = 0 } = req.query;

    let query = supabaseAdmin
      .from('products')
      .select('*, inventory(quantity, low_stock_threshold)', { count: 'exact' });

    if (category) query = query.eq('category', category);
    if (set_id) query = query.eq('set_id', set_id);
    if (featured === 'true') query = query.eq('is_featured', true);
    if (active !== 'all') query = query.eq('is_active', true);
    if (badge) query = query.eq('badge', badge);

    query = query
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({ products: (data || []).map(formatProduct), total: count || 0 });
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /products/{id}:
 *   get:
 *     tags: [Products]
 *     summary: Get product by ID or slug
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Product ID or slug
 *     responses:
 *       200:
 *         description: Product details
 *       404:
 *         description: Product not found
 *       500:
 *         description: Server error
 */
// GET single product by slug or id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const sel = '*, inventory(quantity, low_stock_threshold)';

    // Try slug first, then fall back to id
    let { data } = await supabaseAdmin.from('products').select(sel).eq('slug', id).maybeSingle();
    if (!data) {
      ({ data } = await supabaseAdmin.from('products').select(sel).eq('id', id).maybeSingle());
    }

    if (!data) return res.status(404).json({ error: 'Product not found' });
    res.json({ product: formatProduct(data) });
  } catch (error) {
    console.error('Get product error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /products:
 *   post:
 *     tags: [Products]
 *     summary: Create a product (admin)
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, price]
 *             properties:
 *               name:
 *                 type: string
 *               slug:
 *                 type: string
 *               description:
 *                 type: string
 *               price:
 *                 type: number
 *               compare_at_price:
 *                 type: number
 *               currency:
 *                 type: string
 *                 default: ZAR
 *               category:
 *                 type: string
 *               badge:
 *                 type: string
 *               set_id:
 *                 type: string
 *               is_active:
 *                 type: boolean
 *               is_featured:
 *                 type: boolean
 *               images:
 *                 type: array
 *                 items:
 *                   type: string
 *               sku:
 *                 type: string
 *               initial_quantity:
 *                 type: integer
 *               low_stock_threshold:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Product created
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
// POST create product
router.post('/', authenticateToken, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const productData = req.body;

    if (!productData.slug) {
      productData.slug = productData.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
    }

    const { data: product, error: productError } = await supabaseAdmin
      .from('products')
      .insert({
        name: productData.name,
        slug: productData.slug,
        description: productData.description || '',
        price: parseFloat(productData.price) || 0,
        compare_at_price: productData.compare_at_price ? parseFloat(productData.compare_at_price) : null,
        currency: productData.currency || 'ZAR',
        category: productData.category || 'booster_box',
        badge: productData.badge || 'none',
        set_id: productData.set_id || null,
        is_active: productData.is_active !== false,
        is_featured: productData.is_featured || false,
        rating: 0,
        review_count: 0,
        images: productData.images || [],
        sku: productData.sku || '',
      })
      .select()
      .single();

    if (productError) throw productError;

    const initQty = parseInt(productData.initial_quantity) || 0;
    const threshold = parseInt(productData.low_stock_threshold) || 5;

    const { error: invError } = await supabaseAdmin
      .from('inventory')
      .insert({ product_id: product.id, quantity: initQty, low_stock_threshold: threshold });

    if (invError) console.error('Inventory insert error:', invError);

    res.status(201).json({
      product: formatProduct({
        ...product,
        inventory: [{ quantity: initQty, low_stock_threshold: threshold }],
      }),
    });
  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /products/{id}:
 *   put:
 *     tags: [Products]
 *     summary: Update a product (admin)
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
 *               price:
 *                 type: number
 *               description:
 *                 type: string
 *               is_active:
 *                 type: boolean
 *               is_featured:
 *                 type: boolean
 *               images:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Product updated
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
// PUT update product
router.put('/:id', authenticateToken, requireRole('super_admin', 'admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    // Strip inventory/quantity fields — those go through the inventory endpoint
    const { initial_quantity, low_stock_threshold, inventory, ...productUpdates } = req.body;

    const { data, error } = await supabaseAdmin
      .from('products')
      .update({ ...productUpdates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*, inventory(quantity, low_stock_threshold)')
      .single();

    if (error) throw error;
    res.json({ product: formatProduct(data) });
  } catch (error) {
    console.error('Update product error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /products/{id}:
 *   delete:
 *     tags: [Products]
 *     summary: Delete a product and its images (admin)
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
 *         description: Product deleted
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
// DELETE product — also removes images from Supabase Storage
router.delete('/:id', authenticateToken, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch images before deleting so we can clean up storage
    const { data: product } = await supabaseAdmin
      .from('products')
      .select('images')
      .eq('id', id)
      .maybeSingle();

    // Delete the product row (inventory cascades via FK if set up, otherwise also delete explicitly)
    const { error } = await supabaseAdmin.from('products').delete().eq('id', id);
    if (error) throw error;

    // Remove images from Supabase Storage
    if (product?.images?.length) {
      const paths = product.images
        .map((url) => {
          // Extract path after /images/ in the storage public URL
          const match = url.match(/\/images\/(.+)$/);
          return match ? match[1] : null;
        })
        .filter(Boolean);

      if (paths.length) {
        const { error: storageError } = await supabaseAdmin.storage.from('images').remove(paths);
        if (storageError) console.error('Storage cleanup error:', storageError);
      }
    }

    res.json({ message: 'Product deleted' });
  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /products/{id}/inventory:
 *   patch:
 *     tags: [Products]
 *     summary: Update product inventory (admin)
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
 *               quantity:
 *                 type: integer
 *                 description: Set absolute quantity
 *               adjustment:
 *                 type: integer
 *                 description: Relative adjustment (+/-)
 *               low_stock_threshold:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Inventory updated
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
// PATCH inventory
router.patch('/:id/inventory', authenticateToken, requireRole('super_admin', 'admin', 'manager', 'staff'), async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity, adjustment, low_stock_threshold } = req.body;

    const { data: current } = await supabaseAdmin
      .from('inventory')
      .select('quantity')
      .eq('product_id', id)
      .maybeSingle();

    let newQty = current?.quantity ?? 0;
    if (quantity !== undefined) newQty = quantity;
    else if (adjustment !== undefined) newQty = newQty + adjustment;

    const updates = { product_id: id, quantity: newQty };
    if (low_stock_threshold !== undefined) updates.low_stock_threshold = low_stock_threshold;

    const { data, error } = await supabaseAdmin
      .from('inventory')
      .upsert(updates, { onConflict: 'product_id' })
      .select()
      .single();

    if (error) throw error;
    res.json({ inventory: data });
  } catch (error) {
    console.error('Update inventory error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
