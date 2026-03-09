/**
 * Page Access Routes — /api/page-access
 *
 * Controls which users can access which pages.
 * Admin endpoints for managing access rules.
 * Customer endpoint for checking access.
 */

import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticateSupabaseUser, requireRole, authenticateCustomer } from '../middleware/auth.js';

const router = Router();

// ── Check if current user has access to a page ──────────────────────────────
router.get('/check', authenticateCustomer, async (req, res) => {
  const { page } = req.query;
  if (!page) return res.status(400).json({ error: 'page query param required' });

  try {
    // Check if page has any access rules at all
    const { data: rules } = await supabaseAdmin
      .from('page_access')
      .select('id')
      .eq('page_path', page)
      .limit(1);

    // If no rules exist for this page, it's open to everyone
    if (!rules || rules.length === 0) {
      return res.json({ allowed: true, reason: 'no_restrictions' });
    }

    // Check if this user has access
    const { data: access } = await supabaseAdmin
      .from('page_access')
      .select('id')
      .eq('page_path', page)
      .eq('user_email', req.customer.email)
      .limit(1);

    if (access && access.length > 0) {
      return res.json({ allowed: true });
    }

    return res.json({ allowed: false, reason: 'no_access' });
  } catch (err) {
    console.error('[PageAccess] check error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── Admin: List all access rules ──────────────────────────────────────────────
router.get('/', authenticateSupabaseUser, requireRole('admin'), async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('page_access')
      .select('*')
      .order('page_path')
      .order('user_email');

    if (error) throw error;
    res.json({ rules: data || [] });
  } catch (err) {
    console.error('[PageAccess] list error:', err);
    res.status(500).json({ error: 'Failed to fetch access rules' });
  }
});

// ── Admin: Add access rule ────────────────────────────────────────────────────
router.post('/', authenticateSupabaseUser, requireRole('admin'), async (req, res) => {
  const { page_path, user_email } = req.body;

  if (!page_path || !user_email) {
    return res.status(400).json({ error: 'page_path and user_email required' });
  }

  try {
    // Check if rule already exists
    const { data: existing } = await supabaseAdmin
      .from('page_access')
      .select('id')
      .eq('page_path', page_path)
      .eq('user_email', user_email.toLowerCase())
      .limit(1);

    if (existing && existing.length > 0) {
      return res.status(409).json({ error: 'Access rule already exists' });
    }

    const { data, error } = await supabaseAdmin
      .from('page_access')
      .insert({
        page_path,
        user_email: user_email.toLowerCase(),
        granted_by: req.user.email,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ rule: data });
  } catch (err) {
    console.error('[PageAccess] create error:', err);
    res.status(500).json({ error: 'Failed to create access rule' });
  }
});

// ── Admin: Delete access rule ─────────────────────────────────────────────────
router.delete('/:id', authenticateSupabaseUser, requireRole('admin'), async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('page_access')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('[PageAccess] delete error:', err);
    res.status(500).json({ error: 'Failed to delete access rule' });
  }
});

export default router;
