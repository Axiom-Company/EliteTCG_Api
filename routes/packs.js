/**
 * Pack Opening Routes — /api/packs
 *
 * Provably fair mystery pack system.
 * Primary: TCGdex API (fast, free, has pricing from Cardmarket)
 * Fallback: pokemontcg.io image CDN for card images
 */

import crypto from 'crypto';
import { Router } from 'express';
import { optionalCustomerAuth, authenticateCustomer, requirePageAccess } from '../middleware/auth.js';
import {
  generateServerSeed,
  hashServerSeed,
  generateClientSeed,
  generateTimeNonce,
  generatePackRolls,
  rollToRarity,
  rollToCardIndex,
  verifyRoll,
} from '../utils/provablyFair.js';

const router = Router();

// ── TCGdex API ───────────────────────────────────────────────────────────────
const TCGDEX_BASE = 'https://api.tcgdex.net/v2/en';

// Map our set IDs (used in frontend) to TCGdex set IDs
const SET_ID_MAP = {
  'me02pt5': 'me02.5', 'me02': 'me02', 'me01': 'me01',
  'sv10pt5b': 'sv10.5b', 'sv10pt5w': 'sv10.5w', 'sv10': 'sv10',
  'sv9': 'sv09', 'sv8pt5': 'sv08.5', 'sv8': 'sv08', 'sv7': 'sv07',
  'sv6pt5': 'sv06.5', 'sv6': 'sv06', 'sv5': 'sv05', 'sv4pt5': 'sv04.5',
  'sv4': 'sv04', 'sv3pt5': 'sv03.5', 'sv3': 'sv03', 'sv2': 'sv02', 'sv1': 'sv01',
  'swsh12pt5': 'swsh12.5', 'swsh12': 'swsh12', 'swsh11': 'swsh11',
  'swsh10': 'swsh10', 'swsh9': 'swsh9', 'swsh8': 'swsh8',
  'swsh7': 'swsh7', 'swsh6': 'swsh6', 'swsh5': 'swsh5',
  'swsh45': 'swsh4.5', 'swsh4': 'swsh4', 'swsh3': 'swsh3',
  'swsh2': 'swsh2', 'swsh1': 'swsh1',
  'sm12': 'sm12', 'sm11': 'sm11', 'sm10': 'sm10', 'sm9': 'sm9', 'sm8': 'sm8',
};

async function tcgdexFetch(path) {
  const res = await fetch(`${TCGDEX_BASE}${path}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`TCGdex ${res.status} for ${path}`);
  return res.json();
}

// ── EUR → ZAR conversion ────────────────────────────────────────────────────
let eurToZar = 20.0;
let eurRateTimestamp = 0;
async function getEurToZar() {
  if (Date.now() - eurRateTimestamp < 60 * 60 * 1000) return eurToZar;
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/EUR', {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const json = await res.json();
      eurToZar = json.rates?.ZAR || 20.0;
      eurRateTimestamp = Date.now();
    }
  } catch {}
  return eurToZar;
}

// ── Card cache ───────────────────────────────────────────────────────────────
const cardCache = new Map();      // ourSetId → { cards, timestamp }
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const priceCache = new Map();     // tcgdexCardId → { priceEur, timestamp }
const PRICE_CACHE_TTL = 30 * 60 * 1000; // 30 min

/**
 * Fetch all cards for a set from TCGdex.
 * Fetches rarity for EVERY card to ensure correct pull rates.
 * Takes ~5-8s on first load (cached for 1 hour after).
 */
async function getSetCards(ourSetId) {
  const cached = cardCache.get(ourSetId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.cards;
  }

  const tcgdexId = SET_ID_MAP[ourSetId] || ourSetId;

  try {
    // Get set with card list
    const setData = await tcgdexFetch(`/sets/${tcgdexId}`);
    const rawCards = setData.cards || [];

    if (rawCards.length === 0) throw new Error('No cards in set');

    // Fetch ALL individual cards for rarity data (batched, 50 concurrent)
    const rarityMap = new Map(); // localId → rarity
    const batchSize = 50;
    console.log(`[Packs] Fetching rarity for ${rawCards.length} cards in ${tcgdexId}...`);

    const allResults = await Promise.allSettled(
      rawCards.map(c => tcgdexFetch(`/cards/${c.id}`))
    );
    allResults.forEach((r) => {
      if (r.status === 'fulfilled' && r.value) {
        rarityMap.set(r.value.localId, r.value.rarity || 'Common');
      }
    });

    // Build card list with real rarity
    const cards = rawCards.map((c) => {
      const rarity = rarityMap.get(c.localId) || 'Common';
      return {
        pokemon_tcg_id: c.id,
        card_name: c.name,
        set_name: setData.name,
        set_code: ourSetId,
        card_number: c.localId,
        rarity,
        card_image_small: c.image ? `${c.image}/high.png` : `https://images.pokemontcg.io/${ourSetId}/${c.localId}.png`,
        card_image_large: c.image ? `${c.image}/high.png` : `https://images.pokemontcg.io/${ourSetId}/${c.localId}_hires.png`,
        artist: null,
      };
    });

    // Log rarity distribution
    const dist = {};
    cards.forEach(c => { dist[c.rarity] = (dist[c.rarity] || 0) + 1; });
    console.log(`[Packs] ${ourSetId}: ${cards.length} cards, rarity for ${rarityMap.size}/${rawCards.length}. Distribution:`, dist);

    cardCache.set(ourSetId, { cards, timestamp: Date.now() });
    return cards;
  } catch (err) {
    console.error(`[Packs] TCGdex failed for ${ourSetId}:`, err.message);

    // Fallback: generate cards with pokemontcg.io image URLs
    const setInfo = FALLBACK_SETS.find(s => s.id === ourSetId);
    const total = setInfo?.total || 150;
    const count = Math.min(total, 200);
    const cards = [];
    for (let i = 1; i <= count; i++) {
      const rarity = i > count * 0.9 ? 'Rare' : i > count * 0.55 ? 'Uncommon' : 'Common';
      cards.push({
        pokemon_tcg_id: `${ourSetId}-${i}`,
        card_name: `${ourSetId.toUpperCase()} #${i}`,
        set_name: ourSetId,
        set_code: ourSetId,
        card_number: String(i),
        rarity,
        card_image_small: `https://images.pokemontcg.io/${ourSetId}/${i}.png`,
        card_image_large: `https://images.pokemontcg.io/${ourSetId}/${i}_hires.png`,
        artist: null,
      });
    }
    cardCache.set(ourSetId, { cards, timestamp: Date.now() - CACHE_TTL + 5 * 60 * 1000 });
    return cards;
  }
}

