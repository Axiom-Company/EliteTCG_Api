import { Router } from 'express';
import { z } from 'zod';
import { authenticateCustomer, optionalCustomerAuth } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';
import {
  searchCards,
  getCardById,
  getCardsBySet,
  getSets,
  getUsdToZarRate,
  usdToZar,
} from '../utils/pokemonTcgApi.js';
import multer from 'multer';

const router = Router();

// Multer setup for card image scanning (memory storage, 5MB limit)
const scanUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, and WebP images are allowed'));
    }
  },
});

// ============================================
// Validation Schemas
// ============================================

const addCardSchema = z.object({
  pokemon_tcg_id: z.string().min(1, 'Card ID is required'),
  card_name: z.string().min(1, 'Card name is required'),
  set_name: z.string().optional(),
  set_code: z.string().optional(),
  card_number: z.string().optional(),
  rarity: z.string().optional(),
  card_image_small: z.string().url().optional().or(z.literal('')).or(z.null()),
  card_image_large: z.string().url().optional().or(z.literal('')).or(z.null()),
  quantity: z.number().int().positive().max(9999).default(1),
  condition: z.enum(['mint', 'near_mint', 'excellent', 'good', 'played', 'poor']).default('near_mint'),
  is_graded: z.boolean().default(false),
  grading_company: z.string().max(50).optional(),
  grade: z.string().max(20).optional(),
  purchase_price: z.number().min(0).optional(),
  purchase_date: z.string().optional(), // ISO date string
  notes: z.string().max(500).optional(),
});

const updateCardSchema = z.object({
  quantity: z.number().int().positive().max(9999).optional(),
  condition: z.enum(['mint', 'near_mint', 'excellent', 'good', 'played', 'poor']).optional(),
  is_graded: z.boolean().optional(),
  grading_company: z.string().max(50).optional(),
  grade: z.string().max(20).optional(),
  purchase_price: z.number().min(0).optional().nullable(),
  purchase_date: z.string().optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});

const bulkAddSchema = z.object({
  cards: z.array(addCardSchema).min(1).max(100),
});

// ============================================
// Mock data for development without Supabase
// ============================================

let mockPortfolioCards = [];
let mockPriceCache = [];
let mockSnapshots = [];

// ============================================
// CARD SEARCH  (public — no auth needed to browse)
// ============================================

// Search pokemontcg.io cards
router.get('/search', optionalCustomerAuth, async (req, res) => {
  try {
    const { q, set, rarity, supertype, page = 1, limit = 20 } = req.query;

    if (!q && !set) {
      return res.status(400).json({ error: 'Provide a search query (q) or set code (set)' });
    }

    const result = await searchCards({
      query: q || undefined,
      setCode: set || undefined,
      rarity: rarity || undefined,
      supertype: supertype || undefined,
      page: parseInt(page),
      pageSize: Math.min(parseInt(limit), 50),
    });

    // Attach ZAR prices
    const rate = await getUsdToZarRate();
    const cards = result.cards.map(c => ({
      ...c,
      price_market_zar: usdToZar(c.price_market, rate),
      price_low_zar: usdToZar(c.price_low, rate),
      price_mid_zar: usdToZar(c.price_mid, rate),
      price_high_zar: usdToZar(c.price_high, rate),
      usd_to_zar_rate: rate,
    }));

    res.json({
      cards,
      pagination: {
        page: result.page,
        limit: result.pageSize,
        total: result.totalCount,
        totalPages: Math.ceil(result.totalCount / result.pageSize),
      },
    });
  } catch (error) {
    console.error('Card search error:', error);
    res.status(500).json({ error: 'Failed to search cards' });
  }
});

// Get a single card from pokemontcg.io by ID
router.get('/search/:cardId', optionalCustomerAuth, async (req, res) => {
  try {
    const card = await getCardById(req.params.cardId);
    if (!card) {
      return res.status(404).json({ error: 'Card not found' });
    }

    const rate = await getUsdToZarRate();

    res.json({
      card: {
        ...card,
        price_market_zar: usdToZar(card.price_market, rate),
        price_low_zar: usdToZar(card.price_low, rate),
        price_mid_zar: usdToZar(card.price_mid, rate),
        price_high_zar: usdToZar(card.price_high, rate),
        usd_to_zar_rate: rate,
      },
    });
  } catch (error) {
    console.error('Get card error:', error);
    res.status(500).json({ error: 'Failed to fetch card' });
  }
});

