import jwt from 'jsonwebtoken';
import { supabaseAdmin } from '../config/supabase.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

// ── Admin auth (custom JWT for dashboard/staff routes) ──

export const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

export const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
};

export const generateToken = (user) => {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

// ── Customer auth (Supabase only — verifies via Supabase Auth API) ──

async function verifySupabaseToken(token) {
  if (!supabaseAdmin) return null;
  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !user) return null;
    return user;
  } catch {
    return null;
  }
}

export const authenticateCustomer = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  const user = await verifySupabaseToken(token);
  if (!user) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }

  req.customer = {
    id: user.id,
    email: user.email,
    type: 'customer'
  };
  next();
};

export const optionalCustomerAuth = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token) {
    const user = await verifySupabaseToken(token);
    if (user) {
      req.customer = {
        id: user.id,
        email: user.email,
        type: 'customer'
      };
    }
  }
  next();
};

export const requireSeller = async (req, res, next) => {
  if (!req.customer) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (!supabaseAdmin) {
    return res.status(403).json({ error: 'Seller account required' });
  }

  try {
    const { data: customer } = await supabaseAdmin
      .from('customers')
      .select('is_seller')
      .eq('id', req.customer.id)
      .single();

    if (!customer || !customer.is_seller) {
      return res.status(403).json({ error: 'Seller account required' });
    }

    const { data: sellerProfile } = await supabaseAdmin
      .from('seller_profiles')
      .select('id')
      .eq('customer_id', req.customer.id)
      .eq('is_active', true)
      .single();

    if (!sellerProfile) {
      return res.status(403).json({ error: 'Seller profile not found' });
    }

    req.customer.is_seller = true;
    req.customer.seller_id = sellerProfile.id;
    next();
  } catch (error) {
    console.error('requireSeller DB lookup error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
};

export default {
  authenticateToken,
  requireRole,
  generateToken,
  authenticateCustomer,
  optionalCustomerAuth,
  requireSeller
};
