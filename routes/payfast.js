import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { authenticateCustomer, optionalCustomerAuth } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';
import PayFast from '../utils/payfast.js';
import { calculateCommission } from '../utils/commission.js';

const router = Router();

// Mock storage for development
let mockOrders = [];

// Validation schemas
const createOrderSchema = z.object({
  listing_id: z.string().uuid(),
  quantity: z.number().int().positive().default(1),
  buyer_email: z.string().email(),
  buyer_name: z.string().min(1),
  buyer_phone: z.string().optional(),
  shipping_address: z.object({
    line1: z.string(),
    line2: z.string().optional(),
    city: z.string(),
    province: z.string(),
    postal_code: z.string(),
    country: z.string().default('South Africa')
  }).optional()
});

// Generate order number
function generateOrderNumber() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `ETM-${timestamp}-${random}`;
}

/**
 * @openapi
 * /payfast/create-payment:
 *   post:
 *     tags: [PayFast]
 *     summary: Create a marketplace order and get PayFast payment URL
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [listing_id, buyer_email, buyer_name]
 *             properties:
 *               listing_id:
 *                 type: string
 *                 format: uuid
 *               quantity:
 *                 type: integer
 *                 default: 1
 *               buyer_email:
 *                 type: string
 *                 format: email
 *               buyer_name:
 *                 type: string
 *               buyer_phone:
 *                 type: string
 *               shipping_address:
 *                 type: object
 *                 properties:
 *                   line1:
 *                     type: string
 *                   line2:
 *                     type: string
 *                   city:
 *                     type: string
 *                   province:
 *                     type: string
 *                   postal_code:
 *                     type: string
 *                   country:
 *                     type: string
 *     responses:
 *       200:
 *         description: Order created with PayFast payment URL
 *       400:
 *         description: Validation failed or insufficient stock
 *       404:
 *         description: Listing not found
 *       409:
 *         description: Listing no longer available
 *       500:
 *         description: Server error
 */
