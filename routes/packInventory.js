/**
 * Pack Inventory Routes — /api/pack-inventory
 *
 * Admin CRUD for managing real opened packs and their cards.
 * These packs are physically opened on camera, contents recorded,
 * then assigned to users via the provably-fair pack selection system.
 */

import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticateSupabaseUser, requireRole } from '../middleware/auth.js';

const router = Router();

// All routes require admin auth
router.use(authenticateSupabaseUser, requireRole('admin'));

// ── Known sets with images uploaded to Supabase Storage ──────────────────────
const KNOWN_SETS = [
  // Mega Evolution
  { id: 'me02pt5', name: 'Ascended Heroes', tcgdex: 'me02.5', totalCards: 295 },
  { id: 'me02', name: 'Phantasmal Flames', tcgdex: 'me02', totalCards: 130 },
  { id: 'me01', name: 'Mega Evolution', tcgdex: 'me01', totalCards: 188 },
  // Scarlet & Violet
  { id: 'sv10pt5b', name: 'Black Bolt', tcgdex: 'sv10.5b', totalCards: 172 },
  { id: 'sv10pt5w', name: 'White Flare', tcgdex: 'sv10.5w', totalCards: 173 },
  { id: 'sv10', name: 'Destined Rivals', tcgdex: 'sv10', totalCards: 244 },
  { id: 'sv9', name: 'Journey Together', tcgdex: 'sv09', totalCards: 167 },
  { id: 'sv8pt5', name: 'Prismatic Evolutions', tcgdex: 'sv08.5', totalCards: 175 },
  { id: 'sv8', name: 'Surging Sparks', tcgdex: 'sv08', totalCards: 191 },
  { id: 'sv4pt5', name: 'Paldean Fates', tcgdex: 'sv04.5', totalCards: 245 },
  { id: 'sv3pt5', name: '151', tcgdex: 'sv03.5', totalCards: 207 },
  { id: 'sv2', name: 'Paldea Evolved', tcgdex: 'sv02', totalCards: 193 },
  // Sword & Shield
  { id: 'swsh8', name: 'Fusion Strike', tcgdex: 'swsh8', totalCards: 264 },
  { id: 'swsh7', name: 'Evolving Skies', tcgdex: 'swsh7', totalCards: 203 },
  { id: 'swsh6', name: 'Chilling Reign', tcgdex: 'swsh6', totalCards: 198 },
];

// Supabase Storage base URL for card images
const STORAGE_BASE = 'https://vqtgpgbifsiokmvwgubh.supabase.co/storage/v1/object/public/images';

