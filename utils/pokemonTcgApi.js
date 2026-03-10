/**
 * Pokemon TCG API Utility
 *
 * Wraps the pokemontcg.io REST API v2 for card search, pricing,
 * and set data.  No SDK required — just plain fetch.
 *
 * API docs: https://docs.pokemontcg.io/
 * Rate limit (no key): 1000 req/day; (with key): 20 000 req/day.
 */

const POKEMON_TCG_BASE = 'https://api.pokemontcg.io/v2';

// Optional API key from environment — significantly raises rate limits
const API_KEY = process.env.POKEMON_TCG_API_KEY || null;

// USD → ZAR fallback rate (used if the live rate fetch fails)
const FALLBACK_USD_TO_ZAR = 18.5;

// Build common headers
function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (API_KEY) h['X-Api-Key'] = API_KEY;
  return h;
}

/**
 * Search cards on pokemontcg.io
 * @param {object} opts
 * @param {string} [opts.query]     – free-text (name, set, etc.)
 * @param {string} [opts.setCode]   – e.g. "sv4"
 * @param {number} [opts.page=1]
 * @param {number} [opts.pageSize=20]
 * @returns {Promise<{cards: Array, totalCount: number, page: number, pageSize: number}>}
 */
export async function searchCards({ query, setCode, rarity, supertype, page = 1, pageSize = 20 } = {}) {
  const parts = [];

  if (query) {
    // Search across name — pokemontcg.io uses Lucene-style query syntax
    parts.push(`name:"*${query}*"`);
  }
  if (setCode) {
    parts.push(`set.id:${setCode}`);
  }
  if (rarity) {
    parts.push(`rarity:"${rarity}"`);
  }
  if (supertype) {
    parts.push(`supertype:${supertype}`);
  }

  const q = parts.length ? `q=${encodeURIComponent(parts.join(' '))}` : '';
  const params = [q, `page=${page}`, `pageSize=${pageSize}`, `orderBy=-set.releaseDate`].filter(Boolean).join('&');
  const url = `${POKEMON_TCG_BASE}/cards?${params}`;

  const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(15000) });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`pokemontcg.io API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();

  return {
    cards: (json.data || []).map(normalizeCard),
    totalCount: json.totalCount || 0,
    page: json.page || page,
    pageSize: json.pageSize || pageSize,
  };
}

/**
 * Fetch a single card by its pokemontcg.io ID (e.g. "sv4-25")
 */
export async function getCardById(pokemonTcgId) {
  const url = `${POKEMON_TCG_BASE}/cards/${encodeURIComponent(pokemonTcgId)}`;
  const res = await fetch(url, { headers: headers() });

  if (!res.ok) {
    if (res.status === 404) return null;
    const text = await res.text();
    throw new Error(`pokemontcg.io API error ${res.status}: ${text}`);
  }

  const json = await res.json();
  return normalizeCard(json.data);
}

/**
 * Fetch all cards in a given set (paged internally).
 */
export async function getCardsBySet(setCode, { page = 1, pageSize = 50 } = {}) {
  return searchCards({ setCode, page, pageSize });
}

/**
 * Fetch sets list from pokemontcg.io
 */
export async function getSets({ query, page = 1, pageSize = 50 } = {}) {
  let q = '';
  if (query) {
    q = `q=${encodeURIComponent(`name:"*${query}*"`)}`;
  }

  const params = [q, `page=${page}`, `pageSize=${pageSize}`, `orderBy=-releaseDate`].filter(Boolean).join('&');
  const url = `${POKEMON_TCG_BASE}/sets?${params}`;
  const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(15000) });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`pokemontcg.io API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  return {
    sets: (json.data || []).map(s => ({
      id: s.id,
      name: s.name,
      series: s.series,
      total: s.total,
      releaseDate: s.releaseDate,
      logo: s.images?.logo,
      symbol: s.images?.symbol,
    })),
    totalCount: json.totalCount || 0,
    page,
    pageSize,
  };
}

/**
 * Normalize a raw pokemontcg.io card object into the shape we store/return.
 */
function normalizeCard(raw) {
  const tcgplayer = raw.tcgplayer?.prices || {};

  // Pick the best available price variant (prefer holofoil, then normal, then any first key)
  const priceVariants = Object.keys(tcgplayer);
  const preferredVariant =
    priceVariants.find(v => v === 'holofoil') ||
    priceVariants.find(v => v === 'reverseHolofoil') ||
    priceVariants.find(v => v === 'normal') ||
    priceVariants[0] || null;

  const prices = preferredVariant ? tcgplayer[preferredVariant] : {};

  return {
    pokemon_tcg_id: raw.id,
    card_name: raw.name,
    set_name: raw.set?.name || null,
    set_code: raw.set?.id || null,
    card_number: raw.number || null,
    supertype: raw.supertype || null,
    rarity: raw.rarity || null,
    card_image_small: raw.images?.small || null,
    card_image_large: raw.images?.large || null,
    hp: raw.hp || null,
    types: raw.types || [],
    artist: raw.artist || null,
    // All price variants for display
    price_variants: priceVariants,
    // Best-available prices
    price_market: prices.market ?? null,
    price_low: prices.low ?? null,
    price_mid: prices.mid ?? null,
    price_high: prices.high ?? null,
    // All variants' prices for full breakdown
    all_prices: tcgplayer,
    // TCGplayer update date
    tcgplayer_url: raw.tcgplayer?.url || null,
    tcgplayer_updated_at: raw.tcgplayer?.updatedAt || null,
  };
}

/**
 * Fetch a live USD → ZAR exchange rate.
 * Falls back to a hard-coded rate if the fetch fails.
 */
export async function getUsdToZarRate() {
  try {
    // Free, no-key API for currency conversion
    const res = await fetch('https://open.er-api.com/v6/latest/USD', {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const json = await res.json();
      return json.rates?.ZAR || FALLBACK_USD_TO_ZAR;
    }
  } catch {
    // Silently fall back
  }
  return FALLBACK_USD_TO_ZAR;
}

/**
 * Convert USD price to ZAR
 */
export function usdToZar(usdAmount, rate) {
  if (usdAmount == null || rate == null) return null;
  return Math.round(usdAmount * rate * 100) / 100;
}

export default {
  searchCards,
  getCardById,
  getCardsBySet,
  getSets,
  getUsdToZarRate,
  usdToZar,
};
