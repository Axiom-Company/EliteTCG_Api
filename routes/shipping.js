import express from 'express';

const router = express.Router();

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

export default router;
