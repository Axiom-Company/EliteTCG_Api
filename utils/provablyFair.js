/**
 * Provably Fair RNG System
 *
 * Uses HMAC-SHA512 with server seed, client seed, and nonce
 * to generate verifiable random outcomes for pack openings.
 *
 * Flow:
 * 1. Server generates a random server_seed and stores its SHA-256 hash
 * 2. Client provides a client_seed (or gets a default)
 * 3. On each roll: HMAC-SHA512(server_seed, `${client_seed}:${nonce}`)
 * 4. First 8 hex chars → decimal → divide by 0xFFFFFFFF → float [0,1)
 * 5. Float maps to weighted rarity tiers → specific card
 * 6. After seed rotation, unhashed server_seed is revealed for verification
 */

import crypto from 'crypto';

/**
 * Generate a cryptographically random server seed (64 hex chars)
 */
export function generateServerSeed() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hash a server seed with SHA-256 (shown to user before any rolls)
 */
export function hashServerSeed(serverSeed) {
  return crypto.createHash('sha256').update(serverSeed).digest('hex');
}

/**
 * Generate a default client seed (16 hex chars)
 */
export function generateClientSeed() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Generate a time-based nonce in SSMMHHDDMMYYYY format
 * (seconds, minutes, hours, day, month, year)
 */
export function generateTimeNonce() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getSeconds())}${pad(d.getMinutes())}${pad(d.getHours())}${pad(d.getDate())}${pad(d.getMonth() + 1)}${d.getFullYear()}`;
}

/**
 * Core: produce a float [0, 1) from server_seed + client_seed + nonce
 */
export function generateRoll(serverSeed, clientSeed, nonce) {
  const message = `${clientSeed}:${nonce}`;
  const hmac = crypto.createHmac('sha512', serverSeed).update(message).digest('hex');
  // Take first 8 hex characters → 32-bit integer → normalize to [0, 1)
  const int = parseInt(hmac.substring(0, 8), 16);
  return int / 0x100000000; // 2^32
}

/**
 * Generate multiple rolls for a pack (one per card slot).
 * Uses time-based nonce with sub-index per card.
 */
export function generatePackRolls(serverSeed, clientSeed, nonce, count) {
  const rolls = [];
  for (let i = 0; i < count; i++) {
    // Each card uses: clientSeed:nonce:slotIndex
    const subMessage = `${clientSeed}:${nonce}:${i}`;
    const hmac = crypto.createHmac('sha512', serverSeed).update(subMessage).digest('hex');
    const int = parseInt(hmac.substring(0, 8), 16);
    rolls.push(int / 0x100000000);
  }
  return rolls;
}

/**
 * Map a roll [0,1) to a rarity tier based on weighted probabilities
 * @param {number} roll - float in [0, 1)
 * @param {Array<{rarity: string, weight: number}>} weights
 * @returns {string} rarity name
 */
export function rollToRarity(roll, weights) {
  const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0);
  let cumulative = 0;
  for (const { rarity, weight } of weights) {
    cumulative += weight / totalWeight;
    if (roll < cumulative) return rarity;
  }
  return weights[weights.length - 1].rarity;
}

/**
 * Map a roll [0,1) to a specific card index within a filtered array
 */
export function rollToCardIndex(roll, cardCount) {
  return Math.floor(roll * cardCount);
}

/**
 * Verify a previous roll (user can run this client-side too)
 */
export function verifyRoll(serverSeed, clientSeed, nonce, cardIndex) {
  const subMessage = `${clientSeed}:${nonce}:${cardIndex}`;
  const hmac = crypto.createHmac('sha512', serverSeed).update(subMessage).digest('hex');
  const int = parseInt(hmac.substring(0, 8), 16);
  return {
    hmac,
    int,
    roll: int / 0x100000000,
  };
}

export default {
  generateServerSeed,
  hashServerSeed,
  generateClientSeed,
  generateRoll,
  generatePackRolls,
  rollToRarity,
  rollToCardIndex,
  verifyRoll,
};