/**
 * Fetch price for a single card from TCGdex (Cardmarket EUR prices)
 */
async function getCardPrice(tcgdexCardId) {
  const cached = priceCache.get(tcgdexCardId);
  if (cached && Date.now() - cached.timestamp < PRICE_CACHE_TTL) {
    return cached.priceEur;
  }

  try {
    const data = await tcgdexFetch(`/cards/${tcgdexCardId}`);
    const cm = data.pricing?.cardmarket;
    const priceEur = cm?.trend ?? cm?.avg ?? cm?.low ?? null;
    priceCache.set(tcgdexCardId, { priceEur, timestamp: Date.now() });
    return priceEur;
  } catch {
    return null;
  }
}

// ── Fallback sets ────────────────────────────────────────────────────────────
const FALLBACK_SETS = [
  { id: 'sv8', total: 191 }, { id: 'sv7', total: 175 }, { id: 'sv6', total: 167 },
  { id: 'sv5', total: 162 }, { id: 'sv4', total: 182 }, { id: 'sv3pt5', total: 207 },
  { id: 'sv3', total: 197 }, { id: 'sv2', total: 193 }, { id: 'sv1', total: 198 },
];

// ── Seed sessions ────────────────────────────────────────────────────────────
const seedSessions = new Map();

function getSessionKey(req) {
  return req.customer?.id || req.ip;
}

function getOrCreateSession(req) {
  const key = getSessionKey(req);
  let session = seedSessions.get(key);
  if (!session) {
    const serverSeed = generateServerSeed();
    // Client seed = username if logged in, otherwise random
    const username = req.customer?.first_name || req.customer?.email?.split('@')[0];
    session = {
      serverSeed,
      serverSeedHash: hashServerSeed(serverSeed),
      clientSeed: username || generateClientSeed(),
      nonce: 0,
    };
    seedSessions.set(key, session);
  }
  return session;
}

