/**
 * Pack Opening Routes — /api/packs
 *
 * Provably fair system — but instead of generating random cards,
 * we use the provably fair roll to SELECT which real pack the user gets
 * from the available inventory. The cards inside are real cards from
 * packs physically opened by admin on camera.
 */

import crypto from 'crypto';
import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { optionalCustomerAuth, authenticateCustomer, requirePageAccess } from '../middleware/auth.js';
import {
  generateServerSeed,
  hashServerSeed,
  generateClientSeed,
  generateTimeNonce,
  generateRoll,
} from '../utils/provablyFair.js';

const router = Router();

// ── Rarity display order (for sorting cards — best last) ─────────────────────
const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, ultra_rare: 3 };

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
 * GET /api/packs/availability — Public: available pack counts per set
 */
router.get('/availability', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('opened_packs')
      .select('set_id')
      .eq('status', 'available');

    if (error) throw error;

    const counts = {};
    (data || []).forEach(p => {
      counts[p.set_id] = (counts[p.set_id] || 0) + 1;
    });

    res.json(counts);
  } catch (err) {
    console.error('[Packs] availability error:', err);
    res.status(500).json({ error: 'Failed to fetch availability' });
  }
});

/**
 * POST /api/packs/open — Open a pack (provably fair pack selection)
 *
 * Instead of generating random cards, this picks a random REAL pack
 * from the available inventory using the provably fair system.
 * The user gets the exact cards from that physically opened pack.
 */
router.post('/open', authenticateCustomer, requirePageAccess('/elite-rips'), async (req, res) => {
  try {
    const { setId } = req.body;
    if (!setId) return res.status(400).json({ error: 'setId is required' });

    // Get all available packs for this set
    const { data: availablePacks, error: fetchErr } = await supabaseAdmin
      .from('opened_packs')
      .select('id')
      .eq('set_id', setId)
      .eq('status', 'available');

    if (fetchErr) throw fetchErr;

    if (!availablePacks || availablePacks.length === 0) {
      return res.status(404).json({ error: 'No packs available for this set. Check back later!' });
    }

    // Provably fair roll to select which pack
    const session = getOrCreateSession(req);
    const timeNonce = generateTimeNonce();
    const nonce = `${timeNonce}:${session.nonce}`;
    session.nonce++;

    const roll = generateRoll(session.serverSeed, session.clientSeed, nonce);
    const packIndex = Math.floor(roll * availablePacks.length);
    const selectedPackId = availablePacks[Math.min(packIndex, availablePacks.length - 1)].id;

    // Mark pack as sold and assign to user (atomic via match)
    const { data: updatedPack, error: updateErr } = await supabaseAdmin
      .from('opened_packs')
      .update({
        status: 'sold',
        assigned_to: req.customer.id,
        assigned_at: new Date().toISOString(),
      })
      .eq('id', selectedPackId)
      .eq('status', 'available') // optimistic lock — only if still available
      .select('*, pack_cards(*)')
      .single();

    if (updateErr || !updatedPack) {
      // Race condition: pack was grabbed by someone else, try again with remaining
      console.warn('[Packs] Pack race condition, retrying...');
      // Recursive retry (limited by available packs shrinking)
      return res.status(409).json({ error: 'Pack was just claimed. Please try again.' });
    }

    // Sort cards by sort_order (rarity-based, best last)
    const cards = (updatedPack.pack_cards || [])
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(c => ({
        id: c.id,
        name: c.card_name,
        image: c.image_url,
        imageLarge: c.image_url,
        rarity: c.rarity,
        number: c.card_number,
        priceZar: Number(c.price_zar) || 0,
      }));

    console.log(`[Packs] User ${req.customer.email} opened pack ${updatedPack.pack_number} from ${setId}: ${cards.map(c => `${c.name} (${c.rarity}) R${c.priceZar}`).join(', ')}`);

    res.json({
      cards,
      packNumber: updatedPack.pack_number,
      videoUrl: updatedPack.video_url,
      fairness: {
        serverSeedHash: session.serverSeedHash,
        clientSeed: session.clientSeed,
        nonce,
        packIndex,
        totalAvailable: availablePacks.length,
      },
    });
  } catch (err) {
    console.error('[Packs] open error:', err);
    res.status(500).json({ error: 'Failed to open pack' });
  }
});

router.post('/verify', (req, res) => {
  const { serverSeed, clientSeed, nonce } = req.body;
  if (!serverSeed || !clientSeed || nonce == null) {
    return res.status(400).json({ error: 'serverSeed, clientSeed, and nonce are required' });
  }
  const roll = generateRoll(serverSeed, clientSeed, nonce);
  res.json({
    roll,
    serverSeedHash: hashServerSeed(serverSeed),
  });
});

export default router;
