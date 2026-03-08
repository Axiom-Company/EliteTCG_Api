import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { authenticateSupabaseUser } from '../middleware/auth.js';
import { sendShippingNotification } from '../utils/email.js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ordersFilePath = path.join(__dirname, '..', 'data', 'orders.json');

// All admin routes require a valid admin JWT
router.use(authenticateSupabaseUser);

function loadOrders() {
  try {
    if (fs.existsSync(ordersFilePath)) {
      return JSON.parse(fs.readFileSync(ordersFilePath, 'utf-8'));
    }
  } catch {}
  return [];
}

function saveOrders(orders) {
  fs.writeFileSync(ordersFilePath, JSON.stringify(orders, null, 2));
}

/**
 * Normalize internal order format to the shape the admin frontend expects.
 */
function normalizeOrder(o) {
  const addr = o.shipping_address || {};
  return {
    ...o,
    // Field aliases the admin frontend reads
    guest_name: o.customer_name,
    guest_email: o.customer_email,
    order_status: o.status,
    total_zar: o.total_amount,
    subtotal_zar: o.subtotal,
    shipping_cost_zar: o.shipping_amount,
    courier_tracking_number: o.tracking_number || null,
    courier_booking_reference: o.booking_reference || null,
    seller_notes: o.notes || '',
    shipping_address_line1: addr.street_address || '',
    shipping_address_line2: addr.apartment || '',
    shipping_city: addr.city || '',
    shipping_province: addr.province || '',
    shipping_postal_code: addr.postal_code || '',
    // Normalize items
    items: (o.items || []).map(item => ({
      ...item,
      unit_price_zar: item.unit_price,
      line_total_zar: item.total || (item.unit_price * item.quantity),
      photo_url: item.product_image || null,
    })),
  };
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

/**
 * @openapi
 * /v1/dashboard/admin:
 *   get:
 *     tags: [Admin API]
 *     summary: Get admin dashboard stats and recent orders
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard stats, revenue by day, status breakdown, recent orders
 *       401:
 *         description: Unauthorized
 */
router.get('/dashboard/admin', (req, res) => {
  const orders = loadOrders();

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - 7);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const paid = orders.filter(o => o.payment_status === 'completed' || o.status === 'paid');

  const total_revenue_zar = paid.reduce((s, o) => s + (o.total_amount || 0), 0);
  const revenue_this_week_zar = paid
    .filter(o => new Date(o.created_at) >= startOfWeek)
    .reduce((s, o) => s + (o.total_amount || 0), 0);
  const revenue_this_month_zar = paid
    .filter(o => new Date(o.created_at) >= startOfMonth)
    .reduce((s, o) => s + (o.total_amount || 0), 0);
  const revenue_today_zar = paid
    .filter(o => new Date(o.created_at) >= startOfToday)
    .reduce((s, o) => s + (o.total_amount || 0), 0);

  const orders_this_month = orders.filter(o => new Date(o.created_at) >= startOfMonth).length;
  const orders_today = orders.filter(o => new Date(o.created_at) >= startOfToday).length;
  const avg_order_value_zar = paid.length ? total_revenue_zar / paid.length : 0;

  // Revenue by day (last 30 days)
  const dayMap = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    dayMap[key] = 0;
  }
  paid.forEach(o => {
    const key = o.created_at?.slice(0, 10);
    if (key && dayMap[key] !== undefined) dayMap[key] += o.total_amount || 0;
  });
  const revenue_by_day = Object.entries(dayMap).map(([date, revenue_zar]) => ({ date, revenue_zar }));

  // Status breakdown
  const statusMap = {};
  orders.forEach(o => {
    const s = o.status || 'pending';
    statusMap[s] = (statusMap[s] || 0) + 1;
  });
  const status_breakdown = Object.entries(statusMap).map(([status, count]) => ({ status, count }));

  // Recent orders (last 10)
  const recent_orders = [...orders]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 10);

  res.json({
    stats: {
      total_revenue_zar,
      revenue_this_week_zar,
      revenue_this_month_zar,
      revenue_today_zar,
      total_orders: orders.length,
      orders_this_month,
      orders_today,
      avg_order_value_zar,
    },
    revenue_by_day,
    status_breakdown,
    recent_orders,
  });
});

