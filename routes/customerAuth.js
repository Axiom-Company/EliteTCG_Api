import { Router } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { generateCustomerToken, authenticateCustomer } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

// Validation schemas
const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  first_name: z.string().min(1, 'First name is required').max(100),
  last_name: z.string().min(1, 'Last name is required').max(100),
  phone: z.string().optional(),
  accepts_marketing: z.boolean().optional().default(false)
});

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required')
});

const updateProfileSchema = z.object({
  first_name: z.string().min(1).max(100).optional(),
  last_name: z.string().min(1).max(100).optional(),
  phone: z.string().max(50).optional(),
  address_line1: z.string().max(255).optional(),
  address_line2: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  postal_code: z.string().max(20).optional(),
  accepts_marketing: z.boolean().optional()
});

// Mock customer for development (when Supabase not configured)
let mockCustomers = [];

// Helper to get seller profile
const getSellerProfile = async (customerId) => {
  if (!supabaseAdmin) return null;

  const { data } = await supabaseAdmin
    .from('seller_profiles')
    .select('id')
    .eq('customer_id', customerId)
    .eq('is_active', true)
    .single();

  return data;
};

// Register new customer
router.post('/register', async (req, res) => {
  try {
    const validation = registerSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors
      });
    }

    const { email, password, first_name, last_name, phone, accepts_marketing } = validation.data;

    // Check if customer already exists
    if (supabaseAdmin) {
      const { data: existing } = await supabaseAdmin
        .from('customers')
        .select('id')
        .eq('email', email.toLowerCase())
        .single();

      if (existing) {
        return res.status(409).json({ error: 'Email already registered' });
      }
    } else {
      // Mock check
      const existing = mockCustomers.find(c => c.email === email.toLowerCase());
      if (existing) {
        return res.status(409).json({ error: 'Email already registered' });
      }
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 10);

    // Create customer
    let customer;

    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('customers')
        .insert({
          email: email.toLowerCase(),
          password_hash,
          first_name,
          last_name,
          name: `${first_name} ${last_name}`,
          phone,
          accepts_marketing,
          is_active: true,
          is_seller: false
        })
        .select()
        .single();

      if (error) {
        console.error('Registration error:', error);
        return res.status(500).json({ error: 'Failed to create account' });
      }

      customer = data;
    } else {
      // Mock creation
      customer = {
        id: `mock-${Date.now()}`,
        email: email.toLowerCase(),
        password_hash,
        first_name,
        last_name,
        name: `${first_name} ${last_name}`,
        phone,
        accepts_marketing,
        is_active: true,
        is_seller: false,
        created_at: new Date().toISOString()
      };
      mockCustomers.push(customer);
    }

    // Generate token
    const token = generateCustomerToken(customer, null);

    res.status(201).json({
      message: 'Account created successfully',
      token,
      user: {
        id: customer.id,
        email: customer.email,
        first_name: customer.first_name,
        last_name: customer.last_name,
        name: customer.name,
        is_seller: customer.is_seller
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login customer
router.post('/login', async (req, res) => {
  try {
    const validation = loginSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors
      });
    }

    const { email, password } = validation.data;

    let customer;

    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('customers')
        .select('*')
        .eq('email', email.toLowerCase())
        .eq('is_active', true)
        .single();

      if (error || !data) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      customer = data;
    } else {
      // Mock login
      customer = mockCustomers.find(c => c.email === email.toLowerCase() && c.is_active);
      if (!customer) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
    }

    // Verify password
    const validPassword = await bcrypt.compare(password, customer.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Get seller profile if customer is a seller
    let sellerProfile = null;
    if (customer.is_seller) {
      sellerProfile = await getSellerProfile(customer.id);
    }

    // Generate token
    const token = generateCustomerToken(customer, sellerProfile);

    res.json({
      token,
      user: {
        id: customer.id,
        email: customer.email,
        first_name: customer.first_name,
        last_name: customer.last_name,
        name: customer.name || `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
        is_seller: customer.is_seller,
        seller_id: sellerProfile?.id || null
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get current customer profile
router.get('/me', authenticateCustomer, async (req, res) => {
  try {
    let customer;

    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('customers')
        .select('*')
        .eq('id', req.customer.id)
        .single();

      if (error || !data) {
        return res.status(404).json({ error: 'Customer not found' });
      }

      customer = data;
    } else {
      customer = mockCustomers.find(c => c.id === req.customer.id);
      if (!customer) {
        return res.status(404).json({ error: 'Customer not found' });
      }
    }

    // Get seller profile if customer is a seller
    let sellerProfile = null;
    if (customer.is_seller && supabaseAdmin) {
      const { data } = await supabaseAdmin
        .from('seller_profiles')
        .select('*')
        .eq('customer_id', customer.id)
        .single();

      sellerProfile = data;
    }

    res.json({
      user: {
        id: customer.id,
        email: customer.email,
        first_name: customer.first_name,
        last_name: customer.last_name,
        name: customer.name || `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
        phone: customer.phone,
        address_line1: customer.address_line1,
        address_line2: customer.address_line2,
        city: customer.city,
        state: customer.state,
        postal_code: customer.postal_code,
        country: customer.country,
        accepts_marketing: customer.accepts_marketing,
        is_seller: customer.is_seller,
        seller_profile: sellerProfile ? {
          id: sellerProfile.id,
          display_name: sellerProfile.display_name,
          rating: sellerProfile.rating,
          total_sales: sellerProfile.total_sales
        } : null
      }
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update customer profile
router.put('/me', authenticateCustomer, async (req, res) => {
  try {
    const validation = updateProfileSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors
      });
    }

    const updates = validation.data;

    // Update name field if first_name or last_name changed
    if (updates.first_name || updates.last_name) {
      if (supabaseAdmin) {
        const { data: current } = await supabaseAdmin
          .from('customers')
          .select('first_name, last_name')
          .eq('id', req.customer.id)
          .single();

        const firstName = updates.first_name || current?.first_name || '';
        const lastName = updates.last_name || current?.last_name || '';
        updates.name = `${firstName} ${lastName}`.trim();
      }
    }

    let customer;

    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('customers')
        .update(updates)
        .eq('id', req.customer.id)
        .select()
        .single();

      if (error) {
        console.error('Update profile error:', error);
        return res.status(500).json({ error: 'Failed to update profile' });
      }

      customer = data;
    } else {
      // Mock update
      const index = mockCustomers.findIndex(c => c.id === req.customer.id);
      if (index === -1) {
        return res.status(404).json({ error: 'Customer not found' });
      }

      mockCustomers[index] = { ...mockCustomers[index], ...updates };
      customer = mockCustomers[index];
    }

    res.json({
      message: 'Profile updated successfully',
      user: {
        id: customer.id,
        email: customer.email,
        first_name: customer.first_name,
        last_name: customer.last_name,
        name: customer.name,
        phone: customer.phone,
        address_line1: customer.address_line1,
        address_line2: customer.address_line2,
        city: customer.city,
        state: customer.state,
        postal_code: customer.postal_code,
        is_seller: customer.is_seller
      }
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Change password
router.post('/change-password', authenticateCustomer, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    let customer;

    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('customers')
        .select('*')
        .eq('id', req.customer.id)
        .single();

      if (error || !data) {
        return res.status(404).json({ error: 'Customer not found' });
      }

      customer = data;
    } else {
      customer = mockCustomers.find(c => c.id === req.customer.id);
      if (!customer) {
        return res.status(404).json({ error: 'Customer not found' });
      }
    }

    // Verify current password
    const validPassword = await bcrypt.compare(currentPassword, customer.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, 10);

    if (supabaseAdmin) {
      await supabaseAdmin
        .from('customers')
        .update({ password_hash: newPasswordHash })
        .eq('id', req.customer.id);
    } else {
      const index = mockCustomers.findIndex(c => c.id === req.customer.id);
      mockCustomers[index].password_hash = newPasswordHash;
    }

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Request password reset (placeholder - would need email service)
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // In production, this would:
    // 1. Generate a reset token
    // 2. Store it with expiration
    // 3. Send email with reset link

    // For now, just acknowledge the request
    res.json({
      message: 'If an account with that email exists, a password reset link has been sent.'
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
