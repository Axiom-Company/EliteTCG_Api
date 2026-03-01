import { Router } from 'express';
import { z } from 'zod';
import { authenticateCustomer, requireSeller, optionalCustomerAuth } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';
import { calculateCommission } from '../utils/commission.js';

const router = Router();

// Validation schemas
const createListingSchema = z.object({
  title: z.string().min(5, 'Title must be at least 5 characters').max(200),
  description: z.string().max(2000).optional(),
  card_name: z.string().max(200).optional(),
  set_name: z.string().max(200).optional(),
  card_number: z.string().max(50).optional(),
  condition: z.enum(['mint', 'near_mint', 'excellent', 'good', 'played', 'poor']),
  language: z.string().max(20).default('English'),
  is_graded: z.boolean().default(false),
  grading_company: z.string().max(50).optional(),
  grade: z.string().max(20).optional(),
  certificate_number: z.string().max(50).optional(),
  price: z.number().positive('Price must be positive').max(10000000),
  compare_at_price: z.number().positive().optional(),
  quantity: z.number().int().positive().max(100).default(1),
  images: z.array(z.string()).max(5).default([]),
  category: z.enum(['singles', 'sealed', 'accessories']).default('singles'),
  is_negotiable: z.boolean().default(false),
  market_price_usd: z.number().positive().optional(),
  market_price_zar: z.number().positive().optional()
});

const updateListingSchema = createListingSchema.partial();

// Mock storage for development
let mockListings = [];
let mockListingViews = [];

// Helper to format listing for response
const formatListing = (listing, sellerProfile = null) => ({
  ...listing,
  seller: sellerProfile ? {
    id: sellerProfile.id,
    display_name: sellerProfile.display_name,
    rating: sellerProfile.rating,
    total_sales: sellerProfile.total_sales,
    contact_phone: sellerProfile.show_phone ? sellerProfile.contact_phone : null,
    contact_whatsapp: sellerProfile.show_whatsapp ? sellerProfile.contact_whatsapp : null,
    contact_email: sellerProfile.show_email ? sellerProfile.contact_email : null,
    location_city: sellerProfile.location_city,
    location_province: sellerProfile.location_province,
    is_verified: sellerProfile.is_verified || false,
  } : null
});

