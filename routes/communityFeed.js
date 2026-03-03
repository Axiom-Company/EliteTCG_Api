import { Router } from 'express';
import { optionalCustomerAuth } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

// ============================================
// COMMUNITY ACTIVITY FEED
// Makes the hub feel alive — shows what's
// happening across the entire community in
// real-time
// ============================================

// Get the live community activity feed (public)
router.get('/activity', optionalCustomerAuth, async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 30));
    const before = req.query.before; // cursor-based pagination (ISO timestamp)

    const activities = [];

    // Fetch recent data from multiple sources in parallel
    const [
      recentReviews,
      recentOpenings,
      recentThreads,
      recentReplies,
      recentListings,
      recentContent
    ] = await Promise.all([
      // Recent product reviews
      supabaseAdmin
        .from('product_reviews')
        .select('id, customer_id, product_id, set_id, rating, title, created_at')
        .eq('is_approved', true)
        .order('created_at', { ascending: false })
        .limit(10),

      // Recent pack openings
      supabaseAdmin
        .from('pack_opening_sessions')
        .select('id, customer_id, set_id, title, packs_opened, notable_pulls, product_type, created_at')
        .eq('is_public', true)
        .order('created_at', { ascending: false })
        .limit(10),

      // Recent discussion threads
      supabaseAdmin
        .from('discussion_threads')
        .select('id, customer_id, title, slug, category_id, reply_count, vote_score, created_at')
        .order('created_at', { ascending: false })
        .limit(10),

      // Recent discussion replies
      supabaseAdmin
        .from('discussion_replies')
        .select('id, customer_id, thread_id, created_at')
        .eq('is_hidden', false)
        .order('created_at', { ascending: false })
        .limit(10),

      // Recent marketplace listings
      supabaseAdmin
        .from('marketplace_listings')
        .select('id, seller_id, title, price, card_name, condition, images, created_at')
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(10),

      // Recent blog posts
      supabaseAdmin
        .from('content_posts')
        .select('id, title, slug, content_type, author_id, admin_author_id, featured_image_url, published_at, created_at')
        .eq('status', 'published')
        .order('published_at', { ascending: false })
        .limit(5)
    ]);

    // Transform each source into activity items
    for (const review of recentReviews.data || []) {
      const name = await getCustomerName(review.customer_id);
      let productName = null;
      if (review.product_id) {
        const { data: p } = await supabaseAdmin.from('products').select('name').eq('id', review.product_id).single();
        productName = p?.name;
      }
      activities.push({
        type: 'review',
        id: review.id,
        timestamp: review.created_at,
        user_name: name,
        description: `rated ${productName || 'a product'} ${review.rating}/5`,
        detail: review.title || null,
        rating: review.rating,
        entity_id: review.product_id || review.set_id
      });
    }

    for (const opening of recentOpenings.data || []) {
      const name = await getCustomerName(opening.customer_id);
      let setName = null;
      if (opening.set_id) {
        const { data: s } = await supabaseAdmin.from('sets').select('name').eq('id', opening.set_id).single();
        setName = s?.name;
      }
      activities.push({
        type: 'pack_opening',
        id: opening.id,
        timestamp: opening.created_at,
        user_name: name,
        description: `opened ${opening.packs_opened} pack(s)${setName ? ` of ${setName}` : ''}`,
        detail: opening.notable_pulls > 0 ? `${opening.notable_pulls} notable pull(s)!` : null,
        packs_opened: opening.packs_opened,
        notable_pulls: opening.notable_pulls
      });
    }

    for (const thread of recentThreads.data || []) {
      const name = await getCustomerName(thread.customer_id);
      activities.push({
        type: 'discussion',
        id: thread.id,
        timestamp: thread.created_at,
        user_name: name,
        description: `started a discussion`,
        detail: thread.title,
        slug: thread.slug,
        reply_count: thread.reply_count,
        vote_score: thread.vote_score
      });
    }

    for (const reply of recentReplies.data || []) {
      const name = await getCustomerName(reply.customer_id);
      // Get thread title
      const { data: thread } = await supabaseAdmin
        .from('discussion_threads')
        .select('title, slug')
        .eq('id', reply.thread_id)
        .single();

      activities.push({
        type: 'reply',
        id: reply.id,
        timestamp: reply.created_at,
        user_name: name,
        description: `replied to a discussion`,
        detail: thread?.title || null,
        thread_slug: thread?.slug || null
      });
    }

    for (const listing of recentListings.data || []) {
      // Get seller name
      let sellerName = 'A seller';
      if (listing.seller_id) {
        const { data: seller } = await supabaseAdmin
          .from('seller_profiles')
          .select('display_name')
          .eq('id', listing.seller_id)
          .single();
        if (seller) sellerName = seller.display_name;
      }

      activities.push({
        type: 'listing',
        id: listing.id,
        timestamp: listing.created_at,
        user_name: sellerName,
        description: `listed a card for sale`,
        detail: listing.card_name || listing.title,
        price: listing.price,
        condition: listing.condition,
        image: listing.images?.[0] || null
      });
    }

    for (const post of recentContent.data || []) {
      let authorName = 'EliteTCG';
      if (post.author_id) {
        authorName = await getCustomerName(post.author_id);
      } else if (post.admin_author_id) {
        const { data: admin } = await supabaseAdmin.from('admin_users').select('name').eq('id', post.admin_author_id).single();
        if (admin) authorName = admin.name;
      }

      activities.push({
        type: 'blog_post',
        id: post.id,
        timestamp: post.published_at || post.created_at,
        user_name: authorName,
        description: `published a new ${post.content_type}`,
        detail: post.title,
        slug: post.slug,
        image: post.featured_image_url
      });
    }

    // Sort all activities by timestamp descending
    activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Apply cursor-based pagination
    let filtered = activities;
    if (before) {
      filtered = activities.filter(a => new Date(a.timestamp) < new Date(before));
    }

    const paginated = filtered.slice(0, limit);

    res.json({
      activities: paginated,
      next_cursor: paginated.length > 0 ? paginated[paginated.length - 1].timestamp : null,
      has_more: filtered.length > limit
    });
  } catch (error) {
    console.error('Activity feed error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// COMMUNITY STATS — live counters
// ============================================

router.get('/stats', async (req, res) => {
  try {
    const [
      customerCount,
      reviewCount,
      openingCount,
      threadCount,
      listingCount,
      totalPacksResult
    ] = await Promise.all([
      supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('product_reviews').select('id', { count: 'exact', head: true }).eq('is_approved', true),
      supabaseAdmin.from('pack_opening_sessions').select('id', { count: 'exact', head: true }).eq('is_public', true),
      supabaseAdmin.from('discussion_threads').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('marketplace_listings').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      supabaseAdmin.from('pack_opening_sessions').select('packs_opened').eq('is_public', true)
    ]);

    const totalPacks = (totalPacksResult.data || []).reduce((sum, s) => sum + s.packs_opened, 0);

    res.json({
      stats: {
        total_members: customerCount.count || 0,
        total_reviews: reviewCount.count || 0,
        total_pack_openings: openingCount.count || 0,
        total_packs_opened: totalPacks,
        total_discussions: threadCount.count || 0,
        active_listings: listingCount.count || 0
      }
    });
  } catch (error) {
    console.error('Community stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// TRENDING — what's hot right now
// ============================================

router.get('/trending', async (req, res) => {
  try {
    const [
      hotThreads,
      topReviewed,
      recentHits,
      priceMoverResult
    ] = await Promise.all([
      // Trending discussions (most activity in last 7 days)
      supabaseAdmin
        .from('discussion_threads')
        .select('id, title, slug, reply_count, vote_score, view_count, created_at')
        .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
        .order('vote_score', { ascending: false })
        .limit(5),

      // Top reviewed products recently
      supabaseAdmin
        .from('product_reviews')
        .select('product_id, rating')
        .eq('is_approved', true)
        .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),

      // Recent notable pulls
      supabaseAdmin
        .from('pull_records')
        .select('id, card_name, card_number, rarity, card_image_url, estimated_value, session_id, created_at')
        .eq('is_hit', true)
        .order('created_at', { ascending: false })
        .limit(10),

      // Biggest price movers
      supabaseAdmin
        .from('price_tracked_items')
        .select('id, card_name, card_number, current_price, price_change_percentage, price_direction, image_url, set_code')
        .eq('is_active', true)
        .order('price_change_percentage', { ascending: false })
        .limit(5)
    ]);

    // Aggregate top reviewed products
    const productReviewCounts = {};
    for (const r of topReviewed.data || []) {
      if (r.product_id) {
        if (!productReviewCounts[r.product_id]) {
          productReviewCounts[r.product_id] = { count: 0, totalRating: 0 };
        }
        productReviewCounts[r.product_id].count++;
        productReviewCounts[r.product_id].totalRating += r.rating;
      }
    }

    const topProductIds = Object.entries(productReviewCounts)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([id, stats]) => ({ product_id: id, review_count: stats.count, avg_rating: parseFloat((stats.totalRating / stats.count).toFixed(1)) }));

    // Enrich with product names
    const topProducts = [];
    for (const item of topProductIds) {
      const { data: product } = await supabaseAdmin
        .from('products')
        .select('id, name, slug, images, price')
        .eq('id', item.product_id)
        .single();

      if (product) {
        topProducts.push({
          ...product,
          recent_review_count: item.review_count,
          avg_rating: item.avg_rating
        });
      }
    }

    res.json({
      trending: {
        hot_discussions: hotThreads.data || [],
        top_reviewed_products: topProducts,
        recent_notable_pulls: recentHits.data || [],
        price_movers: priceMoverResult.data || []
      }
    });
  } catch (error) {
    console.error('Trending error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// HELPER
// ============================================

async function getCustomerName(customerId) {
  try {
    const { data: customer } = await supabaseAdmin
      .from('profiles')
      .select('first_name, last_name')
      .eq('id', customerId)
      .single();

    if (customer) {
      return `${customer.first_name} ${customer.last_name ? customer.last_name.charAt(0) + '.' : ''}`.trim();
    }
    return 'Anonymous';
  } catch {
    return 'Anonymous';
  }
}

export default router;