// TCGdex API
const TCGDEX_BASE = 'https://api.tcgdex.net/v2/en';
async function tcgdexFetch(path) {
  const res = await fetch(`${TCGDEX_BASE}${path}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`TCGdex ${res.status}`);
  return res.json();
}

// EUR→ZAR conversion (cached)
let eurToZar = 20.0;
let eurRateTs = 0;
async function getEurToZar() {
  if (Date.now() - eurRateTs < 60 * 60 * 1000) return eurToZar;
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/EUR', { signal: AbortSignal.timeout(5000) });
    if (res.ok) { const j = await res.json(); eurToZar = j.rates?.ZAR || 20.0; eurRateTs = Date.now(); }
  } catch {}
  return eurToZar;
}

// Card catalog cache
const catalogCache = new Map();
const CATALOG_TTL = 60 * 60 * 1000; // 1 hour

// Rarity mapping from TCGdex strings to our system
function mapRarity(apiRarity) {
  if (!apiRarity) return 'common';
  const l = apiRarity.toLowerCase();
  if (l.includes('ultra') || l.includes('secret') || l.includes('rainbow') || l.includes('illustration')
    || l.includes('special art') || l.includes('full art') || l.includes('hyper') || l.includes('double rare')
    || l.includes('ace spec') || l.includes('shiny ultra') || l.includes('amazing')
    || l.includes('vmax') || l.includes('vstar') || l.includes('ex') || l.includes('gx')
    || l.includes('mega')) return 'ultra_rare';
  if (l.includes('rare') || l.includes('holo')) return 'rare';
  if (l.includes('uncommon')) return 'uncommon';
  return 'common';
}

// ── GET /api/pack-inventory/known-sets — List sets that have images uploaded ──
router.get('/known-sets', (req, res) => {
  res.json(KNOWN_SETS);
});

// ── GET /api/pack-inventory/card-catalog/:setId — Full card catalog with images/prices
router.get('/card-catalog/:setId', async (req, res) => {
  try {
    const setId = req.params.setId;
    const knownSet = KNOWN_SETS.find(s => s.id === setId);
    if (!knownSet) return res.status(404).json({ error: 'Set not found in known sets' });

    // Check cache
    const cached = catalogCache.get(setId);
    if (cached && Date.now() - cached.ts < CATALOG_TTL) {
      return res.json(cached.data);
    }

    // Fetch set + all card details from TCGdex
    const setData = await tcgdexFetch(`/sets/${knownSet.tcgdex}`);
    const rawCards = setData.cards || [];

    // Fetch individual card details (rarity + pricing) in parallel
    const rate = await getEurToZar();
    const details = await Promise.allSettled(
      rawCards.map(c => tcgdexFetch(`/cards/${c.id}`))
    );

    const cards = rawCards.map((c, i) => {
      const detail = details[i].status === 'fulfilled' ? details[i].value : null;
      const rarity = detail?.rarity || 'Common';
      const cm = detail?.pricing?.cardmarket;
      const priceEur = cm?.trend ?? cm?.avg ?? cm?.low ?? null;
      const priceZar = priceEur != null ? Math.round(priceEur * rate * 100) / 100 : 0;
      const num = String(c.localId).padStart(3, '0');

      return {
        card_name: c.name,
        card_number: c.localId,
        rarity: mapRarity(rarity),
        original_rarity: rarity,
        image_url: `${STORAGE_BASE}/cards/${setId}/${num}.png`,
        price_zar: priceZar,
      };
    });

    // Add energy cards (shared across all sets — code card available but not forced)
    const extraCards = [
      { card_name: 'Fire Energy', card_number: 'E-Fire', rarity: 'common', image_url: `${STORAGE_BASE}/cards/shared/energy_fire.png`, price_zar: 0 },
      { card_name: 'Water Energy', card_number: 'E-Water', rarity: 'common', image_url: `${STORAGE_BASE}/cards/shared/energy_water.png`, price_zar: 0 },
      { card_name: 'Grass Energy', card_number: 'E-Grass', rarity: 'common', image_url: `${STORAGE_BASE}/cards/shared/energy_grass.png`, price_zar: 0 },
      { card_name: 'Lightning Energy', card_number: 'E-Lightning', rarity: 'common', image_url: `${STORAGE_BASE}/cards/shared/energy_lightning.png`, price_zar: 0 },
      { card_name: 'Psychic Energy', card_number: 'E-Psychic', rarity: 'common', image_url: `${STORAGE_BASE}/cards/shared/energy_psychic.png`, price_zar: 0 },
      { card_name: 'Fighting Energy', card_number: 'E-Fighting', rarity: 'common', image_url: `${STORAGE_BASE}/cards/shared/energy_fighting.png`, price_zar: 0 },
      { card_name: 'Dark Energy', card_number: 'E-Dark', rarity: 'common', image_url: `${STORAGE_BASE}/cards/shared/energy_dark.png`, price_zar: 0 },
      { card_name: 'Metal Energy', card_number: 'E-Metal', rarity: 'common', image_url: `${STORAGE_BASE}/cards/shared/energy_metal.png`, price_zar: 0 },
      { card_name: 'Code Card', card_number: 'CODE', rarity: 'common', image_url: `${STORAGE_BASE}/cards/shared/code_card.jpg`, price_zar: 0 },
    ];

    const result = { set_id: setId, set_name: knownSet.name, cards: [...extraCards, ...cards] };
    catalogCache.set(setId, { data: result, ts: Date.now() });

    console.log(`[PackInventory] Card catalog for ${setId}: ${cards.length} cards loaded`);
    res.json(result);
  } catch (err) {
    console.error('[PackInventory] card-catalog error:', err);
    res.status(500).json({ error: 'Failed to fetch card catalog' });
  }
});

// ── GET /api/pack-inventory — List all packs with card counts ────────────────
router.get('/', async (req, res) => {
  try {
    const { set_id, status, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from('opened_packs')
      .select('*, pack_cards(count)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (set_id) query = query.eq('set_id', set_id);
    if (status) query = query.eq('status', status);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({
      packs: data.map(p => ({
        ...p,
        card_count: p.pack_cards?.[0]?.count || 0,
        pack_cards: undefined,
      })),
      total: count,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (err) {
    console.error('[PackInventory] list error:', err);
    res.status(500).json({ error: 'Failed to fetch packs' });
  }
});

// ── GET /api/pack-inventory/next-pack-number/:setId — Next pack number ────────
router.get('/next-pack-number/:setId', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('opened_packs')
      .select('pack_number')
      .eq('set_id', req.params.setId)
      .order('pack_number', { ascending: false })
      .limit(1);

    if (error) throw error;
    const next = (data?.[0]?.pack_number || 0) + 1;
    res.json({ next });
  } catch (err) {
    console.error('[PackInventory] next-pack-number error:', err);
    res.status(500).json({ error: 'Failed to get next pack number' });
  }
});

// ── GET /api/pack-inventory/sets/available — Available sets for frontend ──────
router.get('/sets/available', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('opened_packs')
      .select('set_id, set_name')
      .eq('status', 'available');

    if (error) throw error;

    // Group by set_id with count
    const sets = {};
    (data || []).forEach(p => {
      if (!sets[p.set_id]) sets[p.set_id] = { set_id: p.set_id, set_name: p.set_name, available: 0 };
      sets[p.set_id].available++;
    });

    res.json(Object.values(sets));
  } catch (err) {
    console.error('[PackInventory] available sets error:', err);
    res.status(500).json({ error: 'Failed to fetch available sets' });
  }
});

// ── GET /api/pack-inventory/stats — Overview stats ───────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [available, sold, reserved] = await Promise.all([
      supabaseAdmin.from('opened_packs').select('id', { count: 'exact', head: true }).eq('status', 'available'),
      supabaseAdmin.from('opened_packs').select('id', { count: 'exact', head: true }).eq('status', 'sold'),
      supabaseAdmin.from('opened_packs').select('id', { count: 'exact', head: true }).eq('status', 'reserved'),
    ]);

    // Get counts per set
    const { data: setCounts } = await supabaseAdmin
      .from('opened_packs')
      .select('set_id, set_name, status');

    const sets = {};
    (setCounts || []).forEach(p => {
      if (!sets[p.set_id]) sets[p.set_id] = { set_id: p.set_id, set_name: p.set_name, available: 0, sold: 0, total: 0 };
      sets[p.set_id].total++;
      if (p.status === 'available') sets[p.set_id].available++;
      if (p.status === 'sold') sets[p.set_id].sold++;
    });

    res.json({
      available: available.count || 0,
      sold: sold.count || 0,
      reserved: reserved.count || 0,
      total: (available.count || 0) + (sold.count || 0) + (reserved.count || 0),
      sets: Object.values(sets),
    });
  } catch (err) {
    console.error('[PackInventory] stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ── GET /api/pack-inventory/:id — Single pack with cards ─────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('opened_packs')
      .select('*, pack_cards(*)')
      .eq('id', req.params.id)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Pack not found' });

    // Sort cards by sort_order
    if (data.pack_cards) {
      data.pack_cards.sort((a, b) => a.sort_order - b.sort_order);
    }

    res.json(data);
  } catch (err) {
    console.error('[PackInventory] get error:', err);
    res.status(500).json({ error: 'Failed to fetch pack' });
  }
});

// ── POST /api/pack-inventory — Create a pack with its cards ──────────────────
router.post('/', async (req, res) => {
  try {
    const { set_id, set_name, pack_number, video_url, cards } = req.body;

    if (!set_id || !set_name || !pack_number) {
      return res.status(400).json({ error: 'set_id, set_name, and pack_number are required' });
    }
    if (!cards || !Array.isArray(cards) || cards.length === 0) {
      return res.status(400).json({ error: 'At least one card is required' });
    }

    // Calculate total value
    const total_value_zar = cards.reduce((sum, c) => sum + (Number(c.price_zar) || 0), 0);

    // Insert pack
    const { data: pack, error: packError } = await supabaseAdmin
      .from('opened_packs')
      .insert({
        set_id,
        set_name,
        pack_number: Number(pack_number),
        video_url: video_url || null,
        total_value_zar,
        status: 'available',
      })
      .select()
      .single();

    if (packError) throw packError;

    // Insert cards
    const cardRows = cards.map((c, i) => ({
      pack_id: pack.id,
      card_name: c.card_name,
      card_number: c.card_number || null,
      rarity: c.rarity || 'common',
      image_url: c.image_url || null,
      price_zar: Number(c.price_zar) || 0,
      sort_order: i,
    }));

    const { error: cardsError } = await supabaseAdmin
      .from('pack_cards')
      .insert(cardRows);

    if (cardsError) throw cardsError;

    res.status(201).json({ ...pack, card_count: cardRows.length });
  } catch (err) {
    console.error('[PackInventory] create error:', err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Pack number already exists for this set' });
    }
    res.status(500).json({ error: 'Failed to create pack' });
  }
});

// ── PUT /api/pack-inventory/:id — Update pack metadata ───────────────────────
router.put('/:id', async (req, res) => {
  try {
    const { set_id, set_name, pack_number, video_url, status } = req.body;
    const updates = {};
    if (set_id !== undefined) updates.set_id = set_id;
    if (set_name !== undefined) updates.set_name = set_name;
    if (pack_number !== undefined) updates.pack_number = Number(pack_number);
    if (video_url !== undefined) updates.video_url = video_url;
    if (status !== undefined) updates.status = status;

    const { data, error } = await supabaseAdmin
      .from('opened_packs')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('[PackInventory] update error:', err);
    res.status(500).json({ error: 'Failed to update pack' });
  }
});

// ── PUT /api/pack-inventory/:id/cards — Replace all cards for a pack ─────────
router.put('/:id/cards', async (req, res) => {
  try {
    const { cards } = req.body;
    if (!cards || !Array.isArray(cards)) {
      return res.status(400).json({ error: 'cards array is required' });
    }

    // Delete existing cards
    await supabaseAdmin.from('pack_cards').delete().eq('pack_id', req.params.id);

    // Insert new cards
    const cardRows = cards.map((c, i) => ({
      pack_id: req.params.id,
      card_name: c.card_name,
      card_number: c.card_number || null,
      rarity: c.rarity || 'common',
      image_url: c.image_url || null,
      price_zar: Number(c.price_zar) || 0,
      sort_order: i,
    }));

    const { error } = await supabaseAdmin.from('pack_cards').insert(cardRows);
    if (error) throw error;

    // Update total value on pack
    const total_value_zar = cards.reduce((sum, c) => sum + (Number(c.price_zar) || 0), 0);
    await supabaseAdmin
      .from('opened_packs')
      .update({ total_value_zar })
      .eq('id', req.params.id);

    res.json({ card_count: cardRows.length, total_value_zar });
  } catch (err) {
    console.error('[PackInventory] update cards error:', err);
    res.status(500).json({ error: 'Failed to update cards' });
  }
});

// ── DELETE /api/pack-inventory/:id — Delete a pack and its cards ─────────────
router.delete('/:id', async (req, res) => {
  try {
    // Cards cascade-delete via FK
    const { error } = await supabaseAdmin
      .from('opened_packs')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('[PackInventory] delete error:', err);
    res.status(500).json({ error: 'Failed to delete pack' });
  }
});

export default router;
