import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import payflex from '../utils/payflex.js';
import { sendNewOrderNotification, sendOrderConfirmation } from '../utils/email.js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ordersFilePath = path.join(__dirname, '..', 'data', 'orders.json');

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

// ── GET /configuration — min/max amounts ─────────────────────────────────────

router.get('/configuration', async (req, res) => {
  if (!payflex.isConfigured) {
    return res.status(503).json({ detail: 'Payflex not configured' });
  }
  try {
    const config = await payflex.getConfiguration();
    res.json(config);
  } catch (err) {
    console.error('[Payflex] Config error:', err.message);
    res.status(503).json({ detail: 'Payflex unavailable' });
  }
});

// ── POST /create-order — initiate Payflex checkout ───────────────────────────

router.post('/create-order', async (req, res) => {
  if (!payflex.isConfigured) {
    return res.status(503).json({ detail: 'Payflex not configured' });
  }

  try {
    const { order_id } = req.body;
    if (!order_id) {
      return res.status(400).json({ detail: 'order_id is required' });
    }

    const orders = loadOrders();
    const order = orders.find(o => o.id === order_id);
    if (!order) {
      return res.status(404).json({ detail: 'Order not found' });
    }

    if (order.payment_status === 'completed') {
      return res.status(400).json({ detail: 'Order already paid' });
    }

    // If we already have a Payflex order, return existing redirect
    if (order.payflex_order_id && order.payflex_token) {
      const existing = await payflex.getOrder(order.payflex_order_id).catch(() => null);
      if (existing && existing.orderStatus !== 'Declined' && existing.orderStatus !== 'Expired') {
        return res.json({
          token: order.payflex_token,
          redirect_url: existing.redirectUrl || `https://checkout${payflex.sandbox ? '.sandbox' : ''}.payflex.co.za/checkout?token=${order.payflex_token}`,
          order_id: order.payflex_order_id,
        });
      }
    }

    const baseUrl = process.env.PAYFLEX_BASE_URL || process.env.FRONTEND_URL || 'https://www.elitetcg.co.za';
    const apiBaseUrl = process.env.API_BASE_URL || `https://${req.get('host')}`;

    const result = await payflex.createOrder({
      order,
      customer: {
        email: order.customer_email,
        full_name: order.customer_name,
        phone: order.customer_phone,
      },
      redirectUrl: `${baseUrl}/payment/success?provider=payflex&order=${order.order_number}`,
      callbackUrl: `${apiBaseUrl}/api/payflex/webhook`,
    });

    // Save Payflex references on the order
    const idx = orders.findIndex(o => o.id === order_id);
    orders[idx].payflex_order_id = result.orderId || result.token;
    orders[idx].payflex_token = result.token;
    orders[idx].payment_provider = 'payflex';
    saveOrders(orders);

    res.json({
      token: result.token,
      redirect_url: result.redirectUrl,
      order_id: result.orderId,
      expiry: result.expiryDateTime,
    });
  } catch (err) {
    console.error('[Payflex] Create order error:', err.message);
    res.status(500).json({ detail: err.message || 'Failed to create Payflex order' });
  }
});

// ── GET /order/:orderNumber — check order status ─────────────────────────────

router.get('/order/:orderNumber', async (req, res) => {
  try {
    const orders = loadOrders();
    const order = orders.find(o => o.order_number === req.params.orderNumber || o.id === req.params.orderNumber);
    if (!order || !order.payflex_order_id) {
      return res.status(404).json({ detail: 'Payflex order not found' });
    }

    const status = await payflex.getOrder(order.payflex_order_id);
    res.json({
      order_number: order.order_number,
      payflex_status: status.orderStatus,
      payment_status: order.payment_status,
    });
  } catch (err) {
    console.error('[Payflex] Status error:', err.message);
    res.status(500).json({ detail: 'Failed to check status' });
  }
});

