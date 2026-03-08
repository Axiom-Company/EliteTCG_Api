import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { authenticateSupabaseUser } from '../middleware/auth.js';
import { sendShippingNotification } from '../utils/email.js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ordersFilePath = path.join(__dirname, '..', 'data', 'orders.json');

// Both sandbox and live use the same API URL.
// Sandbox vs live is determined by which API key you use
// (sandbox key from sandbox.shiplogic.com, live key from The Courier Guy).
const BASE_URL = 'https://api.shiplogic.com';
const API_KEY  = process.env.COURIER_GUY_API_KEY;

// Markup percentage on top of courier cost (e.g. 0.15 = 15%)
const MARKUP = parseFloat(process.env.COURIER_GUY_MARKUP || '0.15');

// Sender/origin address — set these in .env
const SENDER = {
  company:        process.env.SENDER_COMPANY        || 'EliteTCG',
  street_address: process.env.SENDER_STREET         || '1 Example Street',
  local_area:     process.env.SENDER_LOCAL_AREA     || 'Sandton',
  city:           process.env.SENDER_CITY           || 'Johannesburg',
  code:           process.env.SENDER_POSTAL_CODE    || '2196',
  zone:           process.env.SENDER_ZONE           || 'GP',
  country_code:   'ZA',
  type:           'business',
};

/**
 * @openapi
 * /v1/shipping/quote:
 *   post:
 *     tags: [Shipping]
 *     summary: Get a shipping quote from Courier Guy
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [address_line1, city, province, postal_code]
 *             properties:
 *               address_line1:
 *                 type: string
 *               city:
 *                 type: string
 *               province:
 *                 type: string
 *               postal_code:
 *                 type: string
 *               total_weight_grams:
 *                 type: number
 *     responses:
 *       200:
 *         description: Shipping quote with courier and customer cost
 *       400:
 *         description: Missing required address fields
 *       404:
 *         description: No shipping rates available
 *       500:
 *         description: Server error
 */
