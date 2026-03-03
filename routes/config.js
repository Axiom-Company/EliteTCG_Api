import { Router } from 'express';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

// Mock config for development
const mockConfig = {
  announcement_bar_text: 'Free shipping on orders over $50!',
  announcement_bar_enabled: 'true',
  announcement_bar_bg_color: '#E3350D',
  announcement_bar_text_color: '#FFFFFF',
  announcement_bar_link: '/shop',
  free_shipping_threshold: '50',
  low_stock_threshold: '5',
  featured_sets_count: '8',
  featured_products_count: '8',
  preorder_deposit_percentage: '20',
};

// Get all config (public - for frontend)
router.get('/', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      // Return mock config
      const config = {};
      for (const [key, value] of Object.entries(mockConfig)) {
        config[key] = { value, is_active: true };
      }
      return res.json({ config });
    }

    const { data, error } = await supabaseAdmin
      .from('site_config')
      .select('*');

    if (error) throw error;

    // Convert to key-value object
    const config = {};
    for (const item of data) {
      config[item.key] = {
        value: item.value,
        type: item.type,
        is_active: item.is_active
      };
    }

    res.json({ config });
  } catch (error) {
    console.error('Get config error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single config value
router.get('/:key', async (req, res) => {
  try {
    const { key } = req.params;

    if (!supabaseAdmin) {
      if (mockConfig[key] !== undefined) {
        return res.json({ key, value: mockConfig[key], is_active: true });
      }
      return res.status(404).json({ error: 'Config not found' });
    }

    const { data, error } = await supabaseAdmin
      .from('site_config')
      .select('*')
      .eq('key', key)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Config not found' });
    }

    res.json(data);
  } catch (error) {
    console.error('Get config error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update config (admin only)
router.put('/:key', authenticateToken, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { key } = req.params;
    const { value, is_active } = req.body;

    if (!supabaseAdmin) {
      mockConfig[key] = value;
      return res.json({ key, value, is_active: is_active ?? true });
    }

    const updateData = {};
    if (value !== undefined) updateData.value = value;
    if (is_active !== undefined) updateData.is_active = is_active;

    const { data, error } = await supabaseAdmin
      .from('site_config')
      .update(updateData)
      .eq('key', key)
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('Update config error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create new config (admin only)
router.post('/', authenticateToken, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { key, value, type = 'string', description, is_active = true } = req.body;

    if (!key || value === undefined) {
      return res.status(400).json({ error: 'Key and value required' });
    }

    if (!supabaseAdmin) {
      mockConfig[key] = value;
      return res.json({ key, value, type, is_active });
    }

    const { data, error } = await supabaseAdmin
      .from('site_config')
      .insert({ key, value, type, description, is_active })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(data);
  } catch (error) {
    console.error('Create config error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Bulk update config (admin only)
router.put('/', authenticateToken, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const updates = req.body; // Object of { key: value }

    if (!supabaseAdmin) {
      for (const [key, value] of Object.entries(updates)) {
        mockConfig[key] = value;
      }
      return res.json({ message: 'Config updated', config: mockConfig });
    }

    for (const [key, value] of Object.entries(updates)) {
      await supabaseAdmin
        .from('site_config')
        .upsert({ key, value: String(value) }, { onConflict: 'key' });
    }

    res.json({ message: 'Config updated' });
  } catch (error) {
    console.error('Bulk update config error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
