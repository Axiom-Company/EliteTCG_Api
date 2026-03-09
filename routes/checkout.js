import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import PayFast from '../utils/payfast.js';
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

function generateOrderNumber() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `ETS-${timestamp}-${random}`;
}

/**
 * @openapi
 * /v1/checkout/direct:
 *   post:
 *     tags: [Checkout]
 *     summary: Create a direct checkout order with PayFast payment
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [items, customer, shipping]
 *             properties:
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     product_id:
 *                       type: string
 *                     name:
 *                       type: string
 *                     unit_price_zar:
 *                       type: number
 *                     quantity:
 *                       type: integer
 *                     image_url:
 *                       type: string
 *               customer:
 *                 type: object
 *                 required: [email]
 *                 properties:
 *                   email:
 *                     type: string
 *                     format: email
 *                   full_name:
 *                     type: string
 *                   phone:
 *                     type: string
 *               shipping:
 *                 type: object
 *                 required: [address_line1]
 *                 properties:
 *                   address_line1:
 *                     type: string
 *                   city:
 *                     type: string
 *                   province:
 *                     type: string
 *                   postal_code:
 *                     type: string
 *                   cost_zar:
 *                     type: number
 *                   method:
 *                     type: string
 *     responses:
 *       200:
 *         description: Order created with payment URL
 *       400:
 *         description: Missing required fields
 *       500:
 *         description: Server error
 */
router.post('/direct', async (req, res) => {
  try {
    const { items, customer, shipping, payment_provider = 'payfast', turnstile_token } = req.body;

    if (!items?.length || !customer?.email || !shipping?.address_line1) {
      return res.status(400).json({ detail: 'items, customer.email and shipping.address_line1 are required' });
    }

    // Verify Cloudflare Turnstile
    const turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
    if (turnstileSecret) {
      if (!turnstile_token) {
        return res.status(400).json({ detail: 'Security verification required' });
      }
      try {
        const cfRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret: turnstileSecret, response: turnstile_token }),
        });
        const cfData = await cfRes.json();
        if (!cfData.success) {
          return res.status(403).json({ detail: 'Security verification failed — please try again' });
        }
      } catch (err) {
        console.error('[Turnstile] Verification error:', err.message);
        // Allow through if Turnstile is down — don't block legitimate orders
      }
    }

    const subtotal = items.reduce((sum, item) => sum + (item.unit_price_zar * item.quantity), 0);
    const shippingCost = shipping.cost_zar || 0;
    const totalAmount = parseFloat((subtotal + shippingCost).toFixed(2));

    const nameParts = (customer.full_name || '').trim().split(' ');
    const firstName = nameParts[0] || 'Customer';
    const lastName = nameParts.slice(1).join(' ') || '';

    const order = {
      id: uuidv4(),
      order_number: generateOrderNumber(),
      customer_email: customer.email,
      customer_name: customer.full_name,
      customer_phone: customer.phone || '',
      shipping_address: {
        street_address: shipping.address_line1,
        city: shipping.city,
        province: shipping.province,
        postal_code: shipping.postal_code,
        country: 'South Africa',
      },
      items: items.map(item => ({
        product_id: item.product_id,
        product_name: item.name,
        product_image: item.image_url || null,
        quantity: item.quantity,
        unit_price: item.unit_price_zar,
        total: parseFloat((item.unit_price_zar * item.quantity).toFixed(2)),
      })),
      subtotal: parseFloat(subtotal.toFixed(2)),
      shipping_amount: shippingCost,
      shipping_method: shipping.method || 'courier_guy',
      shipping_service: shipping.service_name || null,
      estimated_delivery_days: shipping.estimated_days || null,
      total_amount: totalAmount,
      currency: 'ZAR',
      status: 'pending',
      payment_status: 'pending',
      created_at: new Date().toISOString(),
    };

    const orders = loadOrders();
    orders.push(order);
    saveOrders(orders);

    const buyer = { first_name: firstName, last_name: lastName, email: customer.email, phone: customer.phone || '' };

    // Payflex flow: create order then redirect to Payflex hosted page
    if (payment_provider === 'payflex' && payflex.isConfigured) {
      try {
        const baseUrl = process.env.PAYFLEX_BASE_URL || process.env.FRONTEND_URL || 'https://www.elitetcg.co.za';
        const apiBaseUrl = process.env.API_BASE_URL || `${req.protocol}://${req.get('host')}`;

        const result = await payflex.createOrder({
          order,
          customer: { email: customer.email, full_name: customer.full_name, phone: customer.phone },
          redirectUrl: `${baseUrl}/payment/success?provider=payflex&order=${order.order_number}`,
          callbackUrl: `${apiBaseUrl}/api/payflex/webhook`,
        });

        // Save Payflex refs
        const idx2 = orders.findIndex(o => o.id === order.id);
        orders[idx2].payflex_order_id = result.orderId || result.token;
        orders[idx2].payflex_token = result.token;
        orders[idx2].payment_provider = 'payflex';
        saveOrders(orders);

        return res.json({
          order: { id: order.id, order_number: order.order_number, total_amount: order.total_amount },
          payment_provider: 'payflex',
          payflex_redirect_url: result.redirectUrl,
        });
      } catch (err) {
        console.error('[Checkout] Payflex failed, falling back to PayFast:', err.message);
        // Fall through to PayFast
      }
    }

    // PayFast flow (default)
    const paymentData = PayFast.generateStorePaymentData(order, buyer);

    return res.json({
      order: {
        id: order.id,
        order_number: order.order_number,
        total_amount: order.total_amount,
      },
      payment_provider: 'payfast',
      payfast_url: PayFast.url,
      payment_data: paymentData,
    });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

