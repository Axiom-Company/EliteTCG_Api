import { Router } from 'express';
import bcrypt from 'bcrypt';
import { generateToken, authenticateToken } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

// Mock admin user for development (when Supabase not configured)
const mockAdminUser = {
  id: '1',
  email: 'admin@elitetcg.com',
  password_hash: '$2b$10$8K1p/a0dL1LXMIgoEDFrwOfMQDf.OS4Do4gSPAYLcJ4GTHX8E1Riy', // admin123
  name: 'Admin',
  role: 'super_admin',
  is_active: true
};

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    let user;

    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('admin_users')
        .select('*')
        .eq('email', email.toLowerCase())
        .eq('is_active', true)
        .single();

      if (error || !data) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      user = data;
    } else {
      if (email.toLowerCase() !== mockAdminUser.email) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      user = mockAdminUser;
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (supabaseAdmin) {
      await supabaseAdmin
        .from('admin_users')
        .update({ last_login: new Date().toISOString() })
        .eq('id', user.id);
    }

    const token = generateToken(user);

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get current user
router.get('/me', authenticateToken, async (req, res) => {
  try {
    res.json({ user: req.user });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Change password
router.post('/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    if (!supabaseAdmin) {
      return res.status(400).json({ error: 'Database not configured' });
    }

    // Get user
    const { data: user, error } = await supabaseAdmin
      .from('admin_users')
      .select('*')
      .eq('id', req.user.id)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify current password
    const validPassword = await bcrypt.compare(currentPassword, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, 10);

    // Update password
    await supabaseAdmin
      .from('admin_users')
      .update({ password_hash: newPasswordHash })
      .eq('id', req.user.id);

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