router.post('/quote', async (req, res) => {
  try {
    const { address_line1, city, province, postal_code, total_weight_grams } = req.body;

    if (!address_line1 || !city || !province || !postal_code) {
      return res.status(400).json({ detail: 'address_line1, city, province and postal_code are required' });
    }

    if (!API_KEY) {
      return res.status(500).json({ detail: 'Courier Guy API key not configured' });
    }

    const weightKg = total_weight_grams ? total_weight_grams / 1000 : 1;

    // Map SA province names to zone codes
    const ZONE_MAP = {
      'Gauteng':       'GP', 'Western Cape':   'WC', 'KwaZulu-Natal':  'KZN',
      'Eastern Cape':  'EC', 'Free State':      'FS', 'Limpopo':        'LP',
      'Mpumalanga':    'MP', 'North West':      'NW', 'Northern Cape':  'NC',
    };
    const zone = ZONE_MAP[province] || 'GP';

    const payload = {
      collection_address: SENDER,
      delivery_address: {
        type:           'residential',
        company:        '',
        street_address: address_line1,
        local_area:     city,
        city:           city,
        code:           postal_code,
        zone,
        country_code:   'ZA',
      },
      parcels: [{
        parcel_description:   'TCG Products',
        submitted_length_cm:  30,
        submitted_width_cm:   25,
        submitted_height_cm:  20,
        submitted_weight_kg:  weightKg,
      }],
      declared_value:      500,
      collect_time_from:   '09:00',
      collect_time_to:     '17:00',
      delivery_time_from:  '08:00',
      delivery_time_to:    '17:00',
    };

    console.log('Calling Ship Logic rates:', `${BASE_URL}/rates`);
    const response = await fetch(`${BASE_URL}/rates`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const raw = await response.text();
      console.error('Courier Guy API error status:', response.status);
      console.error('Courier Guy API error body (first 500 chars):', raw.slice(0, 500));
      let error = {};
      try { error = JSON.parse(raw); } catch {}
      return res.status(response.status).json({ detail: error.message || error.detail || 'Failed to get shipping quote' });
    }

    const data = await response.json();

    // Pick cheapest available rate
    const rates = data.rates || [];
    if (rates.length === 0) {
      return res.status(404).json({ detail: 'No shipping rates available for this address' });
    }

    const cheapest = rates.reduce((a, b) => a.rate < b.rate ? a : b);

    const courierCost    = cheapest.rate;
    const customerCost   = parseFloat((courierCost * (1 + MARKUP)).toFixed(2));
    const estimatedDays  = cheapest.estimated_delivery_date
      ? Math.ceil((new Date(cheapest.estimated_delivery_date) - new Date()) / (1000 * 60 * 60 * 24))
      : 3;

    return res.json({
      courier_cost_zar:   courierCost,
      customer_cost_zar:  customerCost,
      handling_fee_zar:   parseFloat((customerCost - courierCost).toFixed(2)),
      estimated_days:     Math.max(1, estimatedDays),
      service_name:       cheapest.service_level_name || cheapest.courier || 'Standard Delivery',
    });

  } catch (err) {
    console.error('Shipping quote error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

/**
 * @openapi
 * /v1/shipping/admin/book:
 *   post:
 *     tags: [Shipping]
 *     summary: Book a Courier Guy shipment for an order (admin)
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [order_id]
 *             properties:
 *               order_id:
 *                 type: string
 *     responses:
 *       200:
 *         description: Shipment booked with tracking number
 *       404:
 *         description: Order not found
 *       500:
 *         description: Server error
 */
router.post('/admin/book', authenticateSupabaseUser, async (req, res) => {
  try {
    const { order_id } = req.body;

    if (!API_KEY) {
      return res.status(500).json({ detail: 'Courier Guy API key not configured' });
    }

    // Load order
    let orders;
    try {
      orders = JSON.parse(fs.readFileSync(ordersFilePath, 'utf-8'));
    } catch {
      orders = [];
    }
    const idx = orders.findIndex(o => o.id === order_id);
    if (idx === -1) return res.status(404).json({ detail: 'Order not found' });

    const order = orders[idx];
    const addr = order.shipping_address || {};

    // Map province to zone code
    const ZONE_MAP = {
      'Gauteng': 'GP', 'Western Cape': 'WC', 'KwaZulu-Natal': 'KZN',
      'Eastern Cape': 'EC', 'Free State': 'FS', 'Limpopo': 'LP',
      'Mpumalanga': 'MP', 'North West': 'NW', 'Northern Cape': 'NC',
    };
    const zone = ZONE_MAP[addr.province] || 'GP';

    // Calculate total weight (estimate 0.5kg per item)
    const totalItems = (order.items || []).reduce((s, i) => s + (i.quantity || 1), 0);
    const weightKg = Math.max(1, totalItems * 0.5);

    // Create shipment via Ship Logic API
    const shipmentPayload = {
      collection_address: SENDER,
      delivery_address: {
        type: 'residential',
        company: '',
        street_address: addr.street_address || addr.address_line1 || '',
        local_area: addr.city || '',
        city: addr.city || '',
        code: addr.postal_code || '',
        zone,
        country_code: 'ZA',
      },
      parcels: [{
        parcel_description: `EliteTCG Order ${order.order_number}`,
        submitted_length_cm: 30,
        submitted_width_cm: 25,
        submitted_height_cm: 20,
        submitted_weight_kg: weightKg,
      }],
      declared_value: order.total_amount || 500,
      collection_min_date: new Date().toISOString().slice(0, 10),
      delivery_min_date: new Date().toISOString().slice(0, 10),
      customer_reference: order.order_number,
      special_instructions_collection: `Order ${order.order_number}`,
      special_instructions_delivery: order.customer_name ? `Deliver to ${order.customer_name}` : '',
    };

    console.log('Booking Courier Guy shipment for order:', order.order_number);
    const response = await fetch(`${BASE_URL}/shipments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(shipmentPayload),
    });

    if (!response.ok) {
      const raw = await response.text();
      console.error('Courier Guy booking error:', response.status, raw.slice(0, 500));
      let error = {};
      try { error = JSON.parse(raw); } catch {}
      return res.status(response.status).json({
        detail: error.message || error.detail || 'Failed to book courier',
      });
    }

    const shipment = await response.json();
    const trackingNumber = shipment.tracking_reference || shipment.short_tracking_reference || '';
    const bookingReference = shipment.id || shipment.reference || '';

    // Update order with tracking info
    orders[idx] = {
      ...order,
      tracking_number: trackingNumber,
      booking_reference: bookingReference,
      status: 'shipped',
      updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(ordersFilePath, JSON.stringify(orders, null, 2));

    // Send shipping notification email
    if (trackingNumber) {
      sendShippingNotification(
        order.customer_email,
        order.customer_name,
        order.order_number,
        trackingNumber
      ).catch(err => console.error('Failed to send shipping email:', err));
    }

    console.log('Courier booked:', { trackingNumber, bookingReference });
    res.json({
      tracking_number: trackingNumber,
      booking_reference: bookingReference,
      shipment_id: shipment.id,
    });

  } catch (err) {
    console.error('Courier booking error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

export default router;
