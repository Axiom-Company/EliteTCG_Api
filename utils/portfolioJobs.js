/**
 * Portfolio Background Jobs
 *
 * 1. Daily snapshot — captures each user's portfolio total value once per day.
 * 2. Price refresh  — re-fetches market prices for cards whose cached price
 *    is older than a configurable threshold.
 *
 * Both are called from index.js via setInterval.
 */

import { supabaseAdmin } from '../config/supabase.js';
import { getCardById, getUsdToZarRate, usdToZar } from './pokemonTcgApi.js';

// -------------------------------------------------------------------
// Daily portfolio snapshot
// -------------------------------------------------------------------

/**
 * Create a daily value snapshot for every customer who has portfolio cards.
 * Intended to run once per day (e.g. every 24h via setInterval, or a cron).
 */
export async function createDailySnapshots() {
  if (!supabaseAdmin) return;

  const today = new Date().toISOString().split('T')[0]; // "YYYY-MM-DD"

  try {
    // Get all distinct customers who have portfolio cards
    const { data: customers, error: custErr } = await supabaseAdmin
      .from('portfolio_cards')
      .select('customer_id');

    if (custErr || !customers) {
      console.error('[Portfolio Snapshot] Failed to fetch customers:', custErr);
      return;
    }

    // Deduplicate customer IDs
    const customerIds = [...new Set(customers.map(c => c.customer_id))];

    if (customerIds.length === 0) return;

    const rate = await getUsdToZarRate();
    let snapshotsCreated = 0;

    for (const customerId of customerIds) {
      try {
        // Check if snapshot already exists for today
        const { data: existing } = await supabaseAdmin
          .from('portfolio_snapshots')
          .select('id')
          .eq('customer_id', customerId)
          .eq('snapshot_date', today)
          .single();

        if (existing) continue; // Already snapped today

        // Aggregate portfolio value
        const { data: cards } = await supabaseAdmin
          .from('portfolio_cards')
          .select('pokemon_tcg_id, quantity, latest_price_market')
          .eq('customer_id', customerId);

        if (!cards || cards.length === 0) continue;

        const uniqueCards = cards.length;
        const totalCards = cards.reduce((sum, c) => sum + c.quantity, 0);
        const totalValueUsd = cards.reduce(
          (sum, c) => sum + (c.latest_price_market || 0) * c.quantity, 0
        );
        const totalValueZar = usdToZar(totalValueUsd, rate) || 0;

        await supabaseAdmin
          .from('portfolio_snapshots')
          .insert({
            customer_id: customerId,
            snapshot_date: today,
            total_cards: totalCards,
            unique_cards: uniqueCards,
            total_value_usd: Math.round(totalValueUsd * 100) / 100,
            total_value_zar: Math.round(totalValueZar * 100) / 100,
            usd_to_zar_rate: rate,
          });

        snapshotsCreated++;
      } catch (err) {
        console.error(`[Portfolio Snapshot] Error for customer ${customerId}:`, err.message);
      }
    }

    if (snapshotsCreated > 0) {
      console.log(`[Portfolio Snapshot] Created ${snapshotsCreated} snapshot(s) for ${today}`);
    }
  } catch (err) {
    console.error('[Portfolio Snapshot] Job error:', err.message);
  }
}

// -------------------------------------------------------------------
// Stale price refresh
// -------------------------------------------------------------------

/**
 * Refresh market prices for portfolio cards whose cached price is older
 * than `maxAgeMs` (default: 6 hours).  Processes in batches to respect
 * pokemontcg.io rate limits.
 */
export async function refreshStalePrices({ maxAgeMs = 6 * 60 * 60 * 1000, batchSize = 30 } = {}) {
  if (!supabaseAdmin) return;

  try {
    const staleThreshold = new Date(Date.now() - maxAgeMs).toISOString();

    // Find cards with stale or missing prices
    const { data: staleCards, error } = await supabaseAdmin
      .from('portfolio_cards')
      .select('id, pokemon_tcg_id')
      .or(`price_updated_at.is.null,price_updated_at.lt.${staleThreshold}`)
      .limit(batchSize);

    if (error || !staleCards || staleCards.length === 0) return;

    const rate = await getUsdToZarRate();
    let refreshed = 0;

    // Deduplicate by pokemon_tcg_id to avoid redundant API calls
    const uniqueCardIds = [...new Set(staleCards.map(c => c.pokemon_tcg_id))];

    for (const pokemonTcgId of uniqueCardIds) {
      try {
        const apiCard = await getCardById(pokemonTcgId);
        if (!apiCard || apiCard.price_market == null) continue;

        const marketPriceZar = usdToZar(apiCard.price_market, rate);

        // Update all portfolio entries with this card ID
        await supabaseAdmin
          .from('portfolio_cards')
          .update({
            latest_price_market: apiCard.price_market,
            latest_price_market_zar: marketPriceZar,
            price_updated_at: new Date().toISOString(),
          })
          .eq('pokemon_tcg_id', pokemonTcgId);

        // Update price cache
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

        refreshed++;
      } catch {
        // Skip individual errors
      }
    }

    if (refreshed > 0) {
      console.log(`[Price Refresh] Updated prices for ${refreshed} unique card(s)`);
    }
  } catch (err) {
    console.error('[Price Refresh] Job error:', err.message);
  }
}

export default { createDailySnapshots, refreshStalePrices };