// Create order and get payment URL
router.post('/create-payment', optionalCustomerAuth, async (req, res) => {
  try {
    const validation = createOrderSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors
      });
    }

    const { listing_id, quantity, buyer_email, buyer_name, buyer_phone, shipping_address } = validation.data;

    // Get listing
    let listing;
    let seller;

    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('marketplace_listings')
        .select(`
          *,
          seller:seller_profiles(
            id,
            display_name,
            payfast_email
          )
        `)
        .eq('id', listing_id)
        .eq('status', 'active')
        .single();

      if (error || !data) {
        return res.status(404).json({ error: 'Listing not found or no longer available' });
      }

      if (data.quantity < quantity) {
        return res.status(400).json({ error: 'Not enough items in stock' });
      }

      listing = data;
      seller = data.seller;
    } else {
      // Mock data - would need mockListings imported
      return res.status(400).json({ error: 'Payment requires database connection' });
    }

    // Reserve listing to prevent double-purchase (database row lock)
    if (supabaseAdmin) {
      const { data: reserveResult, error: reserveError } = await supabaseAdmin
        .rpc('reserve_listing', {
          p_listing_id: listing_id,
          p_buyer_id: req.customer?.id || null,
          p_quantity: quantity,
        });

      if (reserveError || !reserveResult?.success) {
        return res.status(409).json({
          error: reserveResult?.error || 'This listing is no longer available',
        });
      }
    }

    // Calculate amounts with tiered commission
    const unitPrice = listing.price;
    const subtotal = unitPrice * quantity;
    const commission = calculateCommission(subtotal);
    const platformFee = commission.fee;
    const sellerAmount = subtotal - platformFee;
    const totalAmount = subtotal; // No additional fees for buyer

    // Create order
    const orderNumber = generateOrderNumber();
    const orderData = {
      id: uuidv4(),
      order_number: orderNumber,
      listing_id: listing.id,
      seller_id: listing.seller_id,
      buyer_id: req.customer?.id || null,
      quantity,
      unit_price: unitPrice,
      subtotal,
      platform_fee: platformFee,
      platform_fee_percentage: commission.percentage || 0,
      seller_amount: sellerAmount,
      total_amount: totalAmount,
      currency: 'ZAR',
      status: 'pending',
      payment_status: 'pending',
      buyer_email,
      buyer_name,
      buyer_phone: buyer_phone || null,
      shipping_address: shipping_address || null
    };

    let order;

    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('marketplace_orders')
        .insert(orderData)
        .select()
        .single();

      if (error) {
        console.error('Create order error:', error);
        return res.status(500).json({ error: 'Failed to create order' });
      }

      order = data;
    } else {
      order = { ...orderData, created_at: new Date().toISOString() };
      mockOrders.push(order);
    }

    // Generate PayFast payment data
    const buyer = {
      first_name: buyer_name.split(' ')[0],
      last_name: buyer_name.split(' ').slice(1).join(' '),
      email: buyer_email,
      phone: buyer_phone
    };

    const paymentData = PayFast.generatePaymentData(
      order,
      buyer,
      listing,
      seller?.payfast_email
    );

    // Return payment URL or form data
    res.json({
      order: {
        id: order.id,
        order_number: order.order_number,
        total_amount: order.total_amount
      },
      payment: {
        url: PayFast.buildPaymentUrl(paymentData),
        data: paymentData,
        form_html: PayFast.buildPaymentForm(paymentData)
      }
    });
  } catch (error) {
    console.error('Create payment error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /payfast/notify:
 *   post:
 *     tags: [PayFast]
 *     summary: PayFast ITN webhook for marketplace orders
 *     requestBody:
 *       required: true
 *       content:
 *         application/x-www-form-urlencoded:
 *           schema:
 *             type: object
 *             properties:
 *               m_payment_id:
 *                 type: string
 *               payment_status:
 *                 type: string
 *               amount_gross:
 *                 type: string
 *               pf_payment_id:
 *                 type: string
 *               signature:
 *                 type: string
 *     responses:
 *       200:
 *         description: ITN processed
 *       400:
 *         description: Invalid signature or amount mismatch
 *       403:
 *         description: Invalid source IP
 *       404:
 *         description: Order not found
 *       500:
 *         description: Server error
 */
// PayFast ITN (Instant Transaction Notification) webhook
router.post('/notify', async (req, res) => {
  try {
    const pfData = req.body;
    console.log('PayFast ITN received:', pfData);

    // Validate source IP (in production)
    if (process.env.NODE_ENV === 'production') {
      const sourceIP = req.ip || req.connection?.remoteAddress;
      if (!PayFast.validateIP(sourceIP)) {
        console.warn('Invalid PayFast IP:', sourceIP);
        return res.status(403).send('Invalid source IP');
      }
    }

    // Verify signature
    if (!PayFast.verifySignature(pfData, pfData.signature, PayFast.config.passphrase)) {
      console.warn('Invalid PayFast signature');
      return res.status(400).send('Invalid signature');
    }

    // Get order
    const orderId = pfData.m_payment_id;

    if (!supabaseAdmin) {
      console.log('ITN received but no database - order:', orderId);
      return res.status(200).send('OK');
    }

    const { data: order, error: orderError } = await supabaseAdmin
      .from('marketplace_orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (orderError || !order) {
      console.error('Order not found:', orderId);
      return res.status(404).send('Order not found');
    }

    // Verify amount
    const expectedAmount = parseFloat(order.total_amount).toFixed(2);
    const receivedAmount = parseFloat(pfData.amount_gross).toFixed(2);

    if (expectedAmount !== receivedAmount) {
      console.warn('Amount mismatch:', { expected: expectedAmount, received: receivedAmount });
      return res.status(400).send('Amount mismatch');
    }

    // Process based on payment status
    const paymentStatus = pfData.payment_status;

    if (paymentStatus === 'COMPLETE') {
      // Update order status
      await supabaseAdmin
        .from('marketplace_orders')
        .update({
          status: 'paid',
          payment_status: 'completed',
          payfast_payment_id: pfData.pf_payment_id,
          paid_at: new Date().toISOString()
        })
        .eq('id', orderId);

      // Update listing quantity
      await supabaseAdmin
        .from('marketplace_listings')
        .update({
          quantity: supabaseAdmin.raw(`quantity - ${order.quantity}`),
          sold_quantity: supabaseAdmin.raw(`sold_quantity + ${order.quantity}`)
        })
        .eq('id', order.listing_id);

      // Check if listing should be marked as sold
      const { data: listing } = await supabaseAdmin
        .from('marketplace_listings')
        .select('quantity')
        .eq('id', order.listing_id)
        .single();

      if (listing && listing.quantity <= 0) {
        await supabaseAdmin
          .from('marketplace_listings')
          .update({
            status: 'sold',
            sold_at: new Date().toISOString()
          })
          .eq('id', order.listing_id);
      }

      // Create payout record
      await supabaseAdmin
        .from('seller_payouts')
        .insert({
          seller_id: order.seller_id,
          order_id: order.id,
          amount: order.seller_amount,
          currency: 'ZAR',
          status: 'pending'
        });

      // Mark listing reservation as sold
      await supabaseAdmin
        .from('marketplace_listings')
        .update({ reserve_status: 'sold' })
        .eq('id', order.listing_id);

      console.log('Payment completed for order:', order.order_number);
    } else if (paymentStatus === 'CANCELLED') {
      await supabaseAdmin
        .from('marketplace_orders')
        .update({
          status: 'cancelled',
          payment_status: 'failed'
        })
        .eq('id', orderId);

      // Release listing reservation
      await supabaseAdmin
        .from('marketplace_listings')
        .update({
          reserve_status: 'available',
          reserved_by: null,
          reserved_at: null,
        })
        .eq('id', order.listing_id);

      console.log('Payment cancelled for order:', order.order_number);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('ITN processing error:', error);
    res.status(500).send('Server error');
  }
});

/**
 * @openapi
 * /payfast/return:
 *   get:
 *     tags: [PayFast]
 *     summary: Payment success return URL (redirects to frontend)
 *     responses:
 *       302:
 *         description: Redirect to success page
 */
// Payment success return URL
router.get('/return', (req, res) => {
  // Redirect to success page
  res.redirect('/marketplace/payment/success');
});

/**
 * @openapi
 * /payfast/cancel:
 *   get:
 *     tags: [PayFast]
 *     summary: Payment cancel return URL (redirects to frontend)
 *     responses:
 *       302:
 *         description: Redirect to cancel page
 */
// Payment cancel return URL
router.get('/cancel', (req, res) => {
  // Redirect to cancel page
  res.redirect('/marketplace/payment/cancel');
});

/**
 * @openapi
 * /payfast/order/{orderId}:
 *   get:
 *     tags: [PayFast]
 *     summary: Get marketplace order status
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Order details
 *       403:
 *         description: Not authorized
 *       404:
 *         description: Order not found
 *       500:
 *         description: Server error
 */
// Get order status (for buyer)
router.get('/order/:orderId', optionalCustomerAuth, async (req, res) => {
  try {
    const { orderId } = req.params;

    if (supabaseAdmin) {
      const { data: order, error } = await supabaseAdmin
        .from('marketplace_orders')
        .select(`
          id,
          order_number,
          total_amount,
          status,
          payment_status,
          created_at,
          paid_at,
          listing:marketplace_listings(
            id,
            title,
            images
          )
        `)
        .eq('id', orderId)
        .single();

      if (error || !order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      // Only return order if buyer matches or order is recent (within 24 hours)
      const orderAge = Date.now() - new Date(order.created_at).getTime();
      const isOwner = req.customer && order.buyer_id === req.customer.id;
      const isRecent = orderAge < 24 * 60 * 60 * 1000;

      if (!isOwner && !isRecent) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      res.json({ order });
    } else {
      const order = mockOrders.find(o => o.id === orderId);
      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }
      res.json({ order });
    }
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /payfast/order/{orderId}/confirm-delivery:
 *   patch:
 *     tags: [PayFast]
 *     summary: Buyer confirms order delivery
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Delivery confirmed
 *       400:
 *         description: Invalid order status for confirmation
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Not authorized
 *       404:
 *         description: Order not found
 *       500:
 *         description: Server error
 */
// Buyer confirms delivery
router.patch('/order/:orderId/confirm-delivery', authenticateCustomer, async (req, res) => {
  try {
    const { orderId } = req.params;

    if (!supabaseAdmin) {
      return res.status(400).json({ error: 'Database connection required' });
    }

    const { data: order, error } = await supabaseAdmin
      .from('marketplace_orders')
      .select('id, buyer_id, status')
      .eq('id', orderId)
      .single();

    if (error || !order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.buyer_id !== req.customer.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (order.status !== 'shipped' && order.status !== 'in_transit') {
      return res.status(400).json({ error: `Cannot confirm delivery for order with status: ${order.status}` });
    }

    await supabaseAdmin
      .from('marketplace_orders')
      .update({
        status: 'delivered',
        delivered_at: new Date().toISOString(),
      })
      .eq('id', orderId);

    res.json({ message: 'Delivery confirmed' });
  } catch (error) {
    console.error('Confirm delivery error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
