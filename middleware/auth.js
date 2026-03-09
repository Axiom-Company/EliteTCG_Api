import { supabaseAdmin } from '../config/supabase.js';

// ── Shared helper ──────────────────────────────────────────────────────────────

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

// ── Admin / dashboard auth (Supabase token + role check from profiles) ──────

export const authenticateSupabaseUser = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  const supaUser = await verifySupabaseToken(token);
  if (!supaUser) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }

  // Load role from profiles table
  let role = 'user';
  if (supabaseAdmin) {
    const { data } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', supaUser.id)
      .single();
    if (data?.role) role = data.role;
  }

  req.user = {
    id: supaUser.id,
    email: supaUser.email,
    role
  };
  next();
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

// ── Customer auth (Supabase only — verifies via Supabase Auth API) ──

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
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', req.customer.id)
      .single();

    if (!profile || !['seller', 'verified_seller', 'admin'].includes(profile.role)) {
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

    req.customer.role = profile.role;
    req.customer.seller_id = sellerProfile.id;
    next();
  } catch (error) {
    console.error('requireSeller DB lookup error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ── Page access check (requires authenticateCustomer first) ──

export const requirePageAccess = (pagePath) => {
  return async (req, res, next) => {
    if (!req.customer) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!supabaseAdmin) return next();

    try {
      // Check if page has any rules at all
      const { data: rules } = await supabaseAdmin
        .from('page_access')
        .select('id')
        .eq('page_path', pagePath)
        .limit(1);

      // No rules = open to everyone
      if (!rules || rules.length === 0) return next();

      // Check if user has access
      const { data: access } = await supabaseAdmin
        .from('page_access')
        .select('id')
        .eq('page_path', pagePath)
        .eq('user_email', req.customer.email)
        .limit(1);

      if (access && access.length > 0) return next();

      return res.status(403).json({ error: 'You do not have access to this feature' });
    } catch (err) {
      console.error('[PageAccess] middleware error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  };
};

export default {
  authenticateSupabaseUser,
  requireRole,
  authenticateCustomer,
  optionalCustomerAuth,
  requireSeller,
  requirePageAccess
};