// ── POST /webhook — Payflex status callback ──────────────────────────────────

router.post('/webhook', async (req, res) => {
  try {
    const payload = req.body;
    console.log('[Payflex] Webhook received:', JSON.stringify(payload));

    const payflexOrderId = payload.orderId || payload.token;
    if (!payflexOrderId) {
      return res.status(400).json({ detail: 'Missing order identifier' });
    }

    // Never trust webhook alone — verify with Payflex API
    let verified;
    try {
      verified = await payflex.getOrder(payflexOrderId);
    } catch (err) {
      console.error('[Payflex] Webhook verification failed:', err.message);
      return res.status(200).json({ received: true }); // Return 200 to avoid retries
    }

    const orders = loadOrders();
    const idx = orders.findIndex(o => o.payflex_order_id === payflexOrderId || o.payflex_token === payflexOrderId);
    if (idx === -1) {
      console.warn('[Payflex] Webhook for unknown order:', payflexOrderId);
      return res.status(200).json({ received: true });
    }

    const order = orders[idx];
    const status = (verified.orderStatus || '').toLowerCase();

    // Idempotency — skip if already in target status
    if (status === 'approved' && order.payment_status === 'completed') {
      return res.status(200).json({ received: true, already_processed: true });
    }

    // Amount mismatch check
    const payflexAmount = parseFloat(verified.amount?.amount || verified.totalAmount?.amount || 0);
    if (Math.abs(payflexAmount - order.total_amount) > 0.01) {
      console.warn(`[Payflex] Amount mismatch! Order: R${order.total_amount}, Payflex: R${payflexAmount}`);
    }

    // Update order based on status
    if (status === 'approved') {
      orders[idx].status = 'paid';
      orders[idx].payment_status = 'completed';
      orders[idx].payment_provider = 'payflex';
      orders[idx].paid_at = new Date().toISOString();
      saveOrders(orders);

      // Send emails (fire and forget)
      sendOrderConfirmation(
        order.customer_email,
        order.customer_name,
        order.order_number,
        order.total_amount,
        order.items
      ).catch(err => console.error('Email error:', err));

      sendNewOrderNotification(
        order.order_number,
        order.customer_name,
        order.total_amount,
        order.items?.length || 0
      ).catch(err => console.error('Admin email error:', err));

      console.log(`[Payflex] Order ${order.order_number} PAID`);
    } else if (status === 'declined') {
      orders[idx].payment_status = 'failed';
      saveOrders(orders);
      console.log(`[Payflex] Order ${order.order_number} DECLINED`);
    } else if (status === 'cancelled' || status === 'expired') {
      orders[idx].payment_status = 'cancelled';
      orders[idx].cancelled_at = new Date().toISOString();
      saveOrders(orders);
      console.log(`[Payflex] Order ${order.order_number} ${status.toUpperCase()}`);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[Payflex] Webhook error:', err);
    res.status(200).json({ received: true }); // Always 200 to prevent retries
  }
});

// ── POST /refund/:orderNumber — admin refund ─────────────────────────────────

router.post('/refund/:orderNumber', async (req, res) => {
  try {
    const orders = loadOrders();
    const order = orders.find(o => o.order_number === req.params.orderNumber);
    if (!order || !order.payflex_order_id) {
      return res.status(404).json({ detail: 'Payflex order not found' });
    }

    const amount = req.body.amount || order.total_amount;
    const result = await payflex.refund(order.payflex_order_id, amount);

    const idx = orders.findIndex(o => o.order_number === req.params.orderNumber);
    orders[idx].status = 'refunded';
    orders[idx].payment_status = 'refunded';
    orders[idx].refunded_at = new Date().toISOString();
    saveOrders(orders);

    res.json({ success: true, refund: result });
  } catch (err) {
    console.error('[Payflex] Refund error:', err.message);
    res.status(500).json({ detail: err.message || 'Refund failed' });
  }
});

export default router;
