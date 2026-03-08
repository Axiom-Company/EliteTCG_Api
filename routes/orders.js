import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { optionalCustomerAuth, authenticateCustomer } from '../middleware/auth.js';
import PayFast from '../utils/payfast.js';
import { sendOrderConfirmation, sendNewOrderNotification } from '../utils/email.js';

const router = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ordersFilePath = path.join(__dirname, '..', 'data', 'orders.json');
const productsFilePath = path.join(__dirname, '..', 'data', 'products.json');

// Shipping constants
const SHIPPING_RATE = 99;
const FREE_SHIPPING_THRESHOLD = 1000;

// Load orders from JSON file
function loadOrders() {
  try {
    if (fs.existsSync(ordersFilePath)) {
      const data = fs.readFileSync(ordersFilePath, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error loading orders:', err);
  }
  return [];
}

// Save orders to JSON file
function saveOrders(orders) {
  try {
    fs.writeFileSync(ordersFilePath, JSON.stringify(orders, null, 2));
  } catch (err) {
    console.error('Error saving orders:', err);
  }
}

// Load products
function loadProducts() {
  try {
    const data = fs.readFileSync(productsFilePath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error loading products:', err);
    return [];
  }
}

// Generate order number
function generateOrderNumber() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `ETS-${timestamp}-${random}`;
}

// Validation schemas
const orderItemSchema = z.object({
  productId: z.string(),
  quantity: z.number().int().positive()
});

const shippingAddressSchema = z.object({
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(1),
  street_address: z.string().min(1),
  apartment: z.string().nullable().optional(),
  city: z.string().min(1),
  province: z.string().min(1),
  postal_code: z.string().min(1),
  country: z.string().default('South Africa')
});

const createOrderSchema = z.object({
  items: z.array(orderItemSchema).min(1),
  shipping_address: shippingAddressSchema
});

/**
 * @openapi
 * /orders:
 *   post:
 *     tags: [Orders]
 *     summary: Create an order and get PayFast payment URL
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [items, shipping_address]
 *             properties:
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [productId, quantity]
 *                   properties:
 *                     productId:
 *                       type: string
 *                     quantity:
 *                       type: integer
 *               shipping_address:
 *                 type: object
 *                 required: [first_name, last_name, email, phone, street_address, city, province, postal_code]
 *                 properties:
 *                   first_name:
 *                     type: string
 *                   last_name:
 *                     type: string
 *                   email:
 *                     type: string
 *                     format: email
 *                   phone:
 *                     type: string
 *                   street_address:
 *                     type: string
 *                   apartment:
 *                     type: string
 *                   city:
 *                     type: string
 *                   province:
 *                     type: string
 *                   postal_code:
 *                     type: string
 *                   country:
 *                     type: string
 *                     default: South Africa
 *     responses:
 *       200:
 *         description: Order created with PayFast payment URL
 *       400:
 *         description: Validation failed or insufficient stock
 *       500:
 *         description: Server error
 */
// Create order
router.post('/', optionalCustomerAuth, async (req, res) => {
  try {
    const validation = createOrderSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors
      });
    }

    const { items, shipping_address } = validation.data;
    const products = loadProducts();

    // Validate items and calculate totals
    const orderItems = [];
    let subtotal = 0;

    for (const item of items) {
      const product = products.find(p => p.id === item.productId);

      if (!product) {
        return res.status(400).json({ error: `Product not found: ${item.productId}` });
      }

      const availableQty = product.inventory?.quantity || 0;
      if (availableQty < item.quantity) {
        return res.status(400).json({
          error: `Insufficient stock for ${product.name}. Available: ${availableQty}`
        });
      }

      const itemTotal = product.price * item.quantity;
      subtotal += itemTotal;

      orderItems.push({
        product_id: product.id,
        product_name: product.name,
        product_slug: product.slug,
        product_image: product.images?.[0] || null,
        quantity: item.quantity,
        unit_price: product.price,
        total: itemTotal
      });
    }

    // Calculate shipping
    const shippingAmount = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_RATE;
    const totalAmount = subtotal + shippingAmount;

    // Create order
    const order = {
      id: uuidv4(),
      order_number: generateOrderNumber(),
      customer_id: req.customer?.id || null,
      customer_email: shipping_address.email,
      customer_name: `${shipping_address.first_name} ${shipping_address.last_name}`,
      customer_phone: shipping_address.phone,
      shipping_address: {
        street_address: shipping_address.street_address,
        apartment: shipping_address.apartment || null,
        city: shipping_address.city,
        province: shipping_address.province,
        postal_code: shipping_address.postal_code,
        country: shipping_address.country
      },
      items: orderItems,
      subtotal,
      shipping_amount: shippingAmount,
      total_amount: totalAmount,
      currency: 'ZAR',
      status: 'pending',
      payment_status: 'pending',
      payfast_payment_id: null,
      created_at: new Date().toISOString(),
      paid_at: null,
      shipped_at: null
    };

    // Save order
    const orders = loadOrders();
    orders.push(order);
    saveOrders(orders);

    // Generate PayFast payment data
    const buyer = {
      first_name: shipping_address.first_name,
      last_name: shipping_address.last_name,
      email: shipping_address.email,
      phone: shipping_address.phone
    };

    const paymentData = PayFast.generateStorePaymentData(order, buyer);

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
    console.error('Create order error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /orders/notify:
 *   post:
 *     tags: [Orders]
 *     summary: PayFast ITN webhook for store orders
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
// PayFast ITN webhook for store orders
router.post('/notify', async (req, res) => {
  try {
    const pfData = req.body;
    console.log('Store Order ITN received:', pfData);

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
    const orders = loadOrders();
    const orderIndex = orders.findIndex(o => o.id === orderId);

    if (orderIndex === -1) {
      console.error('Order not found:', orderId);
      return res.status(404).send('Order not found');
    }

    const order = orders[orderIndex];

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
      orders[orderIndex] = {
        ...order,
        status: 'paid',
        payment_status: 'completed',
        payfast_payment_id: pfData.pf_payment_id,
        paid_at: new Date().toISOString()
      };

      // Update product inventory
      const products = loadProducts();
      for (const item of order.items) {
        const productIndex = products.findIndex(p => p.id === item.product_id);
        if (productIndex !== -1 && products[productIndex].inventory) {
          products[productIndex].inventory.quantity -= item.quantity;
        }
      }

      // Save updated products
      fs.writeFileSync(productsFilePath, JSON.stringify(products, null, 2));
      saveOrders(orders);

      console.log('Payment completed for store order:', order.order_number);

      // Send confirmation email to customer
      sendOrderConfirmation(
        order.customer_email,
        order.customer_name,
        order.order_number,
        order.total_amount,
        order.items
      ).catch(err => console.error('Failed to send order confirmation:', err));

      // Notify admin of new paid order
      sendNewOrderNotification(
        order.order_number,
        order.customer_name,
        order.total_amount,
        order.items?.length || 0
      ).catch(err => console.error('Failed to send admin notification:', err));
    } else if (paymentStatus === 'CANCELLED') {
      orders[orderIndex] = {
        ...order,
        status: 'cancelled',
        payment_status: 'failed'
      };
      saveOrders(orders);

      console.log('Payment cancelled for store order:', order.order_number);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('ITN processing error:', error);
    res.status(500).send('Server error');
  }
});

/**
 * @openapi
 * /orders/my/orders:
 *   get:
 *     tags: [Orders]
 *     summary: Get current customer's orders
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of customer orders
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
// Get customer's orders (must be before /:id route)
router.get('/my/orders', authenticateCustomer, async (req, res) => {
  try {
    const orders = loadOrders();
    const customerOrders = orders
      .filter(o => o.customer_id === req.customer.id)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({ orders: customerOrders });
  } catch (error) {
    console.error('Get customer orders error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /orders/{id}:
 *   get:
 *     tags: [Orders]
 *     summary: Get order by ID
 *     parameters:
 *       - in: path
 *         name: id
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
// Get order by ID
router.get('/:id', optionalCustomerAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const orders = loadOrders();
    const order = orders.find(o => o.id === id);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Only return order if buyer matches or order is recent (within 24 hours)
    const orderAge = Date.now() - new Date(order.created_at).getTime();
    const isOwner = req.customer && order.customer_id === req.customer.id;
    const isRecent = orderAge < 24 * 60 * 60 * 1000;

    if (!isOwner && !isRecent) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    res.json({ order });
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
