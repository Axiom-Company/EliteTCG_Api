import crypto from 'crypto';

// PayFast configuration
const PAYFAST_CONFIG = {
  merchantId: process.env.PAYFAST_MERCHANT_ID || '',
  merchantKey: process.env.PAYFAST_MERCHANT_KEY || '',
  passphrase: process.env.PAYFAST_PASSPHRASE || '',
  sandbox: process.env.PAYFAST_SANDBOX === 'true',
  returnUrl: process.env.PAYFAST_RETURN_URL || 'https://www.elitetcg.co.za/marketplace/payment/success',
  cancelUrl: process.env.PAYFAST_CANCEL_URL || 'https://www.elitetcg.co.za/marketplace/payment/cancel',
  notifyUrl: process.env.PAYFAST_NOTIFY_URL || 'http://localhost:3001/api/payfast/notify'
};

// PayFast URLs
const PAYFAST_URL = PAYFAST_CONFIG.sandbox
  ? 'https://sandbox.payfast.co.za/eng/process'
  : 'https://www.payfast.co.za/eng/process';

const PAYFAST_VALIDATE_URL = PAYFAST_CONFIG.sandbox
  ? 'https://sandbox.payfast.co.za/eng/query/validate'
  : 'https://www.payfast.co.za/eng/query/validate';

// PayFast valid IP addresses (for ITN validation)
const PAYFAST_IPS = [
  '197.97.145.144',
  '197.97.145.145',
  '197.97.145.146',
  '197.97.145.147',
  '197.97.145.148',
  '41.74.179.194',
  '41.74.179.195',
  '41.74.179.196',
  '41.74.179.197',
  '41.74.179.198',
  '41.74.179.199',
  '41.74.179.200',
  '41.74.179.201',
  '41.74.179.202',
  '41.74.179.203',
  '41.74.179.204',
  '41.74.179.205',
  '41.74.179.206',
  '41.74.179.207',
  '41.74.179.208',
  '41.74.179.209',
  '41.74.179.210',
  '41.74.179.211',
  '127.0.0.1', // For local testing
  '::1' // IPv6 localhost
];

/**
 * Generate MD5 signature for PayFast
 */
function generateSignature(data, passphrase = null) {
  // Filter out empty values and sort alphabetically
  const params = Object.keys(data)
    .filter(key => data[key] !== '' && data[key] !== null && data[key] !== undefined)
    .sort()
    .map(key => `${key}=${encodeURIComponent(String(data[key])).replace(/%20/g, '+')}`)
    .join('&');

  // Add passphrase if provided
  const signatureString = passphrase ? `${params}&passphrase=${encodeURIComponent(passphrase)}` : params;

  return crypto.createHash('md5').update(signatureString).digest('hex');
}

/**
 * Verify PayFast signature
 */
function verifySignature(pfData, receivedSignature, passphrase = null) {
  // Create a copy without signature
  const data = { ...pfData };
  delete data.signature;

  const calculatedSignature = generateSignature(data, passphrase);
  return calculatedSignature === receivedSignature;
}

/**
 * Validate PayFast source IP
 */
function validateIP(ip) {
  // Extract IP from potential proxy headers
  const cleanIP = ip.replace('::ffff:', '');
  return PAYFAST_IPS.includes(cleanIP);
}

/**
 * Generate payment data for PayFast
 */
function generatePaymentData(order, buyer, listing, sellerPayfastEmail = null) {
  const data = {
    // Merchant details
    merchant_id: PAYFAST_CONFIG.merchantId,
    merchant_key: PAYFAST_CONFIG.merchantKey,

    // Return URLs
    return_url: PAYFAST_CONFIG.returnUrl,
    cancel_url: PAYFAST_CONFIG.cancelUrl,
    notify_url: PAYFAST_CONFIG.notifyUrl,

    // Buyer details
    name_first: buyer.first_name || buyer.name?.split(' ')[0] || 'Customer',
    name_last: buyer.last_name || buyer.name?.split(' ').slice(1).join(' ') || '',
    email_address: buyer.email,
    cell_number: buyer.phone?.replace(/\D/g, '') || '',

    // Transaction details
    m_payment_id: order.id,
    amount: order.total_amount.toFixed(2),
    item_name: listing.title.substring(0, 100), // Max 100 chars
    item_description: `Order #${order.order_number}`.substring(0, 255),

    // Custom data
    custom_str1: order.order_number,
    custom_str2: listing.id,
    custom_int1: order.quantity
  };

  // Add split payment if seller has PayFast email
  // Note: Split payments require PayFast business account
  if (sellerPayfastEmail) {
    // Platform keeps 10%, seller gets 90%
    // This is handled via PayFast Split Payments feature
    // For now, we'll process full payment and handle payouts manually
    data.custom_str3 = sellerPayfastEmail;
    data.custom_str4 = order.seller_amount.toFixed(2);
  }

  // Generate signature
  data.signature = generateSignature(data, PAYFAST_CONFIG.passphrase);

  return data;
}

