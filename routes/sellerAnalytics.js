import { Router } from 'express';
import { authenticateCustomer, requireSeller } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';
import { mockListings, mockListingViews } from './marketplace.js';

const router = Router();

// All routes require seller authentication
router.use(authenticateCustomer);
router.use(requireSeller);

/**
 * @openapi
 * /seller/analytics/overview:
 *   get:
 *     tags: [Seller Analytics]
 *     summary: Get seller overview stats
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Overview stats (listings, views, sales, revenue)
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
// Get overview stats
router.get('/overview', async (req, res) => {
  try {
    const sellerId = req.customer.seller_id;
    let stats = {
      total_listings: 0,
      active_listings: 0,
      total_views: 0,
      views_today: 0,
      views_this_week: 0,
      views_this_month: 0,
      total_sales: 0,
      revenue_this_month: 0
    };

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    if (supabaseAdmin) {
      // Get listing counts
      const { data: listings } = await supabaseAdmin
        .from('marketplace_listings')
        .select('id, status, view_count')
        .eq('seller_id', sellerId)
        .neq('status', 'deleted');

      if (listings) {
        stats.total_listings = listings.length;
        stats.active_listings = listings.filter(l => l.status === 'active').length;
        stats.total_views = listings.reduce((sum, l) => sum + (l.view_count || 0), 0);
      }

      // Get views today
      const { count: viewsToday } = await supabaseAdmin
        .from('listing_views')
        .select('id', { count: 'exact', head: true })
        .in('listing_id', listings?.map(l => l.id) || [])
        .gte('created_at', todayStart);

      stats.views_today = viewsToday || 0;

      // Get views this week
      const { count: viewsWeek } = await supabaseAdmin
        .from('listing_views')
        .select('id', { count: 'exact', head: true })
        .in('listing_id', listings?.map(l => l.id) || [])
        .gte('created_at', weekStart);

      stats.views_this_week = viewsWeek || 0;

      // Get views this month
      const { count: viewsMonth } = await supabaseAdmin
        .from('listing_views')
        .select('id', { count: 'exact', head: true })
        .in('listing_id', listings?.map(l => l.id) || [])
        .gte('created_at', monthStart);

      stats.views_this_month = viewsMonth || 0;

      // Get seller profile stats
      const { data: profile } = await supabaseAdmin
        .from('seller_profiles')
        .select('total_sales, total_revenue')
        .eq('id', sellerId)
        .single();

      if (profile) {
        stats.total_sales = profile.total_sales || 0;
      }

      // Get revenue this month from orders
      const { data: monthOrders } = await supabaseAdmin
        .from('marketplace_orders')
        .select('seller_amount')
        .eq('seller_id', sellerId)
        .eq('payment_status', 'completed')
        .gte('paid_at', monthStart);

      if (monthOrders) {
        stats.revenue_this_month = monthOrders.reduce((sum, o) => sum + (parseFloat(o.seller_amount) || 0), 0);
      }
    } else {
      // Mock data
      const sellerListings = mockListings.filter(l => l.seller_id === sellerId && l.status !== 'deleted');
      const listingIds = sellerListings.map(l => l.id);

      stats.total_listings = sellerListings.length;
      stats.active_listings = sellerListings.filter(l => l.status === 'active').length;
      stats.total_views = sellerListings.reduce((sum, l) => sum + (l.view_count || 0), 0);

      // Views by time period
      const sellerViews = mockListingViews.filter(v => listingIds.includes(v.listing_id));
      stats.views_today = sellerViews.filter(v => new Date(v.created_at) >= new Date(todayStart)).length;
      stats.views_this_week = sellerViews.filter(v => new Date(v.created_at) >= new Date(weekStart)).length;
      stats.views_this_month = sellerViews.filter(v => new Date(v.created_at) >= new Date(monthStart)).length;
    }

    res.json({ stats });
  } catch (error) {
    console.error('Get overview stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /seller/analytics/listings:
 *   get:
 *     tags: [Seller Analytics]
 *     summary: Get listing performance data
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *           enum: [views, favorites, price, created]
 *           default: views
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *     responses:
 *       200:
 *         description: Listing performance data
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
// Get listing performance
router.get('/listings', async (req, res) => {
  try {
    const sellerId = req.customer.seller_id;
    const { sort = 'views', order = 'desc', limit = 10 } = req.query;

    let listings;

    if (supabaseAdmin) {
      let query = supabaseAdmin
        .from('marketplace_listings')
        .select('id, title, images, status, price, view_count, favorite_count, quantity, sold_quantity, created_at')
        .eq('seller_id', sellerId)
        .neq('status', 'deleted');

      // Apply sorting
      switch (sort) {
        case 'views':
          query = query.order('view_count', { ascending: order === 'asc' });
          break;
        case 'favorites':
          query = query.order('favorite_count', { ascending: order === 'asc' });
          break;
        case 'price':
          query = query.order('price', { ascending: order === 'asc' });
          break;
        case 'created':
          query = query.order('created_at', { ascending: order === 'asc' });
          break;
        default:
          query = query.order('view_count', { ascending: false });
      }

      const { data, error } = await query.limit(parseInt(limit));

      if (error) {
        console.error('Get listing performance error:', error);
        return res.status(500).json({ error: 'Failed to fetch listings' });
      }

      listings = data;
    } else {
      // Mock data
      listings = mockListings
        .filter(l => l.seller_id === sellerId && l.status !== 'deleted')
        .sort((a, b) => {
          const aVal = a[sort === 'views' ? 'view_count' : sort === 'favorites' ? 'favorite_count' : sort] || 0;
          const bVal = b[sort === 'views' ? 'view_count' : sort === 'favorites' ? 'favorite_count' : sort] || 0;
          return order === 'asc' ? aVal - bVal : bVal - aVal;
        })
        .slice(0, parseInt(limit))
        .map(l => ({
          id: l.id,
          title: l.title,
          images: l.images,
          status: l.status,
          price: l.price,
          view_count: l.view_count || 0,
          favorite_count: l.favorite_count || 0,
          quantity: l.quantity,
          sold_quantity: l.sold_quantity || 0,
          created_at: l.created_at
        }));
    }

    res.json({ listings });
  } catch (error) {
    console.error('Get listing performance error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /seller/analytics/views:
 *   get:
 *     tags: [Seller Analytics]
 *     summary: Get views over time
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: period
 *         schema:
 *           type: string
 *           enum: [24h, 7d, 30d, 90d]
 *           default: 7d
 *     responses:
 *       200:
 *         description: Daily view counts for the period
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
// Get views over time
router.get('/views', async (req, res) => {
  try {
    const sellerId = req.customer.seller_id;
    const { period = '7d' } = req.query;

    // Calculate date range
    let startDate;
    const now = new Date();

    switch (period) {
      case '24h':
        startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case '7d':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case '90d':
        startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    let viewsByDate = [];

    if (supabaseAdmin) {
      // Get listing IDs for this seller
      const { data: listings } = await supabaseAdmin
        .from('marketplace_listings')
        .select('id')
        .eq('seller_id', sellerId);

      const listingIds = listings?.map(l => l.id) || [];

      if (listingIds.length > 0) {
        // Get views grouped by date
        const { data: views } = await supabaseAdmin
          .from('listing_views')
          .select('created_at')
          .in('listing_id', listingIds)
          .gte('created_at', startDate.toISOString())
          .order('created_at');

        // Group by date
        const grouped = {};
        views?.forEach(v => {
          const date = v.created_at.split('T')[0];
          grouped[date] = (grouped[date] || 0) + 1;
        });

        // Fill in missing dates
        const current = new Date(startDate);
        while (current <= now) {
          const dateStr = current.toISOString().split('T')[0];
          viewsByDate.push({
            date: dateStr,
            views: grouped[dateStr] || 0
          });
          current.setDate(current.getDate() + 1);
        }
      }
    } else {
      // Mock data
      const sellerListings = mockListings.filter(l => l.seller_id === sellerId);
      const listingIds = sellerListings.map(l => l.id);
      const sellerViews = mockListingViews.filter(
        v => listingIds.includes(v.listing_id) && new Date(v.created_at) >= startDate
      );

      // Group by date
      const grouped = {};
      sellerViews.forEach(v => {
        const date = v.created_at.split('T')[0];
        grouped[date] = (grouped[date] || 0) + 1;
      });

      // Fill in missing dates
      const current = new Date(startDate);
      while (current <= now) {
        const dateStr = current.toISOString().split('T')[0];
        viewsByDate.push({
          date: dateStr,
          views: grouped[dateStr] || 0
        });
        current.setDate(current.getDate() + 1);
      }
    }

    res.json({ views: viewsByDate, period });
  } catch (error) {
    console.error('Get views over time error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /seller/analytics/activity:
 *   get:
 *     tags: [Seller Analytics]
 *     summary: Get recent activity (views)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *     responses:
 *       200:
 *         description: Recent listing activity
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
// Get recent activity
router.get('/activity', async (req, res) => {
  try {
    const sellerId = req.customer.seller_id;
    const { limit = 10 } = req.query;

    let activity = [];

    if (supabaseAdmin) {
      // Get listing IDs
      const { data: listings } = await supabaseAdmin
        .from('marketplace_listings')
        .select('id, title')
        .eq('seller_id', sellerId);

      const listingMap = {};
      listings?.forEach(l => { listingMap[l.id] = l.title; });
      const listingIds = Object.keys(listingMap);

      if (listingIds.length > 0) {
        // Get recent views
        const { data: views } = await supabaseAdmin
          .from('listing_views')
          .select('listing_id, created_at, referrer')
          .in('listing_id', listingIds)
          .order('created_at', { ascending: false })
          .limit(parseInt(limit));

        activity = views?.map(v => ({
          type: 'view',
          listing_id: v.listing_id,
          listing_title: listingMap[v.listing_id],
          referrer: v.referrer,
          created_at: v.created_at
        })) || [];
      }
    } else {
      // Mock data
      const sellerListings = mockListings.filter(l => l.seller_id === sellerId);
      const listingIds = sellerListings.map(l => l.id);
      const listingMap = {};
      sellerListings.forEach(l => { listingMap[l.id] = l.title; });

      activity = mockListingViews
        .filter(v => listingIds.includes(v.listing_id))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, parseInt(limit))
        .map(v => ({
          type: 'view',
          listing_id: v.listing_id,
          listing_title: listingMap[v.listing_id],
          referrer: v.referrer,
          created_at: v.created_at
        }));
    }

    res.json({ activity });
  } catch (error) {
    console.error('Get activity error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
