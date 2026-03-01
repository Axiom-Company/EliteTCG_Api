import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import PayFast from '../utils/payfast.js';

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
 * POST /api/v1/checkout/direct
 * Body: { items, customer, shipping }
 */
router.post('/direct', async (req, res) => {
  try {
    const { items, customer, shipping } = req.body;

    if (!items?.length || !customer?.email || !shipping?.address_line1) {
      return res.status(400).json({ detail: 'items, customer.email and shipping.address_line1 are required' });
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
    const paymentData = PayFast.generateStorePaymentData(order, buyer);

    return res.json({
      order: {
        id: order.id,
        order_number: order.order_number,
        total_amount: order.total_amount,
      },
      payment_url: PayFast.buildPaymentUrl(paymentData),
      payment_data: paymentData,
    });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

export default router;