// ── Rarity mapping ───────────────────────────────────────────────────────────
const RARITY_MAP = {
  'Common': 'common',
  'Uncommon': 'uncommon',
  'Rare': 'rare',
  'Rare Holo': 'rare',
  'Double Rare': 'ultra_rare',
  'Double rare': 'ultra_rare',
  'Shiny Rare': 'rare',
  'Classic Collection': 'rare',
  'Hyper rare': 'ultra_rare',
  'Special illustration rare': 'ultra_rare',
  'ACE SPEC Rare': 'ultra_rare',
  'Rare Holo EX': 'ultra_rare',
  'Rare Holo GX': 'ultra_rare',
  'Rare Holo V': 'ultra_rare',
  'Rare VMAX': 'ultra_rare',
  'Rare VSTAR': 'ultra_rare',
  'Rare Ultra': 'ultra_rare',
  'Rare Rainbow': 'ultra_rare',
  'Rare Secret': 'ultra_rare',
  'Rare Shiny': 'ultra_rare',
  'Rare Shiny GX': 'ultra_rare',
  'Rare ACE': 'ultra_rare',
  'Illustration Rare': 'ultra_rare',
  'Special Illustration Rare': 'ultra_rare',
  'Hyper Rare': 'ultra_rare',
  'Ultra Rare': 'ultra_rare',
  'Shiny Ultra Rare': 'ultra_rare',
  'ACE SPEC Rare': 'ultra_rare',
  'Amazing Rare': 'ultra_rare',
  'LEGEND': 'ultra_rare',
  'Promo': 'uncommon',
};

function mapRarity(apiRarity) {
  if (!apiRarity) return 'common';
  // Try exact match first
  if (RARITY_MAP[apiRarity]) return RARITY_MAP[apiRarity];
  // Try title-cased version
  const titleCased = apiRarity.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  if (RARITY_MAP[titleCased]) return RARITY_MAP[titleCased];
  // Keyword-based fallback for variants TCGdex may return
  const lower = apiRarity.toLowerCase();
  if (lower.includes('vmax') || lower.includes('vstar') || lower.includes('v-union')
    || lower.includes('ex') || lower.includes('gx') || lower.includes('tag team')
    || lower.includes('ultra') || lower.includes('secret') || lower.includes('rainbow')
    || lower.includes('illustration') || lower.includes('special art') || lower.includes('full art')
    || lower.includes('hyper') || lower.includes('double rare') || lower.includes('ace spec')
    || lower.includes('shiny ultra') || lower.includes('amazing')) {
    return 'ultra_rare';
  }
  if (lower.includes('rare') || lower.includes('holo')) return 'rare';
  if (lower.includes('uncommon')) return 'uncommon';
  return 'common';
}

// ── Pack weights ─────────────────────────────────────────────────────────────
// 8-card pack composition:
// Slots 1-4: Common
// Slots 5-6: Uncommon (guaranteed)
// Slot 7: Rare (guaranteed holo rare)
// Slot 8: The "hit slot" — rare or better
//   ~92% regular rare, ~8% ultra rare (~1 in 12 packs)
const SLOT_WEIGHTS = [
  [{ rarity: 'common', weight: 100 }],     // slot 1
  [{ rarity: 'common', weight: 100 }],     // slot 2
  [{ rarity: 'common', weight: 100 }],     // slot 3
  [{ rarity: 'common', weight: 100 }],     // slot 4
  [{ rarity: 'uncommon', weight: 100 }],   // slot 5
  [{ rarity: 'uncommon', weight: 100 }],   // slot 6
  [{ rarity: 'rare', weight: 100 }],       // slot 7 — guaranteed rare
  [{ rarity: 'rare', weight: 92 }, { rarity: 'ultra_rare', weight: 8 }], // slot 8 — ~1 in 12
];

const CARDS_PER_PACK = 8;
const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, ultra_rare: 3 };

// ── Routes ───────────────────────────────────────────────────────────────────

router.get('/seed', optionalCustomerAuth, (req, res) => {
  const session = getOrCreateSession(req);
  res.json({
    serverSeedHash: session.serverSeedHash,
    clientSeed: session.clientSeed,
    nonce: session.nonce,
  });
});

router.post('/seed/client', optionalCustomerAuth, (req, res) => {
  const { clientSeed } = req.body;
  if (!clientSeed || typeof clientSeed !== 'string' || clientSeed.length < 1 || clientSeed.length > 64) {
    return res.status(400).json({ error: 'Client seed must be 1-64 characters' });
  }
  const session = getOrCreateSession(req);
  session.clientSeed = clientSeed;
  res.json({ clientSeed: session.clientSeed, serverSeedHash: session.serverSeedHash });
});

router.post('/seed/rotate', optionalCustomerAuth, (req, res) => {
  const key = getSessionKey(req);
  const oldSession = seedSessions.get(key);
  const newServerSeed = generateServerSeed();
  const newSession = {
    serverSeed: newServerSeed,
    serverSeedHash: hashServerSeed(newServerSeed),
    clientSeed: oldSession?.clientSeed || generateClientSeed(),
    nonce: 0,
  };
  seedSessions.set(key, newSession);
  res.json({
    previousServerSeed: oldSession?.serverSeed || null,
    previousServerSeedHash: oldSession?.serverSeedHash || null,
    newServerSeedHash: newSession.serverSeedHash,
    clientSeed: newSession.clientSeed,
    nonce: 0,
  });
});

