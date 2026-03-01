import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ordersFilePath = path.join(__dirname, '..', 'data', 'orders.json');

// All admin routes require a valid admin JWT
router.use(authenticateToken);

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

// ── Dashboard ─────────────────────────────────────────────────────────────────

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

  res.json({ orders: paginated, total, page: pageNum, pages: Math.ceil(total / limitNum) });
});

router.get('/orders/admin/:id', (req, res) => {
  const orders = loadOrders();
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ detail: 'Order not found' });
  res.json(order);
});

router.put('/orders/admin/:id/status', (req, res) => {
  const { status } = req.body;
  const orders = loadOrders();
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ detail: 'Order not found' });
  orders[idx] = { ...orders[idx], status, updated_at: new Date().toISOString() };
  saveOrders(orders);
  res.json(orders[idx]);
});

router.put('/orders/admin/:id/tracking', (req, res) => {
  const { tracking_number } = req.body;
  const orders = loadOrders();
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ detail: 'Order not found' });
  orders[idx] = { ...orders[idx], tracking_number, updated_at: new Date().toISOString() };
  saveOrders(orders);
  res.json(orders[idx]);
});

router.put('/orders/admin/:id/notes', (req, res) => {
  const { notes } = req.body;
  const orders = loadOrders();
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ detail: 'Order not found' });
  orders[idx] = { ...orders[idx], notes, updated_at: new Date().toISOString() };
  saveOrders(orders);
  res.json(orders[idx]);
});

export default router;
