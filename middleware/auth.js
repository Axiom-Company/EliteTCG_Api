import jwt from 'jsonwebtoken';

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

// Verify JWT token for customers
export const authenticateCustomer = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Ensure this is a customer token
    if (decoded.type !== 'customer') {
      return res.status(403).json({ error: 'Invalid token type' });
    }

    req.customer = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// Optional customer authentication (sets req.customer if valid token, continues regardless)
export const optionalCustomerAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.type === 'customer') {
        req.customer = decoded;
      }
    } catch (error) {
      // Token invalid, but continue anyway (it's optional)
    }
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