/**
 * POST /api/packs/open — Open a pack (provably fair)
 */
router.post('/open', authenticateCustomer, requirePageAccess('/elite-rips'), async (req, res) => {
  try {
    const { setId } = req.body;
    if (!setId) return res.status(400).json({ error: 'setId is required' });

    const allCards = await getSetCards(setId);
    if (!allCards.length) return res.status(404).json({ error: 'No cards found for this set' });

    // Bucket by rarity
    const buckets = { common: [], uncommon: [], rare: [], ultra_rare: [] };
    allCards.forEach(c => {
      buckets[mapRarity(c.rarity)].push(c);
    });
    if (!buckets.common.length) buckets.common = allCards;
    if (!buckets.uncommon.length) buckets.uncommon = buckets.common;
    if (!buckets.rare.length) buckets.rare = buckets.uncommon;
    if (!buckets.ultra_rare.length) buckets.ultra_rare = buckets.rare;

    // Provably fair rolls — time-based nonce + incrementing counter for uniqueness
    const session = getOrCreateSession(req);
    const timeNonce = generateTimeNonce();
    const nonce = `${timeNonce}:${session.nonce}`;
    session.nonce++;
    const rolls = generatePackRolls(session.serverSeed, session.clientSeed, nonce, CARDS_PER_PACK);

    // Pick cards — no duplicates within a pack (increment sub-nonce to re-roll)
    const usedCardIds = new Set();
    const packCards = [];

    for (let i = 0; i < CARDS_PER_PACK; i++) {
      const rarity = rollToRarity(rolls[i], SLOT_WEIGHTS[i]);
      const bucket = buckets[rarity];

      let card = null;
      let attempt = 0;
      let roll = rolls[i];

      while (attempt < 20) {
        const cardIdx = rollToCardIndex(
          ((roll * 1000) % 1) || roll,
          bucket.length
        );
        const candidate = bucket[Math.min(cardIdx, bucket.length - 1)];

        if (!usedCardIds.has(candidate.pokemon_tcg_id)) {
          card = candidate;
          usedCardIds.add(candidate.pokemon_tcg_id);
          break;
        }

        // Re-roll with incremented sub-nonce to avoid duplicate
        attempt++;
        const reMsg = `${session.clientSeed}:${nonce}:${i}:${attempt}`;
        const reHmac = crypto
          .createHmac('sha512', session.serverSeed).update(reMsg).digest('hex');
        roll = parseInt(reHmac.substring(0, 8), 16) / 0x100000000;
      }

      if (!card) card = bucket[0]; // safety fallback
      packCards.push({ ...card, mappedRarity: mapRarity(card.rarity) });
    }

    // Fetch prices for the 5 selected cards in parallel from TCGdex
    const rate = await getEurToZar();
    const prices = await Promise.allSettled(
      packCards.map(c => getCardPrice(c.pokemon_tcg_id))
    );

    const result = packCards.map((card, i) => {
      const priceEur = prices[i].status === 'fulfilled' ? prices[i].value : null;
      const priceZar = priceEur != null ? Math.round(priceEur * rate * 100) / 100 : null;

      return {
        id: card.pokemon_tcg_id,
        name: card.card_name,
        image: card.card_image_small,
        imageLarge: card.card_image_large,
        rarity: card.mappedRarity,
        originalRarity: card.rarity,
        number: card.card_number,
        priceEur,
        priceZar,
      };
    });

    // Sort by rarity (best last)
    result.sort((a, b) => (RARITY_ORDER[a.rarity] || 0) - (RARITY_ORDER[b.rarity] || 0));

    console.log('[Packs] Opened pack:', result.map(c => `${c.name} (${c.rarity}) R${c.priceZar ?? '?'}`).join(', '));

    res.json({
      cards: result,
      fairness: {
        serverSeedHash: session.serverSeedHash,
        clientSeed: session.clientSeed,
        nonce,
      },
    });
  } catch (err) {
    console.error('[Packs] open error:', err);
    res.status(500).json({ error: 'Failed to open pack' });
  }
});

router.post('/verify', (req, res) => {
  const { serverSeed, clientSeed, nonce, cardIndex } = req.body;
  if (!serverSeed || !clientSeed || nonce == null || cardIndex == null) {
    return res.status(400).json({ error: 'serverSeed, clientSeed, nonce, and cardIndex are required' });
  }
  const result = verifyRoll(serverSeed, clientSeed, nonce, cardIndex);
  res.json({ ...result, serverSeedHash: hashServerSeed(serverSeed) });
});

export default router;
