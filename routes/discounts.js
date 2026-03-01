import { Router } from 'express';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

// Mock discounts for development
const mockDiscounts = [
  { id: '1', code: 'SAVE10', description: '10% off your order', discount_type: 'percentage', discount_value: 10, minimum_order: 50, is_active: true, usage_count: 45, usage_limit: 100 },
  { id: '2', code: 'FREESHIP', description: 'Free shipping on orders $30+', discount_type: 'fixed', discount_value: 5.99, minimum_order: 30, is_active: true, usage_count: 120, usage_limit: null },
  { id: '3', code: 'WELCOME15', description: '15% off for new customers', discount_type: 'percentage', discount_value: 15, minimum_order: null, is_active: true, usage_count: 89, usage_limit: 500 },
];

// Validate discount code (public)
router.post('/validate', async (req, res) => {
  try {
    const { code, order_total, product_ids } = req.body;

    if (!code) {
      return res.status(400).json({ error: 'Discount code required' });
    }

    if (!supabaseAdmin) {
      const discount = mockDiscounts.find(
        d => d.code.toLowerCase() === code.toLowerCase() && d.is_active
      );

      if (!discount) {
        return res.status(404).json({ error: 'Invalid discount code' });
      }

      if (discount.minimum_order && order_total < discount.minimum_order) {
        return res.status(400).json({
          error: `Minimum order of $${discount.minimum_order} required`
        });
      }

      let discountAmount;
      if (discount.discount_type === 'percentage') {
        discountAmount = order_total * (discount.discount_value / 100);
        if (discount.maximum_discount) {
          discountAmount = Math.min(discountAmount, discount.maximum_discount);
        }
      } else {
        discountAmount = discount.discount_value;
      }

      return res.json({
        valid: true,
        discount,
        discount_amount: discountAmount
      });
    }

    const { data: discount, error } = await supabaseAdmin
      .from('discounts')
      .select('*')
      .eq('code', code.toUpperCase())
      .eq('is_active', true)
      .single();

    if (error || !discount) {
      return res.status(404).json({ error: 'Invalid discount code' });
    }

    // Check if expired
    if (discount.expires_at && new Date(discount.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Discount code has expired' });
    }

    // Check if not started yet
    if (discount.starts_at && new Date(discount.starts_at) > new Date()) {
      return res.status(400).json({ error: 'Discount code is not yet active' });
    }

    // Check usage limit
    if (discount.usage_limit && discount.usage_count >= discount.usage_limit) {
      return res.status(400).json({ error: 'Discount code usage limit reached' });
    }

    // Check minimum order
    if (discount.minimum_order && order_total < parseFloat(discount.minimum_order)) {
      return res.status(400).json({
        error: `Minimum order of $${discount.minimum_order} required`
      });
    }

    // Calculate discount amount
    let discountAmount;
    if (discount.discount_type === 'percentage') {
      discountAmount = order_total * (parseFloat(discount.discount_value) / 100);
      if (discount.maximum_discount) {
        discountAmount = Math.min(discountAmount, parseFloat(discount.maximum_discount));
      }
    } else {
      discountAmount = parseFloat(discount.discount_value);
    }

    res.json({
      valid: true,
      discount: {
        code: discount.code,
        description: discount.description,
        discount_type: discount.discount_type,
        discount_value: discount.discount_value
      },
      discount_amount: discountAmount
    });
  } catch (error) {
    console.error('Validate discount error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all discounts (admin only)
router.get('/', authenticateToken, requireRole('super_admin', 'admin', 'manager'), async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.json({ discounts: mockDiscounts });
    }

    const { data, error } = await supabaseAdmin
      .from('discounts')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ discounts: data });
  } catch (error) {
    console.error('Get discounts error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create discount (admin only)
router.post('/', authenticateToken, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(400).json({ error: 'Database not configured' });
    }

    const discountData = {
      ...req.body,
      code: req.body.code.toUpperCase()
    };

    const { data, error } = await supabaseAdmin
      .from('discounts')
      .insert(discountData)
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({ discount: data });
  } catch (error) {
    console.error('Create discount error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update discount (admin only)
router.put('/:id', authenticateToken, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { id } = req.params;

    if (!supabaseAdmin) {
      return res.status(400).json({ error: 'Database not configured' });
    }

    const updates = { ...req.body };
    delete updates.id;
    delete updates.created_at;
    delete updates.usage_count; // Don't allow manual count changes

    if (updates.code) {
      updates.code = updates.code.toUpperCase();
    }

    const { data, error } = await supabaseAdmin
      .from('discounts')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json({ discount: data });
  } catch (error) {
    console.error('Update discount error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete discount (admin only)
router.delete('/:id', authenticateToken, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { id } = req.params;

    if (!supabaseAdmin) {
      return res.status(400).json({ error: 'Database not configured' });
    }

    const { error } = await supabaseAdmin
      .from('discounts')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({ message: 'Discount deleted' });
  } catch (error) {
    console.error('Delete discount error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