// Get all listings (public, with filters)
router.get('/listings', optionalCustomerAuth, async (req, res) => {
  try {
    const {
      search,
      condition,
      category,
      min_price,
      max_price,
      seller_id,
      sort = 'newest',
      page = 1,
      limit = 20
    } = req.query;

    const offset = (page - 1) * limit;
    let listings;
    let total;

    if (supabaseAdmin) {
      let query = supabaseAdmin
        .from('marketplace_listings')
        .select(`
          *,
          seller:seller_profiles(
            id,
            display_name,
            rating,
            total_sales,
            contact_phone,
            contact_whatsapp,
            contact_email,
            show_phone,
            show_whatsapp,
            show_email,
            location_city,
            location_province,
            is_verified
          )
        `, { count: 'exact' })
        .eq('status', 'active');

      // Apply filters
      if (search) {
        query = query.or(`title.ilike.%${search}%,card_name.ilike.%${search}%,set_name.ilike.%${search}%`);
      }
      if (condition) {
        query = query.eq('condition', condition);
      }
      if (category) {
        query = query.eq('category', category);
      }
      if (min_price) {
        query = query.gte('price', parseFloat(min_price));
      }
      if (max_price) {
        query = query.lte('price', parseFloat(max_price));
      }
      if (seller_id) {
        query = query.eq('seller_id', seller_id);
      }

      // Promoted listings first (active promotions only)
      query = query.order('promotion_tier', { ascending: false, nullsFirst: false });

      // Apply secondary sorting
      switch (sort) {
        case 'price_low':
          query = query.order('price', { ascending: true });
          break;
        case 'price_high':
          query = query.order('price', { ascending: false });
          break;
        case 'popular':
          query = query.order('view_count', { ascending: false });
          break;
        case 'oldest':
          query = query.order('created_at', { ascending: true });
          break;
        default: // newest
          query = query.order('created_at', { ascending: false });
      }

      const { data, error, count } = await query.range(offset, offset + limit - 1);

      if (error) {
        console.error('Get listings error:', error);
        return res.status(500).json({ error: 'Failed to fetch listings' });
      }

      listings = data.map(l => formatListing(l, l.seller));
      total = count;
    } else {
      // Mock data filtering
      let filtered = mockListings.filter(l => l.status === 'active');

      if (search) {
        const searchLower = search.toLowerCase();
        filtered = filtered.filter(l =>
          l.title.toLowerCase().includes(searchLower) ||
          (l.card_name && l.card_name.toLowerCase().includes(searchLower))
        );
      }
      if (condition) {
        filtered = filtered.filter(l => l.condition === condition);
      }
      if (category) {
        filtered = filtered.filter(l => l.category === category);
      }
      if (min_price) {
        filtered = filtered.filter(l => l.price >= parseFloat(min_price));
      }
      if (max_price) {
        filtered = filtered.filter(l => l.price <= parseFloat(max_price));
      }
      if (seller_id) {
        filtered = filtered.filter(l => l.seller_id === seller_id);
      }

      // Sort
      switch (sort) {
        case 'price_low':
          filtered.sort((a, b) => a.price - b.price);
          break;
        case 'price_high':
          filtered.sort((a, b) => b.price - a.price);
          break;
        case 'popular':
          filtered.sort((a, b) => (b.view_count || 0) - (a.view_count || 0));
          break;
        case 'oldest':
          filtered.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
          break;
        default:
          filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      }

      total = filtered.length;
      listings = filtered.slice(offset, offset + limit);
    }

    res.json({
      listings,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get listings error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single listing (public)
router.get('/listings/:id', optionalCustomerAuth, async (req, res) => {
  try {
    const { id } = req.params;
    let listing;

    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('marketplace_listings')
        .select(`
          *,
          seller:seller_profiles(
            id,
            display_name,
            bio,
            rating,
            review_count,
            total_sales,
            contact_phone,
            contact_whatsapp,
            contact_email,
            show_phone,
            show_whatsapp,
            show_email,
            location_city,
            location_province,
            is_verified,
            created_at
          )
        `)
        .eq('id', id)
        .single();

      if (error || !data) {
        return res.status(404).json({ error: 'Listing not found' });
      }

      listing = formatListing(data, data.seller);
    } else {
      listing = mockListings.find(l => l.id === id);
      if (!listing) {
        return res.status(404).json({ error: 'Listing not found' });
      }
    }

    // Don't return deleted or sold listings to non-owners
    if (listing.status !== 'active') {
      const isOwner = req.customer?.seller_id === listing.seller_id;
      if (!isOwner) {
        return res.status(404).json({ error: 'Listing not found' });
      }
    }

    res.json({ listing });
  } catch (error) {
    console.error('Get listing error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create listing (seller only)
router.post('/listings', authenticateCustomer, requireSeller, async (req, res) => {
  try {
    const validation = createListingSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors
      });
    }

    // Calculate and store commission at listing creation time
    const commissionInfo = calculateCommission(validation.data.price);

    const listingData = {
      ...validation.data,
      seller_id: req.customer.seller_id,
      status: 'active',
      view_count: 0,
      favorite_count: 0,
      sold_quantity: 0,
      commission_rate: commissionInfo.percentage,
      commission_amount: commissionInfo.fee
    };

    let listing;

    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('marketplace_listings')
        .insert(listingData)
        .select()
        .single();

      if (error) {
        console.error('Create listing error:', error);
        return res.status(500).json({ error: 'Failed to create listing' });
      }

      listing = data;
    } else {
      listing = {
        id: `mock-listing-${Date.now()}`,
        ...listingData,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      mockListings.push(listing);
    }

    res.status(201).json({
      message: 'Listing created successfully',
      listing
    });
  } catch (error) {
    console.error('Create listing error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update listing (owner only)
router.put('/listings/:id', authenticateCustomer, requireSeller, async (req, res) => {
  try {
    const { id } = req.params;

    // Verify ownership
    if (supabaseAdmin) {
      const { data: existing } = await supabaseAdmin
        .from('marketplace_listings')
        .select('seller_id')
        .eq('id', id)
        .single();

      if (!existing || existing.seller_id !== req.customer.seller_id) {
        return res.status(403).json({ error: 'Not authorized to edit this listing' });
      }
    } else {
      const existing = mockListings.find(l => l.id === id);
      if (!existing || existing.seller_id !== req.customer.seller_id) {
        return res.status(403).json({ error: 'Not authorized to edit this listing' });
      }
    }

    const validation = updateListingSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors
      });
    }

    let listing;

    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('marketplace_listings')
        .update(validation.data)
        .eq('id', id)
        .select()
        .single();

      if (error) {
        console.error('Update listing error:', error);
        return res.status(500).json({ error: 'Failed to update listing' });
      }

      listing = data;
    } else {
      const index = mockListings.findIndex(l => l.id === id);
      mockListings[index] = {
        ...mockListings[index],
        ...validation.data,
        updated_at: new Date().toISOString()
      };
      listing = mockListings[index];
    }

    res.json({
      message: 'Listing updated successfully',
      listing
    });
  } catch (error) {
    console.error('Update listing error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete listing (owner only) - soft delete
router.delete('/listings/:id', authenticateCustomer, requireSeller, async (req, res) => {
  try {
    const { id } = req.params;

    // Verify ownership
    if (supabaseAdmin) {
      const { data: existing } = await supabaseAdmin
        .from('marketplace_listings')
        .select('seller_id')
        .eq('id', id)
        .single();

      if (!existing || existing.seller_id !== req.customer.seller_id) {
        return res.status(403).json({ error: 'Not authorized to delete this listing' });
      }

      await supabaseAdmin
        .from('marketplace_listings')
        .update({ status: 'deleted' })
        .eq('id', id);
    } else {
      const index = mockListings.findIndex(l => l.id === id);
      if (index === -1 || mockListings[index].seller_id !== req.customer.seller_id) {
        return res.status(403).json({ error: 'Not authorized to delete this listing' });
      }
      mockListings[index].status = 'deleted';
    }

    res.json({ message: 'Listing deleted successfully' });
  } catch (error) {
    console.error('Delete listing error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Pause/unpause listing (owner only)
router.patch('/listings/:id/status', authenticateCustomer, requireSeller, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['active', 'paused'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // Verify ownership
    if (supabaseAdmin) {
      const { data: existing } = await supabaseAdmin
        .from('marketplace_listings')
        .select('seller_id, status')
        .eq('id', id)
        .single();

      if (!existing || existing.seller_id !== req.customer.seller_id) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      if (existing.status === 'sold' || existing.status === 'deleted') {
        return res.status(400).json({ error: 'Cannot change status of sold or deleted listings' });
      }

      const { data, error } = await supabaseAdmin
        .from('marketplace_listings')
        .update({ status })
        .eq('id', id)
        .select()
        .single();

      if (error) {
        return res.status(500).json({ error: 'Failed to update status' });
      }

      res.json({ message: 'Status updated', listing: data });
    } else {
      const index = mockListings.findIndex(l => l.id === id);
      if (index === -1 || mockListings[index].seller_id !== req.customer.seller_id) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      mockListings[index].status = status;
      res.json({ message: 'Status updated', listing: mockListings[index] });
    }
  } catch (error) {
    console.error('Update status error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Track view (rate limited: 1 view per IP per listing per hour)
router.post('/listings/:id/view', optionalCustomerAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const viewerId = req.customer?.id || null;
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || '';
    const referrer = req.headers.referer || null;

    // Check rate limit (1 view per IP per listing per hour)
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();

    if (supabaseAdmin) {
      // Check for recent view
      const { data: recentView } = await supabaseAdmin
        .from('listing_views')
        .select('id')
        .eq('listing_id', id)
        .eq('ip_address', ip)
        .gte('created_at', oneHourAgo)
        .limit(1)
        .single();

      if (!recentView) {
        // Record view
        await supabaseAdmin.from('listing_views').insert({
          listing_id: id,
          viewer_id: viewerId,
          ip_address: ip,
          user_agent: userAgent,
          referrer
        });

        // Increment view count
        await supabaseAdmin.rpc('increment_listing_views', { listing_uuid: id });
      }
    } else {
      // Mock rate limit check
      const recentView = mockListingViews.find(
        v => v.listing_id === id && v.ip_address === ip && new Date(v.created_at) > new Date(oneHourAgo)
      );

      if (!recentView) {
        mockListingViews.push({
          id: `view-${Date.now()}`,
          listing_id: id,
          viewer_id: viewerId,
          ip_address: ip,
          user_agent: userAgent,
          referrer,
          created_at: new Date().toISOString()
        });

        // Increment view count
        const listing = mockListings.find(l => l.id === id);
        if (listing) {
          listing.view_count = (listing.view_count || 0) + 1;
        }
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Track view error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get seller's own listings
router.get('/my-listings', authenticateCustomer, requireSeller, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let listings;
    let total;

    if (supabaseAdmin) {
      let query = supabaseAdmin
        .from('marketplace_listings')
        .select('*', { count: 'exact' })
        .eq('seller_id', req.customer.seller_id)
        .neq('status', 'deleted');

      if (status) {
        query = query.eq('status', status);
      }

      const { data, error, count } = await query
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        return res.status(500).json({ error: 'Failed to fetch listings' });
      }

      listings = data;
      total = count;
    } else {
      let filtered = mockListings.filter(
        l => l.seller_id === req.customer.seller_id && l.status !== 'deleted'
      );

      if (status) {
        filtered = filtered.filter(l => l.status === status);
      }

      filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      total = filtered.length;
      listings = filtered.slice(offset, offset + limit);
    }

    res.json({
      listings,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get my listings error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export { mockListings, mockListingViews };
export default router;
