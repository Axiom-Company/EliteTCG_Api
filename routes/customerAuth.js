import { Router } from 'express';
import { z } from 'zod';
import { authenticateCustomer } from '../middleware/auth.js';
import { supabase, supabaseAdmin } from '../config/supabase.js';

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

/**
 * @openapi
 * /customer/register:
 *   post:
 *     tags: [Customer Auth]
 *     summary: Register a new customer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, first_name, last_name]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 minLength: 8
 *               first_name:
 *                 type: string
 *               last_name:
 *                 type: string
 *               phone:
 *                 type: string
 *               accepts_marketing:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Account created
 *       400:
 *         description: Validation failed
 *       409:
 *         description: Email already registered
 *       500:
 *         description: Server error
 */
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

    if (supabase && supabaseAdmin) {
      // Check if customer already exists in our table
      const { data: existing } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('email', email.toLowerCase())
        .single();

      if (existing) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      // Create auth user via Supabase Auth (anon client)
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email: email.toLowerCase(),
        password,
        options: {
          data: {
            first_name,
            last_name,
            phone
          }
        }
      });

      if (authError) {
        console.error('Supabase auth signup error:', authError);

        // Supabase returns this when email is already registered
        if (authError.message && authError.message.toLowerCase().includes('already registered')) {
          return res.status(409).json({ error: 'Email already registered' });
        }
        return res.status(500).json({ error: 'Failed to create account' });
      }

      if (!authData.user) {
        return res.status(500).json({ error: 'Failed to create account' });
      }

      const authUserId = authData.user.id;

      // Update profile fields (DB trigger already created the row from auth.users INSERT)
      // Small delay to ensure trigger has fired
      await new Promise(r => setTimeout(r, 200));

      const { data: customer, error: updateError } = await supabaseAdmin
        .from('profiles')
        .update({
          first_name,
          last_name,
          name: `${first_name} ${last_name}`,
          phone: phone || null,
          accepts_marketing,
          is_active: true,
          role: 'user'
        })
        .eq('id', authUserId)
        .select()
        .single();

      if (updateError) {
        console.error('Customer update error:', updateError);
        return res.status(500).json({ error: 'Failed to create account profile' });
      }

      // Return the Supabase access token if a session was created,
      // otherwise tell the user to confirm their email
      const token = authData.session?.access_token || null;

      res.status(201).json({
        message: token ? 'Account created successfully' : 'Account created. Please check your email to confirm.',
        token,
        user: {
          id: customer.id,
          email: customer.email,
          first_name: customer.first_name,
          last_name: customer.last_name,
          name: customer.name,
          role: customer.role
        }
      });
    } else {
      // Mock fallback
      const existing = mockCustomers.find(c => c.email === email.toLowerCase());
      if (existing) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      const customer = {
        id: `mock-${Date.now()}`,
        email: email.toLowerCase(),
        first_name,
        last_name,
        name: `${first_name} ${last_name}`,
        phone,
        accepts_marketing,
        is_active: true,
        role: 'user',
        created_at: new Date().toISOString()
      };
      mockCustomers.push(customer);

      res.status(201).json({
        message: 'Account created successfully',
        token: 'mock-token',
        user: {
          id: customer.id,
          email: customer.email,
          first_name: customer.first_name,
          last_name: customer.last_name,
          name: customer.name,
          role: customer.role
        }
      });
    }
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /customer/login:
 *   post:
 *     tags: [Customer Auth]
 *     summary: Login a customer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful, returns JWT token
 *       400:
 *         description: Validation failed
 *       401:
 *         description: Invalid email or password
 *       500:
 *         description: Server error
 */
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

    if (supabase && supabaseAdmin) {
      // Authenticate via Supabase Auth
      const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
        email: email.toLowerCase(),
        password
      });

      if (authError || !authData.user || !authData.session) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      // Load customer profile from our table
      const { data: customer, error: profileError } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .eq('id', authData.user.id)
        .eq('is_active', true)
        .single();

      if (profileError || !customer) {
        return res.status(401).json({ error: 'Customer profile not found' });
      }

      // Get seller profile if customer is a seller
      let sellerProfile = null;
      if (['seller', 'verified_seller', 'admin'].includes(customer.role)) {
        sellerProfile = await getSellerProfile(customer.id);
      }

      // Return the Supabase access token so the frontend can use it directly
      res.json({
        token: authData.session.access_token,
        user: {
          id: customer.id,
          email: customer.email,
          first_name: customer.first_name,
          last_name: customer.last_name,
          name: customer.name || `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
          role: customer.role,
          seller_id: sellerProfile?.id || null
        }
      });
    } else {
      // Mock login
      const customer = mockCustomers.find(c => c.email === email.toLowerCase() && c.is_active);
      if (!customer) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      res.json({
        token: 'mock-token',
        user: {
          id: customer.id,
          email: customer.email,
          first_name: customer.first_name,
          last_name: customer.last_name,
          name: customer.name || `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
          role: customer.role,
          seller_id: null
        }
      });
    }
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /customer/me:
 *   get:
 *     tags: [Customer Auth]
 *     summary: Get current customer profile
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Customer profile
 *       404:
 *         description: Customer not found
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
// Get current customer profile
router.get('/me', authenticateCustomer, async (req, res) => {
  try {
    let customer;

    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('profiles')
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
    if (['seller', 'verified_seller', 'admin'].includes(customer.role) && supabaseAdmin) {
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
        role: customer.role,
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

/**
 * @openapi
 * /customer/me:
 *   put:
 *     tags: [Customer Auth]
 *     summary: Update customer profile
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               first_name:
 *                 type: string
 *               last_name:
 *                 type: string
 *               phone:
 *                 type: string
 *               address_line1:
 *                 type: string
 *               address_line2:
 *                 type: string
 *               city:
 *                 type: string
 *               state:
 *                 type: string
 *               postal_code:
 *                 type: string
 *               accepts_marketing:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Profile updated
 *       400:
 *         description: Validation failed
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
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
          .from('profiles')
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
        .from('profiles')
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
        role: customer.role
      }
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /customer/change-password:
 *   post:
 *     tags: [Customer Auth]
 *     summary: Change customer password
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword, newPassword]
 *             properties:
 *               currentPassword:
 *                 type: string
 *               newPassword:
 *                 type: string
 *                 minLength: 8
 *     responses:
 *       200:
 *         description: Password updated
 *       400:
 *         description: Validation failed
 *       401:
 *         description: Current password incorrect
 *       500:
 *         description: Server error
 */
// Change password (via Supabase Auth admin API)
router.post('/change-password', authenticateCustomer, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    if (supabase && supabaseAdmin) {
      // Verify current password by attempting to sign in
      const { error: verifyError } = await supabase.auth.signInWithPassword({
        email: req.customer.email,
        password: currentPassword
      });

      if (verifyError) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }

      // Update password via admin API
      const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
        req.customer.id,
        { password: newPassword }
      );

      if (updateError) {
        console.error('Password update error:', updateError);
        return res.status(500).json({ error: 'Failed to update password' });
      }

      res.json({ message: 'Password updated successfully' });
    } else {
      // Mock -- just acknowledge
      res.json({ message: 'Password updated successfully' });
    }
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /customer/forgot-password:
 *   post:
 *     tags: [Customer Auth]
 *     summary: Request password reset email
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: Reset email sent (always returns success to prevent enumeration)
 *       500:
 *         description: Server error
 */
// Request password reset (via Supabase Auth)
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    if (supabase) {
      // Supabase sends the reset email automatically
      const { error } = await supabase.auth.resetPasswordForEmail(email.toLowerCase(), {
        redirectTo: `${process.env.FRONTEND_URL || 'https://www.elitetcg.co.za'}/reset-password`
      });

      if (error) {
        console.error('Password reset error:', error);
      }
    }

    // Always return the same message to prevent email enumeration
    res.json({
      message: 'If an account with that email exists, a password reset link has been sent.'
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
