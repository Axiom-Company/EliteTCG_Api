import { Router } from 'express';
import { z } from 'zod';
import { authenticateSupabaseUser, requireRole } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

// Simple Discord link management - just stores the invite URL for display

const updateLinkSchema = z.object({
  invite_url: z.string().url().max(500),
  server_name: z.string().max(100).optional(),
  member_count: z.number().int().optional(),
  is_active: z.boolean().optional()
});

// Get Discord invite link (public)
router.get('/link', async (req, res) => {
  try {
    const { data: config } = await supabaseAdmin
      .from('discord_config')
      .select('guild_id, webhook_url, is_active')
      .eq('is_active', true)
      .limit(1)
      .single();

    if (!config) {
      return res.json({ discord: null });
    }

    // webhook_url repurposed as invite_url for simplicity
    res.json({
      discord: {
        invite_url: config.webhook_url,
        server_name: config.guild_id || 'EliteTCG Community',
        is_active: config.is_active
      }
    });
  } catch (error) {
    console.error('Get discord link error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update Discord invite link (admin)
router.put('/link', authenticateSupabaseUser, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const validation = updateLinkSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
    }

    const { invite_url, server_name, is_active } = validation.data;

    // Check if config exists
    const { data: existing } = await supabaseAdmin
      .from('discord_config')
      .select('id')
      .limit(1)
      .single();

    const updatePayload = {
      webhook_url: invite_url,
      guild_id: server_name || 'EliteTCG Community',
      is_active: is_active !== false
    };

    let config;
    if (existing) {
      const { data, error } = await supabaseAdmin
        .from('discord_config')
        .update(updatePayload)
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      config = data;
    } else {
      const { data, error } = await supabaseAdmin
        .from('discord_config')
        .insert(updatePayload)
        .select()
        .single();
      if (error) throw error;
      config = data;
    }

    res.json({
      message: 'Discord link updated',
      discord: {
        invite_url: config.webhook_url,
        server_name: config.guild_id,
        is_active: config.is_active
      }
    });
  } catch (error) {
    console.error('Update discord link error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