// Search pokemontcg.io sets
router.get('/sets', optionalCustomerAuth, async (req, res) => {
  try {
    const { q, page = 1, limit = 50 } = req.query;
    const result = await getSets({
      query: q || undefined,
      page: parseInt(page),
      pageSize: Math.min(parseInt(limit), 100),
    });

    res.json({
      sets: result.sets,
      pagination: {
        page: result.page,
        limit: result.pageSize,
        total: result.totalCount,
        totalPages: Math.ceil(result.totalCount / result.pageSize),
      },
    });
  } catch (error) {
    console.error('Get sets error:', error);
    res.status(500).json({ error: 'Failed to fetch sets' });
  }
});

// Scan a card image using Google Cloud Vision OCR and search pokemontcg.io
router.post('/scan', authenticateCustomer, (req, res, next) => {
  scanUpload.single('card_image')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File size exceeds 5MB limit' });
      }
      return res.status(400).json({ error: err.message });
    }
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'card_image file is required' });
    }

    const apiKey = process.env.GOOGLE_CLOUD_VISION_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'Card scan service unavailable' });
    }

    const base64 = req.file.buffer.toString('base64');

    let visionResponse;
    try {
      visionResponse = await fetch(
        `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requests: [{
              image: { content: base64 },
              features: [{ type: 'TEXT_DETECTION' }],
            }],
          }),
        }
      );
    } catch (_fetchErr) {
      return res.status(503).json({ error: 'Card scan service unavailable' });
    }

    if (!visionResponse.ok) {
      return res.status(503).json({ error: 'Card scan service unavailable' });
    }

    const visionData = await visionResponse.json();
    const fullText =
      visionData?.responses?.[0]?.textAnnotations?.[0]?.description || '';

    if (!fullText.trim()) {
      return res.status(400).json({
        error: 'Could not read text from image. Ensure the card is clearly visible.',
      });
    }

    // Extract card number pattern (e.g. 123/200, SV-001, TG15/TG30)
    const numberMatch = fullText.match(
      /\b(\w{0,3}\d{1,3}[a-z]?\s*\/\s*\d{1,4})\b/i
    );
    const detectedNumber = numberMatch ? numberMatch[1].replace(/\s/g, '') : null;

    // Extract card name: look for lines before the HP line that look like a name
    const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);
    let detectedName = null;

    for (const line of lines) {
      // Skip lines that are clearly not a card name
      if (/\d{1,3}\s*\/\s*\d{1,4}/.test(line)) continue; // card number line
      if (/^\d+\s*HP$/i.test(line)) break;                // HP line means name is above
      if (/^HP\s*\d+/i.test(line)) break;                 // alternate HP format

      // A Pokemon name is typically 2-20 chars, title case or all caps, mostly letters
      const cleaned = line.replace(/[^a-zA-Z\s\-'.:]/g, '').trim();
      if (cleaned.length >= 2 && cleaned.length <= 20 && /^[A-Za-z\s\-'.]+$/.test(cleaned)) {
        detectedName = cleaned;
        break;
      }
    }

    // Build search query
    const q = detectedName || lines.find(l => l.length >= 2 && l.length <= 40) || fullText.substring(0, 40);

    const result = await searchCards({ query: q, page: 1, pageSize: 10 });

    const rate = await getUsdToZarRate();
    const cards = result.cards.map(c => ({
      ...c,
      price_market_zar: usdToZar(c.price_market, rate),
      price_low_zar: usdToZar(c.price_low, rate),
      price_mid_zar: usdToZar(c.price_mid, rate),
      price_high_zar: usdToZar(c.price_high, rate),
      usd_to_zar_rate: rate,
    }));

    res.json({
      ocr_text: fullText,
      detected_name: detectedName,
      detected_number: detectedNumber,
      cards,
      total: cards.length,
    });
  } catch (error) {
    console.error('Card scan error:', error);
    res.status(500).json({ error: 'Failed to scan card' });
  }
});

// ============================================
// PORTFOLIO MANAGEMENT  (authenticated)
// ============================================

// Get full portfolio
router.get('/', authenticateCustomer, async (req, res) => {
  try {
    const customerId = req.customer.id;
    const {
      sort = 'added',
      order = 'desc',
      set_code,
      rarity,
      page = 1,
      limit = 50,
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    let cards;
    let total;

    if (supabaseAdmin) {
      let query = supabaseAdmin
        .from('portfolio_cards')
        .select('*', { count: 'exact' })
        .eq('customer_id', customerId);

      if (set_code) query = query.eq('set_code', set_code);
      if (rarity) query = query.eq('rarity', rarity);

      // Sorting
      switch (sort) {
        case 'name':
          query = query.order('card_name', { ascending: order === 'asc' });
          break;
        case 'value':
          query = query.order('latest_price_market', { ascending: order === 'asc', nullsFirst: false });
          break;
        case 'quantity':
          query = query.order('quantity', { ascending: order === 'asc' });
          break;
        case 'set':
          query = query.order('set_name', { ascending: order === 'asc' });
          break;
        default: // added
          query = query.order('created_at', { ascending: order === 'asc' });
      }

      const { data, error, count } = await query.range(offset, offset + parseInt(limit) - 1);

      if (error) {
        console.error('Get portfolio error:', error);
        return res.status(500).json({ error: 'Failed to fetch portfolio' });
      }

      cards = data;
      total = count;
    } else {
      // Mock data
      let filtered = mockPortfolioCards.filter(c => c.customer_id === customerId);

      if (set_code) filtered = filtered.filter(c => c.set_code === set_code);
      if (rarity) filtered = filtered.filter(c => c.rarity === rarity);

      filtered.sort((a, b) => {
        let aVal, bVal;
        switch (sort) {
          case 'name': aVal = a.card_name; bVal = b.card_name; break;
          case 'value': aVal = a.latest_price_market || 0; bVal = b.latest_price_market || 0; break;
          case 'quantity': aVal = a.quantity; bVal = b.quantity; break;
          default: aVal = a.created_at; bVal = b.created_at;
        }
        if (order === 'asc') return aVal > bVal ? 1 : -1;
        return aVal < bVal ? 1 : -1;
      });

      total = filtered.length;
      cards = filtered.slice(offset, offset + parseInt(limit));
    }

    res.json({
      cards,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Get portfolio error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get portfolio summary (total value, card counts, top cards)
router.get('/summary', authenticateCustomer, async (req, res) => {
  try {
    const customerId = req.customer.id;
    let summary = {
      total_cards: 0,
      unique_cards: 0,
      total_value_usd: 0,
      total_value_zar: 0,
      total_cost: 0,
      total_profit_usd: 0,
      sets_collected: 0,
      top_cards: [],
      value_by_set: [],
      value_by_rarity: [],
    };

    if (supabaseAdmin) {
      const { data: cards, error } = await supabaseAdmin
        .from('portfolio_cards')
        .select('*')
        .eq('customer_id', customerId);

      if (error) {
        console.error('Get portfolio summary error:', error);
        return res.status(500).json({ error: 'Failed to fetch portfolio summary' });
      }

      if (cards && cards.length > 0) {
        const rate = await getUsdToZarRate();

        summary.unique_cards = cards.length;
        summary.total_cards = cards.reduce((sum, c) => sum + c.quantity, 0);

        // Total value
        summary.total_value_usd = cards.reduce((sum, c) => {
          return sum + (c.latest_price_market || 0) * c.quantity;
        }, 0);
        summary.total_value_usd = Math.round(summary.total_value_usd * 100) / 100;
        summary.total_value_zar = usdToZar(summary.total_value_usd, rate) || 0;

        // Total cost (purchase prices user entered)
        summary.total_cost = cards.reduce((sum, c) => {
          return sum + (c.purchase_price || 0) * c.quantity;
        }, 0);
        summary.total_cost = Math.round(summary.total_cost * 100) / 100;

        // Profit (value minus cost)
        summary.total_profit_usd = Math.round((summary.total_value_usd - summary.total_cost) * 100) / 100;

        // Sets collected
        const sets = new Set(cards.map(c => c.set_code).filter(Boolean));
        summary.sets_collected = sets.size;

        // Top 5 most valuable cards
        summary.top_cards = [...cards]
          .sort((a, b) => ((b.latest_price_market || 0) * b.quantity) - ((a.latest_price_market || 0) * a.quantity))
          .slice(0, 5)
          .map(c => ({
            id: c.id,
            pokemon_tcg_id: c.pokemon_tcg_id,
            card_name: c.card_name,
            set_name: c.set_name,
            card_image_small: c.card_image_small,
            quantity: c.quantity,
            price_market: c.latest_price_market,
            total_value: Math.round((c.latest_price_market || 0) * c.quantity * 100) / 100,
            total_value_zar: usdToZar((c.latest_price_market || 0) * c.quantity, rate),
          }));

        // Value by set
        const setMap = {};
        cards.forEach(c => {
          const key = c.set_code || 'unknown';
          if (!setMap[key]) {
            setMap[key] = { set_code: key, set_name: c.set_name || 'Unknown', value_usd: 0, card_count: 0 };
          }
          setMap[key].value_usd += (c.latest_price_market || 0) * c.quantity;
          setMap[key].card_count += c.quantity;
        });
        summary.value_by_set = Object.values(setMap)
          .map(s => ({
            ...s,
            value_usd: Math.round(s.value_usd * 100) / 100,
            value_zar: usdToZar(s.value_usd, rate),
          }))
          .sort((a, b) => b.value_usd - a.value_usd);

        // Value by rarity
        const rarityMap = {};
        cards.forEach(c => {
          const key = c.rarity || 'Unknown';
          if (!rarityMap[key]) {
            rarityMap[key] = { rarity: key, value_usd: 0, card_count: 0 };
          }
          rarityMap[key].value_usd += (c.latest_price_market || 0) * c.quantity;
          rarityMap[key].card_count += c.quantity;
        });
        summary.value_by_rarity = Object.values(rarityMap)
          .map(r => ({
            ...r,
            value_usd: Math.round(r.value_usd * 100) / 100,
            value_zar: usdToZar(r.value_usd, rate),
          }))
          .sort((a, b) => b.value_usd - a.value_usd);
      }
    } else {
      // Mock data summary
      const cards = mockPortfolioCards.filter(c => c.customer_id === customerId);
      summary.unique_cards = cards.length;
      summary.total_cards = cards.reduce((sum, c) => sum + c.quantity, 0);
      summary.total_value_usd = cards.reduce((sum, c) => sum + (c.latest_price_market || 0) * c.quantity, 0);
    }

    res.json({ summary });
  } catch (error) {
    console.error('Get portfolio summary error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get portfolio value history (for graphs)
router.get('/history', authenticateCustomer, async (req, res) => {
  try {
    const customerId = req.customer.id;
    const { period = '30d' } = req.query;

    let startDate;
    const now = new Date();

    switch (period) {
      case '7d':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case '90d':
        startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      case '1y':
        startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
        break;
      case 'all':
        startDate = new Date('2020-01-01');
        break;
      default:
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }

    let snapshots = [];

    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('portfolio_snapshots')
        .select('*')
        .eq('customer_id', customerId)
        .gte('snapshot_date', startDate.toISOString().split('T')[0])
        .order('snapshot_date', { ascending: true });

      if (error) {
        console.error('Get portfolio history error:', error);
        return res.status(500).json({ error: 'Failed to fetch portfolio history' });
      }

      snapshots = data || [];
    } else {
      snapshots = mockSnapshots
        .filter(s => s.customer_id === customerId && new Date(s.snapshot_date) >= startDate)
        .sort((a, b) => new Date(a.snapshot_date) - new Date(b.snapshot_date));
    }

    // Calculate change metrics
    const firstSnapshot = snapshots[0];
    const lastSnapshot = snapshots[snapshots.length - 1];
    let change = null;

    if (firstSnapshot && lastSnapshot && snapshots.length > 1) {
      const valueDiff = lastSnapshot.total_value_usd - firstSnapshot.total_value_usd;
      const percentChange = firstSnapshot.total_value_usd > 0
        ? (valueDiff / firstSnapshot.total_value_usd) * 100
        : 0;

      change = {
        value_diff_usd: Math.round(valueDiff * 100) / 100,
        value_diff_zar: Math.round((lastSnapshot.total_value_zar - firstSnapshot.total_value_zar) * 100) / 100,
        percent_change: Math.round(percentChange * 100) / 100,
        direction: valueDiff >= 0 ? 'up' : 'down',
      };
    }

    res.json({
      snapshots: snapshots.map(s => ({
        date: s.snapshot_date,
        total_cards: s.total_cards,
        unique_cards: s.unique_cards,
        total_value_usd: s.total_value_usd,
        total_value_zar: s.total_value_zar,
      })),
      period,
      change,
    });
  } catch (error) {
    console.error('Get portfolio history error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add a card to portfolio
router.post('/cards', authenticateCustomer, async (req, res) => {
  try {
    const validation = addCardSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors,
      });
    }

    const customerId = req.customer.id;
    const cardData = validation.data;

    // Fetch current market price from pokemontcg.io
    let marketPrice = null;
    let marketPriceZar = null;
    let rate = null;

    try {
      const apiCard = await getCardById(cardData.pokemon_tcg_id);
      if (apiCard) {
        marketPrice = apiCard.price_market;
        rate = await getUsdToZarRate();
        marketPriceZar = usdToZar(marketPrice, rate);

        // Update price cache
        if (supabaseAdmin) {
          await supabaseAdmin
            .from('card_price_cache')
            .upsert({
              pokemon_tcg_id: apiCard.pokemon_tcg_id,
              card_name: apiCard.card_name,
              set_name: apiCard.set_name,
              set_code: apiCard.set_code,
              card_number: apiCard.card_number,
              supertype: apiCard.supertype,
              rarity: apiCard.rarity,
              card_image_small: apiCard.card_image_small,
              card_image_large: apiCard.card_image_large,
              price_market: apiCard.price_market,
              price_low: apiCard.price_low,
              price_mid: apiCard.price_mid,
              price_high: apiCard.price_high,
              price_market_zar: marketPriceZar,
              usd_to_zar_rate: rate,
              fetched_at: new Date().toISOString(),
            }, { onConflict: 'pokemon_tcg_id' });
        }
      }
    } catch (priceErr) {
      console.warn('Could not fetch market price for card:', priceErr.message);
      // Continue without price — non-critical
    }

    let card;

    if (supabaseAdmin) {
      // Use the RPC function for upsert logic
      const { data, error } = await supabaseAdmin.rpc('upsert_portfolio_card', {
        p_customer_id: customerId,
        p_pokemon_tcg_id: cardData.pokemon_tcg_id,
        p_card_name: cardData.card_name,
        p_set_name: cardData.set_name || null,
        p_set_code: cardData.set_code || null,
        p_card_number: cardData.card_number || null,
        p_rarity: cardData.rarity || null,
        p_card_image_small: cardData.card_image_small || null,
        p_card_image_large: cardData.card_image_large || null,
        p_quantity: cardData.quantity,
        p_condition: cardData.condition,
        p_is_graded: cardData.is_graded,
        p_grading_company: cardData.grading_company || null,
        p_grade: cardData.grade || null,
        p_purchase_price: cardData.purchase_price || null,
        p_purchase_date: cardData.purchase_date || null,
        p_notes: cardData.notes || null,
        p_latest_price_market: marketPrice,
        p_latest_price_market_zar: marketPriceZar,
      });

      if (error) {
        console.error('Add portfolio card error:', error);
        return res.status(500).json({ error: 'Failed to add card to portfolio' });
      }

      card = data;
    } else {
      // Mock: upsert logic
      const existingIdx = mockPortfolioCards.findIndex(
        c => c.customer_id === customerId
          && c.pokemon_tcg_id === cardData.pokemon_tcg_id
          && c.condition === cardData.condition
          && c.is_graded === cardData.is_graded
          && c.grade === (cardData.grade || null)
      );

      if (existingIdx !== -1) {
        mockPortfolioCards[existingIdx].quantity += cardData.quantity;
        mockPortfolioCards[existingIdx].latest_price_market = marketPrice;
        mockPortfolioCards[existingIdx].latest_price_market_zar = marketPriceZar;
        mockPortfolioCards[existingIdx].price_updated_at = new Date().toISOString();
        card = mockPortfolioCards[existingIdx];
      } else {
        card = {
          id: `mock-portfolio-${Date.now()}`,
          customer_id: customerId,
          ...cardData,
          latest_price_market: marketPrice,
          latest_price_market_zar: marketPriceZar,
          price_updated_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        mockPortfolioCards.push(card);
      }
    }

    res.status(201).json({
      message: 'Card added to portfolio',
      card,
    });
  } catch (error) {
    console.error('Add card error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Bulk add cards to portfolio
router.post('/cards/bulk', authenticateCustomer, async (req, res) => {
  try {
    const validation = bulkAddSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors,
      });
    }

    const customerId = req.customer.id;
    const results = [];
    const errors = [];

    for (const cardData of validation.data.cards) {
      try {
        // Fetch price
        let marketPrice = null;
        let marketPriceZar = null;

        try {
          const apiCard = await getCardById(cardData.pokemon_tcg_id);
          if (apiCard) {
            marketPrice = apiCard.price_market;
            const rate = await getUsdToZarRate();
            marketPriceZar = usdToZar(marketPrice, rate);
          }
        } catch {
          // Price fetch is non-critical
        }

        if (supabaseAdmin) {
          const { data, error } = await supabaseAdmin.rpc('upsert_portfolio_card', {
            p_customer_id: customerId,
            p_pokemon_tcg_id: cardData.pokemon_tcg_id,
            p_card_name: cardData.card_name,
            p_set_name: cardData.set_name || null,
            p_set_code: cardData.set_code || null,
            p_card_number: cardData.card_number || null,
            p_rarity: cardData.rarity || null,
            p_card_image_small: cardData.card_image_small || null,
            p_card_image_large: cardData.card_image_large || null,
            p_quantity: cardData.quantity,
            p_condition: cardData.condition,
            p_is_graded: cardData.is_graded,
            p_grading_company: cardData.grading_company || null,
            p_grade: cardData.grade || null,
            p_purchase_price: cardData.purchase_price || null,
            p_purchase_date: cardData.purchase_date || null,
            p_notes: cardData.notes || null,
            p_latest_price_market: marketPrice,
            p_latest_price_market_zar: marketPriceZar,
          });

          if (error) {
            errors.push({ pokemon_tcg_id: cardData.pokemon_tcg_id, error: error.message });
          } else {
            results.push(data);
          }
        } else {
          // Mock
          const card = {
            id: `mock-portfolio-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            customer_id: customerId,
            ...cardData,
            latest_price_market: marketPrice,
            latest_price_market_zar: marketPriceZar,
            price_updated_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          mockPortfolioCards.push(card);
          results.push(card);
        }
      } catch (err) {
        errors.push({ pokemon_tcg_id: cardData.pokemon_tcg_id, error: err.message });
      }
    }

    res.status(201).json({
      message: `Added ${results.length} card(s) to portfolio`,
      added: results.length,
      failed: errors.length,
      cards: results,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Bulk add cards error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update a portfolio card
router.put('/cards/:id', authenticateCustomer, async (req, res) => {
  try {
    const { id } = req.params;
    const customerId = req.customer.id;

    const validation = updateCardSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors,
      });
    }

    let card;

    if (supabaseAdmin) {
      // Verify ownership
      const { data: existing } = await supabaseAdmin
        .from('portfolio_cards')
        .select('customer_id')
        .eq('id', id)
        .single();

      if (!existing || existing.customer_id !== customerId) {
        return res.status(404).json({ error: 'Card not found in your portfolio' });
      }

      const { data, error } = await supabaseAdmin
        .from('portfolio_cards')
        .update(validation.data)
        .eq('id', id)
        .eq('customer_id', customerId)
        .select()
        .single();

      if (error) {
        console.error('Update portfolio card error:', error);
        return res.status(500).json({ error: 'Failed to update card' });
      }

      card = data;
    } else {
      const index = mockPortfolioCards.findIndex(c => c.id === id && c.customer_id === customerId);
      if (index === -1) {
        return res.status(404).json({ error: 'Card not found in your portfolio' });
      }

      mockPortfolioCards[index] = {
        ...mockPortfolioCards[index],
        ...validation.data,
        updated_at: new Date().toISOString(),
      };
      card = mockPortfolioCards[index];
    }

    res.json({ message: 'Card updated', card });
  } catch (error) {
    console.error('Update card error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a card from portfolio
router.delete('/cards/:id', authenticateCustomer, async (req, res) => {
  try {
    const { id } = req.params;
    const customerId = req.customer.id;

    if (supabaseAdmin) {
      const { data: existing } = await supabaseAdmin
        .from('portfolio_cards')
        .select('customer_id')
        .eq('id', id)
        .single();

      if (!existing || existing.customer_id !== customerId) {
        return res.status(404).json({ error: 'Card not found in your portfolio' });
      }

      const { error } = await supabaseAdmin
        .from('portfolio_cards')
        .delete()
        .eq('id', id)
        .eq('customer_id', customerId);

      if (error) {
        console.error('Delete portfolio card error:', error);
        return res.status(500).json({ error: 'Failed to remove card' });
      }
    } else {
      const index = mockPortfolioCards.findIndex(c => c.id === id && c.customer_id === customerId);
      if (index === -1) {
        return res.status(404).json({ error: 'Card not found in your portfolio' });
      }
      mockPortfolioCards.splice(index, 1);
    }

    res.json({ message: 'Card removed from portfolio' });
  } catch (error) {
    console.error('Delete card error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get a single portfolio card with fresh price
router.get('/cards/:id', authenticateCustomer, async (req, res) => {
  try {
    const { id } = req.params;
    const customerId = req.customer.id;

    let card;

    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('portfolio_cards')
        .select('*')
        .eq('id', id)
        .eq('customer_id', customerId)
        .single();

      if (error || !data) {
        return res.status(404).json({ error: 'Card not found in your portfolio' });
      }
      card = data;
    } else {
      card = mockPortfolioCards.find(c => c.id === id && c.customer_id === customerId);
      if (!card) {
        return res.status(404).json({ error: 'Card not found in your portfolio' });
      }
    }

    // Optionally refresh price if stale (older than 1 hour)
    const priceAge = card.price_updated_at
      ? Date.now() - new Date(card.price_updated_at).getTime()
      : Infinity;

    if (priceAge > 60 * 60 * 1000) {
      try {
        const apiCard = await getCardById(card.pokemon_tcg_id);
        if (apiCard && apiCard.price_market != null) {
          const rate = await getUsdToZarRate();
          const updates = {
            latest_price_market: apiCard.price_market,
            latest_price_market_zar: usdToZar(apiCard.price_market, rate),
            price_updated_at: new Date().toISOString(),
          };

          if (supabaseAdmin) {
            await supabaseAdmin
              .from('portfolio_cards')
              .update(updates)
              .eq('id', id);
          }

          card = { ...card, ...updates };
        }
      } catch {
        // Price refresh is non-critical
      }
    }

    res.json({ card });
  } catch (error) {
    console.error('Get portfolio card error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// COLLECTION GAPS (conversion feature)
// ============================================

// Show missing cards from sets the user is collecting
router.get('/gaps', authenticateCustomer, async (req, res) => {
  try {
    const customerId = req.customer.id;
    const { set_code } = req.query;

    if (!set_code) {
      return res.status(400).json({ error: 'set_code query parameter is required' });
    }

    // Get user's owned cards for this set
    let ownedCardIds = [];

    if (supabaseAdmin) {
      const { data: owned } = await supabaseAdmin
        .from('portfolio_cards')
        .select('pokemon_tcg_id')
        .eq('customer_id', customerId)
        .eq('set_code', set_code);

      ownedCardIds = (owned || []).map(c => c.pokemon_tcg_id);
    } else {
      ownedCardIds = mockPortfolioCards
        .filter(c => c.customer_id === customerId && c.set_code === set_code)
        .map(c => c.pokemon_tcg_id);
    }

    // Fetch full set from pokemontcg.io
    const setResult = await getCardsBySet(set_code, { page: 1, pageSize: 250 });

    const rate = await getUsdToZarRate();

    // Separate owned and missing
    const ownedSet = new Set(ownedCardIds);
    const missing = setResult.cards
      .filter(c => !ownedSet.has(c.pokemon_tcg_id))
      .map(c => ({
        ...c,
        price_market_zar: usdToZar(c.price_market, rate),
      }));

    const owned = setResult.cards.filter(c => ownedSet.has(c.pokemon_tcg_id));

    // Check which missing cards EliteTCG sells (marketplace + store)
    let availableOnSite = [];

    if (supabaseAdmin) {
      // Check marketplace listings that match missing card names
      const missingNames = missing.map(c => c.card_name);
      if (missingNames.length > 0) {
        const { data: listings } = await supabaseAdmin
          .from('marketplace_listings')
          .select('id, title, card_name, set_name, price, images, condition, seller_id')
          .eq('status', 'active')
          .ilike('set_name', `%${set_code}%`)
          .in('card_name', missingNames.slice(0, 50)); // Supabase has IN limit

        availableOnSite = listings || [];
      }
    }

    res.json({
      set_code,
      total_in_set: setResult.totalCount,
      owned_count: owned.length,
      missing_count: missing.length,
      completion_percentage: setResult.totalCount > 0
        ? Math.round((owned.length / setResult.totalCount) * 10000) / 100
        : 0,
      missing_cards: missing,
      available_on_site: availableOnSite,
    });
  } catch (error) {
    console.error('Get collection gaps error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get set completion stats for all sets the user collects
router.get('/completion', authenticateCustomer, async (req, res) => {
  try {
    const customerId = req.customer.id;

    let cardsBySet = {};

    if (supabaseAdmin) {
      const { data: cards } = await supabaseAdmin
        .from('portfolio_cards')
        .select('pokemon_tcg_id, set_code, set_name')
        .eq('customer_id', customerId);

      (cards || []).forEach(c => {
        if (!c.set_code) return;
        if (!cardsBySet[c.set_code]) {
          cardsBySet[c.set_code] = { set_code: c.set_code, set_name: c.set_name, owned_ids: new Set() };
        }
        cardsBySet[c.set_code].owned_ids.add(c.pokemon_tcg_id);
      });
    } else {
      mockPortfolioCards
        .filter(c => c.customer_id === customerId && c.set_code)
        .forEach(c => {
          if (!cardsBySet[c.set_code]) {
            cardsBySet[c.set_code] = { set_code: c.set_code, set_name: c.set_name, owned_ids: new Set() };
          }
          cardsBySet[c.set_code].owned_ids.add(c.pokemon_tcg_id);
        });
    }

    // Fetch set totals from pokemontcg.io
    const completionStats = [];

    for (const [setCode, info] of Object.entries(cardsBySet)) {
      try {
        // Quick fetch just to get total count
        const setResult = await getCardsBySet(setCode, { page: 1, pageSize: 1 });
        completionStats.push({
          set_code: setCode,
          set_name: info.set_name,
          owned: info.owned_ids.size,
          total: setResult.totalCount,
          completion_percentage: setResult.totalCount > 0
            ? Math.round((info.owned_ids.size / setResult.totalCount) * 10000) / 100
            : 0,
        });
      } catch {
        completionStats.push({
          set_code: setCode,
          set_name: info.set_name,
          owned: info.owned_ids.size,
          total: null,
          completion_percentage: null,
        });
      }
    }

    // Sort by completion percentage descending
    completionStats.sort((a, b) => (b.completion_percentage || 0) - (a.completion_percentage || 0));

    res.json({ sets: completionStats });
  } catch (error) {
    console.error('Get completion stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// PRICE REFRESH (manual trigger)
// ============================================

// Refresh prices for all cards in portfolio
router.post('/refresh-prices', authenticateCustomer, async (req, res) => {
  try {
    const customerId = req.customer.id;

    let cards;

    if (supabaseAdmin) {
      const { data } = await supabaseAdmin
        .from('portfolio_cards')
        .select('id, pokemon_tcg_id')
        .eq('customer_id', customerId);
      cards = data || [];
    } else {
      cards = mockPortfolioCards.filter(c => c.customer_id === customerId);
    }

    if (cards.length === 0) {
      return res.json({ message: 'No cards to refresh', updated: 0 });
    }

    // Cap at 50 cards per refresh to avoid rate limits
    const toRefresh = cards.slice(0, 50);
    const rate = await getUsdToZarRate();
    let updated = 0;

    for (const card of toRefresh) {
      try {
        const apiCard = await getCardById(card.pokemon_tcg_id);
        if (apiCard && apiCard.price_market != null) {
          const updates = {
            latest_price_market: apiCard.price_market,
            latest_price_market_zar: usdToZar(apiCard.price_market, rate),
            price_updated_at: new Date().toISOString(),
          };

          if (supabaseAdmin) {
            await supabaseAdmin
              .from('portfolio_cards')
              .update(updates)
              .eq('id', card.id);

            // Also update price cache
            await supabaseAdmin
              .from('card_price_cache')
              .upsert({
                pokemon_tcg_id: apiCard.pokemon_tcg_id,
                card_name: apiCard.card_name,
                set_name: apiCard.set_name,
                set_code: apiCard.set_code,
                card_number: apiCard.card_number,
                supertype: apiCard.supertype,
                rarity: apiCard.rarity,
                card_image_small: apiCard.card_image_small,
                card_image_large: apiCard.card_image_large,
                price_market: apiCard.price_market,
                price_low: apiCard.price_low,
                price_mid: apiCard.price_mid,
                price_high: apiCard.price_high,
                price_market_zar: usdToZar(apiCard.price_market, rate),
                usd_to_zar_rate: rate,
                fetched_at: new Date().toISOString(),
              }, { onConflict: 'pokemon_tcg_id' });
          } else {
            const idx = mockPortfolioCards.findIndex(c => c.id === card.id);
            if (idx !== -1) Object.assign(mockPortfolioCards[idx], updates);
          }

          updated++;
        }
      } catch {
        // Skip individual card errors
      }
    }

    res.json({
      message: `Refreshed prices for ${updated} card(s)`,
      updated,
      total: cards.length,
      remaining: Math.max(0, cards.length - 50),
    });
  } catch (error) {
    console.error('Refresh prices error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
