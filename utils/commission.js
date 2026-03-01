/**
 * Calculate marketplace commission based on tiered structure.
 * All amounts in ZAR (Rands), NOT cents.
 *
 * Tiers:
 *   Under R10:        0%
 *   R10 – R50:        8%
 *   R51 – R100:       7.5%
 *   R101 – R1,000:    6%
 *   R1,001 – R5,000:  5%
 *   R5,000+:          4%
 *
 * @param {number} price - Item price in ZAR (e.g. 150.00)
 * @returns {{ fee: number, percentage: number, description: string, seller_receives: number }}
 */
export function calculateCommission(price) {
  if (price < 10) {
    return { fee: 0, percentage: 0, description: '0% (under R10)', seller_receives: parseFloat(price.toFixed(2)) };
  }
  if (price <= 50) {
    const fee = parseFloat((price * 0.08).toFixed(2));
    return { fee, percentage: 8, description: '8% (R10–R50)', seller_receives: parseFloat((price - fee).toFixed(2)) };
  }
  if (price <= 100) {
    const fee = parseFloat((price * 0.075).toFixed(2));
    return { fee, percentage: 7.5, description: '7.5% (R51–R100)', seller_receives: parseFloat((price - fee).toFixed(2)) };
  }
  if (price <= 1000) {
    const fee = parseFloat((price * 0.06).toFixed(2));
    return { fee, percentage: 6, description: '6% (R101–R1,000)', seller_receives: parseFloat((price - fee).toFixed(2)) };
  }
  if (price <= 5000) {
    const fee = parseFloat((price * 0.05).toFixed(2));
    return { fee, percentage: 5, description: '5% (R1,001–R5,000)', seller_receives: parseFloat((price - fee).toFixed(2)) };
  }
  const fee = parseFloat((price * 0.04).toFixed(2));
  return { fee, percentage: 4, description: '4% (R5,000+)', seller_receives: parseFloat((price - fee).toFixed(2)) };
}

export default calculateCommission;
