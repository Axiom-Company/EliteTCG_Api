import { Router } from 'express';
import { z } from 'zod';
import { authenticateCustomer, requireSeller } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

// Validation schemas
const applySchema = z.object({
  display_name: z.string().min(2, 'Display name must be at least 2 characters').max(100),
  reason: z.string().min(20, 'Please provide more detail about why you want to sell').max(1000),
  experience: z.string().max(1000).optional(),
  payfast_email: z.string().email('Invalid PayFast email'),
  payfast_merchant_id: z.string().max(100).optional()
});

const updateProfileSchema = z.object({
  display_name: z.string().min(2).max(100).optional(),
  bio: z.string().max(500).optional(),
  location_city: z.string().max(100).optional(),
  location_province: z.string().max(50).optional(),
  contact_phone: z.string().max(20).optional(),
  contact_whatsapp: z.string().max(20).optional(),
  contact_email: z.string().email().optional(),
  show_phone: z.boolean().optional(),
  show_whatsapp: z.boolean().optional(),
  show_email: z.boolean().optional(),
  payfast_email: z.string().email().optional(),
  payfast_merchant_id: z.string().max(100).optional()
});

// Mock storage for development
let mockApplications = [];
let mockSellerProfiles = [];

// Submit seller application
router.post('/apply', authenticateCustomer, async (req, res) => {
  try {
    const validation = applySchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors
      });
    }

    const { display_name, reason, experience, payfast_email, payfast_merchant_id } = validation.data;

    // Check if already a seller
    if (req.customer.is_seller) {
      return res.status(400).json({ error: 'You are already a verified seller' });
    }

    // Check if already has pending application
    if (supabaseAdmin) {
      const { data: existing } = await supabaseAdmin
        .from('seller_applications')
        .select('id, status')
        .eq('customer_id', req.customer.id)
        .in('status', ['pending'])
        .single();

      if (existing) {
        return res.status(400).json({ error: 'You already have a pending application' });
      }
    } else {
      const existing = mockApplications.find(
        a => a.customer_id === req.customer.id && a.status === 'pending'
      );
      if (existing) {
        return res.status(400).json({ error: 'You already have a pending application' });
      }
    }

    let application;

    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('seller_applications')
        .insert({
          customer_id: req.customer.id,
          display_name,
          reason,
          experience,
          payfast_email,
          payfast_merchant_id,
          status: 'pending'
        })
        .select()
        .single();

      if (error) {
        console.error('Application submission error:', error);
        return res.status(500).json({ error: 'Failed to submit application' });
      }

      application = data;
    } else {
      application = {
        id: `mock-app-${Date.now()}`,
        customer_id: req.customer.id,
        display_name,
        reason,
        experience,
        payfast_email,
        payfast_merchant_id,
        status: 'pending',
        created_at: new Date().toISOString()
      };
      mockApplications.push(application);
    }

    res.status(201).json({
      message: 'Application submitted successfully',
      application: {
        id: application.id,
        status: application.status,
        created_at: application.created_at
      }
    });
  } catch (error) {
    console.error('Apply error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get application status
router.get('/application-status', authenticateCustomer, async (req, res) => {
  try {
    let application;

    if (supabaseAdmin) {
      const { data } = await supabaseAdmin
        .from('seller_applications')
        .select('*')
        .eq('customer_id', req.customer.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      application = data;
    } else {
      const apps = mockApplications.filter(a => a.customer_id === req.customer.id);
      application = apps.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    }

    if (!application) {
      return res.json({ application: null });
    }

    res.json({
      application: {
        id: application.id,
        display_name: application.display_name,
        status: application.status,
        rejection_reason: application.rejection_reason,
        created_at: application.created_at,
        reviewed_at: application.reviewed_at
      }
    });
  } catch (error) {
    console.error('Get application status error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get own seller profile
router.get('/profile', authenticateCustomer, requireSeller, async (req, res) => {
  try {
    let profile;

    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('seller_profiles')
        .select('*')
        .eq('id', req.customer.seller_id)
        .single();

      if (error || !data) {
        return res.status(404).json({ error: 'Seller profile not found' });
      }

      profile = data;
    } else {
      profile = mockSellerProfiles.find(p => p.id === req.customer.seller_id);
      if (!profile) {
        return res.status(404).json({ error: 'Seller profile not found' });
      }
    }

    res.json({ profile });
  } catch (error) {
    console.error('Get seller profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update seller profile
router.put('/profile', authenticateCustomer, requireSeller, async (req, res) => {
  try {
    const validation = updateProfileSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors
      });
    }

    const updates = validation.data;
    let profile;

    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('seller_profiles')
        .update(updates)
        .eq('id', req.customer.seller_id)
        .select()
        .single();

      if (error) {
        console.error('Update seller profile error:', error);
        return res.status(500).json({ error: 'Failed to update profile' });
      }

      profile = data;
    } else {
      const index = mockSellerProfiles.findIndex(p => p.id === req.customer.seller_id);
      if (index === -1) {
        return res.status(404).json({ error: 'Seller profile not found' });
      }
      mockSellerProfiles[index] = { ...mockSellerProfiles[index], ...updates };
      profile = mockSellerProfiles[index];
    }

    res.json({
      message: 'Profile updated successfully',
      profile
    });
  } catch (error) {
    console.error('Update seller profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get public seller profile
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let profile;

    if (supabaseAdmin) {
      const { data } = await supabaseAdmin
        .from('seller_profiles')
        .select(`
          id,
          display_name,
          bio,
          location_city,
          location_province,
          contact_phone,
          contact_whatsapp,
          contact_email,
          show_phone,
          show_whatsapp,
          show_email,
          total_listings,
          active_listings,
          total_sales,
          rating,
          review_count,
          created_at
        `)
        .eq('id', id)
        .eq('is_active', true)
        .single();

      profile = data;
    } else {
      const found = mockSellerProfiles.find(p => p.id === id && p.is_active);
      if (found) {
        profile = {
          id: found.id,
          display_name: found.display_name,
          bio: found.bio,
          location_city: found.location_city,
          location_province: found.location_province,
          contact_phone: found.show_phone ? found.contact_phone : null,
          contact_whatsapp: found.show_whatsapp ? found.contact_whatsapp : null,
          contact_email: found.show_email ? found.contact_email : null,
          total_listings: found.total_listings,
          active_listings: found.active_listings,
          total_sales: found.total_sales,
          rating: found.rating,
          review_count: found.review_count,
          created_at: found.created_at
        };
      }
    }

    if (!profile) {
      return res.status(404).json({ error: 'Seller not found' });
    }

    // Filter contact info based on visibility settings
    const publicProfile = {
      ...profile,
      contact_phone: profile.show_phone ? profile.contact_phone : null,
      contact_whatsapp: profile.show_whatsapp ? profile.contact_whatsapp : null,
      contact_email: profile.show_email ? profile.contact_email : null
    };

    // Remove visibility flags from response
    delete publicProfile.show_phone;
    delete publicProfile.show_whatsapp;
    delete publicProfile.show_email;

    res.json({ profile: publicProfile });
  } catch (error) {
    console.error('Get public seller profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Export mock data for admin routes
export { mockApplications, mockSellerProfiles };
export default router;
