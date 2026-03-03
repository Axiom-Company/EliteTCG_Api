import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger.js';

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
import payfastRoutes from './routes/payfast.js';
import ordersRoutes from './routes/orders.js';
import promotionRoutes from './routes/promotions.js';
import shippingRoutes from './routes/shipping.js';
import checkoutRoutes from './routes/checkout.js';
import subscriptionRoutes from './routes/subscriptions.js';
import adminSubscriptionRoutes from './routes/adminSubscriptions.js';
import pullRateRoutes from './routes/pullRates.js';
import priceTrendRoutes from './routes/priceTrends.js';
import contentRoutes from './routes/content.js';
import productReviewRoutes from './routes/productReviews.js';
import discussionRoutes from './routes/discussions.js';
import discordRoutes from './routes/discord.js';
import communityFeedRoutes from './routes/communityFeed.js';
import portfolioRoutes from './routes/portfolio.js';
import chatRoutes from './routes/chat.js';
import { supabaseAdmin } from './config/supabase.js';
import { createDailySnapshots, refreshStalePrices } from './utils/portfolioJobs.js';
import { initChatSocket } from './chat/chatSocket.js';
import { dmBuffer } from './chat/dmBuffer.js';

const app = express();
const PORT = process.env.PORT || 8080;

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

// Swagger docs
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'EliteTCG API Docs',
}));
app.get('/api/docs.json', (req, res) => res.json(swaggerSpec));

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
app.use('/api/payfast', payfastRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/marketplace/promotions', promotionRoutes);
app.use('/api/v1/shipping', shippingRoutes);
app.use('/api/v1/checkout', checkoutRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/admin/subscriptions', adminSubscriptionRoutes);
app.use('/api/v1', adminApiRoutes);
app.use('/api/portfolio', portfolioRoutes);

// Community Hub Routes
app.use('/api/community/pull-rates', pullRateRoutes);
app.use('/api/community/price-trends', priceTrendRoutes);
app.use('/api/community/content', contentRoutes);
app.use('/api/community/reviews', productReviewRoutes);
app.use('/api/community/discussions', discussionRoutes);
app.use('/api/community/discord', discordRoutes);
app.use('/api/community/chat', chatRoutes);
app.use('/api/community', communityFeedRoutes);

// 404 handler
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Create HTTP server for Express + Socket.io
const server = createServer(app);

// Initialize Socket.io chat server
initChatSocket(server, allowedOrigins);

// Load DM conversations from Storage and start periodic backup
dmBuffer.loadFromStorage().then(() => {
  dmBuffer.startBackupInterval();
}).catch(err => {
  console.error('[DMBuffer] Startup load error:', err.message);
  dmBuffer.startBackupInterval();
});

// Start server (for standalone deployment)
if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔════════════════════════════════════════════╗
║                                            ║
║   EliteTCG API Server                      ║
║   Running on port ${PORT}                     ║
║   Environment: ${process.env.NODE_ENV || 'development'}         ║
║   Socket.io: enabled (chat)                ║
║                                            ║
║   Endpoints:                               ║
║   - GET  /api/health                       ║
║   - POST /api/auth/login (admin)           ║
║   - POST /api/customer/register            ║
║   - POST /api/customer/login               ║
║   - GET  /api/products                     ║
║   - GET  /api/sets                         ║
║   - GET  /api/config                       ║
║   - GET  /api/community/chat/channels      ║
║   - WS   /socket.io (chat real-time)       ║
║                                            ║
╚════════════════════════════════════════════╝
    `);

    // Background job: release expired listing reservations every 5 minutes
    if (supabaseAdmin) {
      setInterval(async () => {
        try {
          const { data, error } = await supabaseAdmin.rpc('release_expired_reservations');
          if (!error && data > 0) {
            console.log(`[Cleanup] Released ${data} expired reservation(s)`);
          }
        } catch (err) {
          console.error('[Cleanup] Reservation cleanup error:', err.message);
        }
      }, 5 * 60 * 1000);

      // Background job: expire cancelled subscriptions past their period end (every hour)
      setInterval(async () => {
        try {
          const { data, error } = await supabaseAdmin
            .from('subscriptions')
            .update({ status: 'expired' })
            .eq('status', 'cancelled')
            .lt('expires_at', new Date().toISOString())
            .select('id');

          if (!error && data && data.length > 0) {
            console.log(`[Subscriptions] Expired ${data.length} cancelled subscription(s)`);
          }
        } catch (err) {
          console.error('[Subscriptions] Expiry cleanup error:', err.message);
        }
      }, 60 * 60 * 1000);

    }
  });
}

export default app;
