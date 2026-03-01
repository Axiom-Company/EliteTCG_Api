import { Router } from 'express';
import { z } from 'zod';
import { authenticateCustomer, requireSeller } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';
import PayFast from '../utils/payfast.js';

const router = Router();

// Promotion tier configuration
const PROMOTION_TIERS = {
  spotlight: { label: 'Spotlight', days: 3, price: 25, sortPriority: 1 },
  featured:  { label: 'Featured',  days: 7, price: 50, sortPriority: 2 },
  premium:   { label: 'Premium',   days: 14, price: 75, sortPriority: 3 },
  elite:     { label: 'Elite Pin', days: 30, price: 100, sortPriority: 4 },
};

// Valid tier keys for Zod enum
const TIER_KEYS = /** @type {[string, ...string[]]} */ (Object.keys(PROMOTION_TIERS));

// Validation schemas
const purchasePromotionSchema = z.object({
  listing_id: z.string().uuid(),
  tier: z.enum(/** @type {[string, ...string[]]} */ (TIER_KEYS))
});

// Get available promotion tiers (public)
router.get('/tiers', (req, res) => {
  res.json({ tiers: PROMOTION_TIERS });
});

// Purchase a promotion for a listing
router.post('/purchase', authenticateCustomer, requireSeller, async (req, res) => {
  try {
    const validation = purchasePromotionSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors
      });
    }

    const { listing_id, tier: tierKey } = validation.data;
    const tier = PROMOTION_TIERS[tierKey];

    if (!supabaseAdmin) {
      return res.status(400).json({ error: 'Promotions require database connection' });
    }

    // Verify listing exists and belongs to the seller
    const { data: listing, error: listingError } = await supabaseAdmin
      .from('marketplace_listings')
      .select('id, title, seller_id, status')
      .eq('id', listing_id)
      .single();

    if (listingError || !listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    if (listing.seller_id !== req.customer.seller_id) {
      return res.status(403).json({ error: 'Not authorized to promote this listing' });
    }

    if (listing.status !== 'active') {
      return res.status(400).json({ error: 'Only active listings can be promoted' });
    }

    // Calculate expiry date
    const startsAt = new Date();
    const expiresAt = new Date(startsAt.getTime() + tier.days * 24 * 60 * 60 * 1000);

    // Create promotion record with pending status
    const { data: promotion, error: promoError } = await supabaseAdmin
      .from('listing_promotions')
      .insert({
        listing_id: listing.id,
        seller_id: req.customer.seller_id,
        tier: tierKey,
        price_paid: tier.price,
        starts_at: startsAt.toISOString(),
        expires_at: expiresAt.toISOString(),
        payment_status: 'pending'
      })
      .select()
      .single();

    if (promoError) {
      console.error('Create promotion error:', promoError);
      return res.status(500).json({ error: 'Failed to create promotion' });
    }

    // Build PayFast payment data using the same utility
    const mockOrder = {
      id: promotion.id,
      order_number: 'PROMO-' + promotion.id.slice(0, 8),
      total_amount: tier.price,
      quantity: 1
    };

    const buyer = {
      first_name: req.customer.name?.split(' ')[0] || 'Seller',
      last_name: req.customer.name?.split(' ').slice(1).join(' ') || '',
      email: req.customer.email,
      phone: null
    };

    const mockListing = {
      title: 'Promotion: ' + tier.label + ' for ' + listing.title,
      id: listing.id
    };

    const paymentData = PayFast.generatePaymentData(mockOrder, buyer, mockListing, null);

    // Override notify_url for promotion-specific ITN endpoint and re-sign
    const promoNotifyUrl = process.env.PAYFAST_PROMO_NOTIFY_URL
      || 'http://localhost:3001/api/marketplace/promotions/notify';
    paymentData.notify_url = promoNotifyUrl;
    delete paymentData.signature;
    paymentData.signature = PayFast.generateSignature(paymentData, PayFast.config.passphrase);

    res.json({
      promotion,
      payment: {
        url: PayFast.buildPaymentUrl(paymentData),
        data: paymentData,
        form_html: PayFast.buildPaymentForm(paymentData)
      }
    });
  } catch (error) {
    console.error('Purchase promotion error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// PayFast ITN webhook for promotion payments
router.post('/notify', async (req, res) => {
  try {
    const pfData = req.body;
    console.log('Promotion ITN received:', pfData);

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
      console.warn('Invalid PayFast signature for promotion');
      return res.status(400).send('Invalid signature');
    }

    const promotionId = pfData.m_payment_id;

    if (!supabaseAdmin) {
      console.log('Promotion ITN received but no database - promotion:', promotionId);
      return res.status(200).send('OK');
    }

    const paymentStatus = pfData.payment_status;

    if (paymentStatus === 'COMPLETE') {
      // Find the promotion
      const { data: promotion, error: promoError } = await supabaseAdmin
        .from('listing_promotions')
        .select('*')
        .eq('id', promotionId)
        .single();

      if (promoError || !promotion) {
        console.error('Promotion not found:', promotionId);
        return res.status(200).send('OK');
      }

      // Verify amount
      const expectedAmount = parseFloat(promotion.price_paid).toFixed(2);
      const receivedAmount = parseFloat(pfData.amount_gross).toFixed(2);

      if (expectedAmount !== receivedAmount) {
        console.warn('Promotion amount mismatch:', { expected: expectedAmount, received: receivedAmount });
        return res.status(200).send('OK');
      }

      // Update promotion payment status
      await supabaseAdmin
        .from('listing_promotions')
        .update({
          payment_status: 'completed',
          payfast_payment_id: pfData.pf_payment_id
        })
        .eq('id', promotionId);

      // Apply promotion to the listing
      await supabaseAdmin
        .from('marketplace_listings')
        .update({
          promotion_tier: promotion.tier,
          promotion_expires_at: promotion.expires_at
        })
        .eq('id', promotion.listing_id);

      console.log('Promotion payment completed:', promotionId, 'tier:', promotion.tier);
    } else if (paymentStatus === 'CANCELLED') {
      // Mark promotion as failed
      await supabaseAdmin
        .from('listing_promotions')
        .update({ payment_status: 'failed' })
        .eq('id', promotionId);

      console.log('Promotion payment cancelled:', promotionId);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Promotion ITN processing error:', error);
    res.status(200).send('OK');
  }
});

// Get seller's promotions (active and past)
router.get('/my', authenticateCustomer, requireSeller, async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.json({ promotions: [] });
    }

    const { data: promotions, error } = await supabaseAdmin
      .from('listing_promotions')
      .select(`
        *,
        listing:marketplace_listings(
          id,
          title
        )
      `)
      .eq('seller_id', req.customer.seller_id)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Get promotions error:', error);
      return res.status(500).json({ error: 'Failed to fetch promotions' });
    }

    res.json({ promotions });
  } catch (error) {
    console.error('Get my promotions error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
