import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables
dotenv.config();

// Import routes
import authRoutes from './routes/auth.js';
import customerAuthRoutes from './routes/customerAuth.js';
import productRoutes from './routes/products.js';
import setRoutes from './routes/sets.js';
import categoryRoutes from './routes/categories.js';
import configRoutes from './routes/config.js';
import preorderRoutes from './routes/preorders.js';
import discountRoutes from './routes/discounts.js';
import uploadRoutes from './routes/upload.js';
import sellerRoutes from './routes/sellers.js';
import sellerApplicationRoutes from './routes/sellerApplications.js';
import marketplaceRoutes from './routes/marketplace.js';
import sellerAnalyticsRoutes from './routes/sellerAnalytics.js';
import reviewRoutes from './routes/reviews.js';
import verificationRoutes from './routes/verification.js';
import adminApiRoutes from './routes/adminApi.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// CORS configuration
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://elitetcg.co.za',
  'https://www.elitetcg.co.za',
];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (/^http:\/\/localhost:\d+$/.test(origin)) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// Rate limiting
const isDev = process.env.NODE_ENV !== 'production';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 10000 : 300,
  skip: (req) => req.ip === '127.0.0.1' || req.ip === '::1',
  message: { error: 'Too many requests, please try again later' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 100 : 10,
  skip: (req) => req.ip === '127.0.0.1' || req.ip === '::1',
  message: { error: 'Too many login attempts, please try again later' }
});

app.use('/api/', limiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/customer/login', authLimiter);
app.use('/api/customer/register', authLimiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve uploaded product images
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/customer', customerAuthRoutes);
app.use('/api/products', productRoutes);
app.use('/api/sets', setRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/config', configRoutes);
app.use('/api/preorders', preorderRoutes);
app.use('/api/discounts', discountRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/sellers', sellerRoutes);
app.use('/api/admin/seller-applications', sellerApplicationRoutes);
app.use('/api/marketplace', marketplaceRoutes);
app.use('/api/seller/analytics', sellerAnalyticsRoutes);
app.use('/api/marketplace/reviews', reviewRoutes);
app.use('/api/sellers/verification', verificationRoutes);
app.use('/api/v1', adminApiRoutes);

// 404 handler
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server (for standalone deployment)
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔════════════════════════════════════════════╗
║                                            ║
║   EliteTCG API Server                      ║
║   Running on port ${PORT}                     ║
║   Environment: ${process.env.NODE_ENV || 'development'}         ║
║                                            ║
║   Endpoints:                               ║
║   - GET  /api/health                       ║
║   - POST /api/auth/login (admin)           ║
║   - POST /api/customer/register            ║
║   - POST /api/customer/login               ║
║   - GET  /api/products                     ║
║   - GET  /api/sets                         ║
║   - GET  /api/config                       ║
║   - GET  /api/preorders                    ║
║   - POST /api/discounts/validate           ║
║                                            ║
╚════════════════════════════════════════════╝
    `);

  });
}

export default app;
