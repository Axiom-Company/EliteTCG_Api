import jwt from 'jsonwebtoken';
import { supabaseAdmin } from '../config/supabase.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

// Verify JWT token (for admin users)
export const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

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

// Check if user has required role
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

// Generate JWT token
export const generateToken = (user) => {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name
    },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

// Generate JWT token for customers
export const generateCustomerToken = (customer, sellerProfile = null) => {
  return jwt.sign(
    {
      id: customer.id,
      email: customer.email,
      type: 'customer',
      name: customer.name || `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
      is_seller: customer.is_seller || false,
      seller_id: sellerProfile?.id || null
    },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

// Look up customer record from the customers table by Supabase user email
const resolveSupabaseCustomer = async (token) => {
  if (!supabaseAdmin) return null;
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return null;

  const { data: customer } = await supabaseAdmin
    .from('customers')
    .select('id, email, name, first_name, last_name, is_seller')
    .eq('email', user.email)
    .single();

  if (!customer) return null;

  let seller_id = null;
  if (customer.is_seller) {
    const { data: sp } = await supabaseAdmin
      .from('seller_profiles')
      .select('id')
      .eq('customer_id', customer.id)
      .eq('is_active', true)
      .single();
    seller_id = sp?.id || null;
  }

  return { ...customer, type: 'customer', seller_id };
};

// Verify JWT token for customers
export const authenticateCustomer = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  // Try Supabase token first
  try {
    const customer = await resolveSupabaseCustomer(token);
    if (customer) {
      req.customer = customer;
      return next();
    }
  } catch (_) {}

  // Fall back to custom JWT
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'customer') {
      return res.status(403).json({ error: 'Invalid token type' });
    }
    req.customer = decoded;
    return next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// Optional customer authentication (sets req.customer if valid token, continues regardless)
export const optionalCustomerAuth = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token) {
    try {
      const customer = await resolveSupabaseCustomer(token);
      if (customer) {
        req.customer = customer;
        return next();
      }
    } catch (_) {}

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.type === 'customer') {
        req.customer = decoded;
      }
    } catch (_) {}
  }

  next();
};

// Require user to be a verified seller
export const requireSeller = (req, res, next) => {
  if (!req.customer) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (!req.customer.is_seller) {
    return res.status(403).json({ error: 'Seller account required' });
  }

  if (!req.customer.seller_id) {
    return res.status(403).json({ error: 'Seller profile not found' });
  }

  next();
};

export default {
  authenticateToken,
  requireRole,
  generateToken,
  authenticateCustomer,
  optionalCustomerAuth,
  requireSeller,
  generateCustomerToken
};
