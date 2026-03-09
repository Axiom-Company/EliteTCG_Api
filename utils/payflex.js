/**
 * Payflex (Pay-in-4) client for Node.js
 * Ported from CourierGuy_Payfast Python implementation
 */

const SANDBOX_CONFIG = {
  auth_url: 'https://auth.sandbox.payflex.co.za/auth/merchant',
  api_url: 'https://api.sandbox.payflex.co.za',
  audience: 'https://auth-sandbox.payflex.co.za',
};

const PRODUCTION_CONFIG = {
  auth_url: 'https://auth.payflex.co.za/auth/merchant',
  api_url: 'https://api.payflex.co.za',
  audience: 'https://auth.payflex.co.za',
};

class PayflexClient {
  constructor() {
    this.clientId = process.env.PAYFLEX_CLIENT_ID || '';
    this.clientSecret = process.env.PAYFLEX_CLIENT_SECRET || '';
    this.sandbox = (process.env.PAYFLEX_SANDBOX || 'true') === 'true';

    const config = this.sandbox ? SANDBOX_CONFIG : PRODUCTION_CONFIG;
    this.authUrl = config.auth_url;
    this.apiUrl = config.api_url;
    this.audience = config.audience;

    // Token cache
    this._token = null;
    this._tokenExpiresAt = 0;

    // Circuit breaker
    this._failures = 0;
    this._circuitOpenUntil = 0;
    this._maxFailures = 3;
    this._recoveryMs = 300_000; // 5 minutes
  }

  get isConfigured() {
    return !!(this.clientId && this.clientSecret);
  }

  get _isCircuitOpen() {
    if (this._failures < this._maxFailures) return false;
    if (Date.now() > this._circuitOpenUntil) {
      this._failures = 0;
      return false;
    }
    return true;
  }

  _recordSuccess() {
    this._failures = 0;
  }

  _recordFailure() {
    this._failures++;
    if (this._failures >= this._maxFailures) {
      this._circuitOpenUntil = Date.now() + this._recoveryMs;
      console.warn('[Payflex] Circuit breaker OPEN — too many failures');
    }
  }

  async _getToken() {
    // Return cached token if still valid (60s buffer)
    if (this._token && Date.now() < this._tokenExpiresAt - 60_000) {
      return this._token;
    }

    const res = await fetch(this.authUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        audience: this.audience,
        grant_type: 'client_credentials',
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Payflex auth failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    this._token = data.access_token;
    this._tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    return this._token;
  }

  async _request(method, path, body = null) {
    if (this._isCircuitOpen) {
      throw new Error('Payflex unavailable — circuit breaker open');
    }

    const token = await this._getToken();
    const url = `${this.apiUrl}${path}`;

    const opts = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    };
    if (body) opts.body = JSON.stringify(body);

    // Retry up to 3 times with exponential backoff for 5xx
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, opts);

        if (res.ok) {
          this._recordSuccess();
          return res.json();
        }

        const text = await res.text();

        if (res.status >= 500 && attempt < 2) {
          const delay = Math.pow(2, attempt) * 500;
          console.warn(`[Payflex] ${res.status} on ${method} ${path}, retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        lastError = new Error(`Payflex API error (${res.status}): ${text}`);
        lastError.status = res.status;
        break;
      } catch (err) {
        lastError = err;
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 500));
          continue;
        }
      }
    }

    this._recordFailure();
    throw lastError;
  }

  /**
   * Get Payflex configuration (min/max order amounts)
   */
  async getConfiguration() {
    return this._request('GET', '/configuration');
  }

  /**
   * Create a Payflex order — returns { token, redirectUrl, orderId, expiryDateTime }
   */
  async createOrder({ order, customer, callbackUrl, redirectUrl }) {
    const items = (order.items || []).map(item => ({
      description: item.product_name || item.name,
      name: item.product_name || item.name,
      sku: item.product_id || 'ITEM',
      quantity: item.quantity,
      price: {
        amount: parseFloat((item.unit_price || item.unit_price_zar || 0).toFixed(2)),
        currency: 'ZAR',
      },
    }));

    const totalAmount = parseFloat((order.total_amount || 0).toFixed(2));
    const shippingAmount = parseFloat((order.shipping_amount || 0).toFixed(2));

    const payload = {
      amount: {
        amount: totalAmount,
        currency: 'ZAR',
      },
      consumer: {
        phoneNumber: customer.phone || '',
        givenNames: customer.first_name || customer.full_name?.split(' ')[0] || '',
        surname: customer.last_name || customer.full_name?.split(' ').slice(1).join(' ') || '',
        email: customer.email,
      },
      merchant: {
        redirectConfirmUrl: redirectUrl,
        redirectCancelUrl: redirectUrl,
        statusCallbackUrl: callbackUrl,
      },
      merchantReference: order.order_number || order.id,
      taxAmount: { amount: 0, currency: 'ZAR' },
      shipping: {
        amount: shippingAmount,
        currency: 'ZAR',
      },
      items,
      description: `Elite TCG Order ${order.order_number}`,
    };

    return this._request('POST', '/order', payload);
  }

  /**
   * Get order status from Payflex
   */
  async getOrder(orderId) {
    return this._request('GET', `/order/${orderId}`);
  }

  /**
   * Process a refund
   */
  async refund(orderId, amount) {
    return this._request('POST', `/order/${orderId}/refund`, {
      amount: { amount: parseFloat(amount.toFixed(2)), currency: 'ZAR' },
    });
  }
}

// Singleton
const payflex = new PayflexClient();
export default payflex;