/**
 * Build PayFast form HTML
 */
function buildPaymentForm(paymentData) {
  const inputs = Object.entries(paymentData)
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${value}" />`)
    .join('\n');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Redirecting to PayFast...</title>
    </head>
    <body>
      <form id="payfast-form" action="${PAYFAST_URL}" method="POST">
        ${inputs}
      </form>
      <script>document.getElementById('payfast-form').submit();</script>
    </body>
    </html>
  `;
}

/**
 * Build PayFast redirect URL
 */
function buildPaymentUrl(paymentData) {
  const params = new URLSearchParams();
  Object.entries(paymentData).forEach(([key, value]) => {
    params.append(key, value);
  });
  return `${PAYFAST_URL}?${params.toString()}`;
}

/**
 * Generate payment data for store orders (not marketplace)
 */
function generateStorePaymentData(order, buyer) {
  const storeReturnUrl = process.env.PAYFAST_STORE_RETURN_URL || 'https://www.elitetcg.co.za/payment/success';
  const storeCancelUrl = process.env.PAYFAST_STORE_CANCEL_URL || 'https://www.elitetcg.co.za/payment/cancel';
  const storeNotifyUrl = process.env.PAYFAST_STORE_NOTIFY_URL || 'http://localhost:3001/api/orders/notify';

  const data = {
    // Merchant details
    merchant_id: PAYFAST_CONFIG.merchantId,
    merchant_key: PAYFAST_CONFIG.merchantKey,

    // Return URLs (different from marketplace)
    return_url: storeReturnUrl,
    cancel_url: storeCancelUrl,
    notify_url: storeNotifyUrl,

    // Buyer details
    name_first: buyer.first_name || 'Customer',
    name_last: buyer.last_name || '',
    email_address: buyer.email,
    cell_number: buyer.phone?.replace(/\D/g, '') || '',

    // Transaction details
    m_payment_id: order.id,
    amount: order.total_amount.toFixed(2),
    item_name: `EliteTCG Order #${order.order_number}`.substring(0, 100),
    item_description: `${order.items?.length || 0} item(s)`.substring(0, 255),

    // Custom data
    custom_str1: order.order_number,
    custom_str2: 'store_order' // Distinguish from marketplace orders
  };

  // Generate signature
  data.signature = generateSignature(data, PAYFAST_CONFIG.passphrase);

  return data;
}

/**
 * Validate ITN (Instant Transaction Notification)
 */
async function validateITN(pfData, pfHost) {
  // Build validation string
  const params = Object.keys(pfData)
    .filter(key => key !== 'signature')
    .sort()
    .map(key => `${key}=${encodeURIComponent(pfData[key]).replace(/%20/g, '+')}`)
    .join('&');

  try {
    const response = await fetch(`${PAYFAST_VALIDATE_URL}?${params}`, {
      method: 'POST',
      headers: {
        'Host': pfHost
      }
    });

    const text = await response.text();
    return text === 'VALID';
  } catch (error) {
    console.error('ITN validation error:', error);
    return false;
  }
}

export const PayFast = {
  config: PAYFAST_CONFIG,
  url: PAYFAST_URL,
  generateSignature,
  verifySignature,
  validateIP,
  generatePaymentData,
  generateStorePaymentData,
  buildPaymentForm,
  buildPaymentUrl,
  validateITN
};

export default PayFast;