// ── Confirm payment (called from success page as fallback for ITN) ──────────

router.post('/confirm/:orderId', (req, res) => {
  try {
    const orders = loadOrders();
    const idx = orders.findIndex(o => o.id === req.params.orderId);
    if (idx === -1) return res.status(404).json({ detail: 'Order not found' });

    const order = orders[idx];

    // Only confirm if still pending (ITN may have already confirmed)
    if (order.status === 'pending') {
      orders[idx] = {
        ...order,
        status: 'paid',
        payment_status: 'completed',
        paid_at: new Date().toISOString(),
      };
      saveOrders(orders);

      // Send emails
      sendOrderConfirmation(
        order.customer_email,
        order.customer_name,
        order.order_number,
        order.total_amount,
        order.items
      ).catch(err => console.error('Failed to send order confirmation:', err));

      sendNewOrderNotification(
        order.order_number,
        order.customer_name,
        order.total_amount,
        order.items?.length || 0
      ).catch(err => console.error('Failed to send admin notification:', err));
    }

    const confirmed = orders[idx];
    res.json({
      status: confirmed.status,
      order_number: confirmed.order_number,
      customer_name: confirmed.customer_name || '',
      total_amount: confirmed.total_amount,
      subtotal: confirmed.subtotal,
      shipping_amount: confirmed.shipping_amount,
      shipping_service: confirmed.shipping_service || null,
      estimated_delivery_days: confirmed.estimated_delivery_days || null,
      items: (confirmed.items || []).map(item => ({
        product_name: item.product_name,
        product_image: item.product_image || null,
        quantity: item.quantity,
        unit_price: item.unit_price,
        total: item.total,
      })),
      created_at: confirmed.created_at,
      paid_at: confirmed.paid_at || null,
    });
  } catch (err) {
    console.error('Confirm order error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

// ── Order Tracking (public, no auth) ────────────────────────────────────────

router.get('/track/:orderNumber', (req, res) => {
  try {
    const { orderNumber } = req.params;
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({ detail: 'Email is required' });
    }

    const orders = loadOrders();
    const order = orders.find(
      o => o.order_number === orderNumber && o.customer_email?.toLowerCase() === email.toLowerCase()
    );

    if (!order) {
      return res.status(404).json({ detail: 'Order not found — check your order number and email' });
    }

    // Return safe subset (no internal notes, payment IDs, etc.)
    res.json({
      order_number: order.order_number,
      status: order.status,
      payment_status: order.payment_status,
      total_amount: order.total_amount,
      subtotal: order.subtotal,
      shipping_amount: order.shipping_amount,
      tracking_number: order.tracking_number || null,
      items: (order.items || []).map(item => ({
        product_name: item.product_name,
        quantity: item.quantity,
        unit_price: item.unit_price,
        total: item.total,
      })),
      created_at: order.created_at,
    });
  } catch (err) {
    console.error('Track order error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

// ── My Orders (fetch all orders for an email) ───────────────────────────────

router.get('/my-orders', (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ detail: 'Email is required' });

    const orders = loadOrders();
    const userOrders = orders
      .filter(o => o.customer_email?.toLowerCase() === email.toLowerCase())
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .map(o => ({
        id: o.id,
        order_number: o.order_number,
        customer_name: o.customer_name || '',
        status: o.status,
        payment_status: o.payment_status,
        total_amount: o.total_amount,
        subtotal: o.subtotal,
        shipping_amount: o.shipping_amount,
        shipping_method: o.shipping_method || null,
        shipping_service: o.shipping_service || null,
        shipping_address: o.shipping_address || null,
        estimated_delivery_days: o.estimated_delivery_days || null,
        tracking_number: o.tracking_number || null,
        paid_at: o.paid_at || null,
        shipped_at: o.shipped_at || null,
        delivered_at: o.delivered_at || null,
        cancelled_at: o.cancelled_at || null,
        items: (o.items || []).map(item => ({
          product_id: item.product_id || null,
          product_name: item.product_name,
          product_image: item.product_image || null,
          quantity: item.quantity,
          unit_price: item.unit_price,
          total: item.total,
        })),
        created_at: o.created_at,
      }));

    res.json({ orders: userOrders });
  } catch (err) {
    console.error('My orders error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

export default router;