// ── Orders ────────────────────────────────────────────────────────────────────

/**
 * @openapi
 * /v1/orders/admin:
 *   get:
 *     tags: [Admin API]
 *     summary: Get all orders (admin)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search by order number, email, or name
 *     responses:
 *       200:
 *         description: Paginated orders
 *       401:
 *         description: Unauthorized
 */
router.get('/orders/admin', (req, res) => {
  const { status, page = 1, limit = 20, search } = req.query;
  let orders = loadOrders().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  if (status && status !== 'all') {
    orders = orders.filter(o => o.status === status);
  }
  if (search) {
    const q = search.toLowerCase();
    orders = orders.filter(o =>
      o.order_number?.toLowerCase().includes(q) ||
      o.customer_email?.toLowerCase().includes(q) ||
      o.customer_name?.toLowerCase().includes(q)
    );
  }

  const total = orders.length;
  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const paginated = orders.slice((pageNum - 1) * limitNum, pageNum * limitNum);

  res.json({
    items: paginated.map(normalizeOrder),
    orders: paginated.map(normalizeOrder),
    total,
    total_count: total,
    total_pages: Math.ceil(total / limitNum),
    page: pageNum,
    pages: Math.ceil(total / limitNum),
  });
});

/**
 * @openapi
 * /v1/orders/admin/{id}:
 *   get:
 *     tags: [Admin API]
 *     summary: Get order by ID (admin)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Order details
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Order not found
 */
router.get('/orders/admin/:id', (req, res) => {
  const orders = loadOrders();
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ detail: 'Order not found' });
  res.json(normalizeOrder(order));
});

/**
 * @openapi
 * /v1/orders/admin/{id}/status:
 *   put:
 *     tags: [Admin API]
 *     summary: Update order status (admin)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *     responses:
 *       200:
 *         description: Order status updated
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Order not found
 */
router.put('/orders/admin/:id/status', (req, res) => {
  const { status } = req.body;
  const orders = loadOrders();
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ detail: 'Order not found' });
  orders[idx] = { ...orders[idx], status, updated_at: new Date().toISOString() };
  saveOrders(orders);

  // Send shipping email when marked as shipped with tracking
  if (status === 'shipped' && orders[idx].tracking_number) {
    sendShippingNotification(
      orders[idx].customer_email,
      orders[idx].customer_name,
      orders[idx].order_number,
      orders[idx].tracking_number
    ).catch(err => console.error('Failed to send shipping email:', err));
  }

  res.json(normalizeOrder(orders[idx]));
});

/**
 * @openapi
 * /v1/orders/admin/{id}/tracking:
 *   put:
 *     tags: [Admin API]
 *     summary: Update order tracking number (admin)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [tracking_number]
 *             properties:
 *               tracking_number:
 *                 type: string
 *     responses:
 *       200:
 *         description: Tracking number updated
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Order not found
 */
router.put('/orders/admin/:id/tracking', (req, res) => {
  const { tracking_number } = req.body;
  const orders = loadOrders();
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ detail: 'Order not found' });
  orders[idx] = {
    ...orders[idx],
    tracking_number,
    status: 'shipped',
    updated_at: new Date().toISOString(),
  };
  saveOrders(orders);

  // Send shipping notification email
  sendShippingNotification(
    orders[idx].customer_email,
    orders[idx].customer_name,
    orders[idx].order_number,
    tracking_number
  ).catch(err => console.error('Failed to send shipping email:', err));

  res.json(normalizeOrder(orders[idx]));
});

/**
 * @openapi
 * /v1/orders/admin/{id}/notes:
 *   put:
 *     tags: [Admin API]
 *     summary: Update order notes (admin)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [notes]
 *             properties:
 *               notes:
 *                 type: string
 *     responses:
 *       200:
 *         description: Notes updated
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Order not found
 */
router.put('/orders/admin/:id/notes', (req, res) => {
  const { notes } = req.body;
  const orders = loadOrders();
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ detail: 'Order not found' });
  orders[idx] = { ...orders[idx], notes, updated_at: new Date().toISOString() };
  saveOrders(orders);
  res.json(normalizeOrder(orders[idx]));
});

export default router;
