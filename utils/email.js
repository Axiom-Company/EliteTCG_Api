const ZEPTOMAIL_URL = 'https://api.zeptomail.com/v1.1/email';

const apiKey = process.env.ZEPTOMAIL_API_KEY || '';
const fromEmail = process.env.ZEPTOMAIL_FROM_EMAIL || 'admin@elitetcg.co.za';
const fromName = process.env.ZEPTOMAIL_FROM_NAME || 'Elite TCG';

const footer = `<hr style="border:none;border-top:1px solid #eee;margin:20px 0"><p style="color:#888;font-size:12px">Elite TCG — <a href="https://www.elitetcg.co.za">www.elitetcg.co.za</a></p>`;
const wrap = (body) => `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">${body}${footer}</div>`;
const btn = (href, text) => `<a href="${href}" style="display:inline-block;padding:10px 24px;background:#1a1a2e;color:#fff;text-decoration:none;border-radius:6px">${text}</a>`;

async function sendEmail(toEmail, toName, subject, htmlBody) {
  if (!apiKey) {
    console.warn('[EMAIL] ZEPTOMAIL_API_KEY not set, skipping email to', toEmail);
    return;
  }

  try {
    const resp = await fetch(ZEPTOMAIL_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Zoho-enczapikey ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        from: { address: fromEmail, name: fromName },
        to: toEmail.includes(',')
        ? toEmail.split(',').map(e => ({ email_address: { address: e.trim(), name: toName || '' } }))
        : [{ email_address: { address: toEmail, name: toName || '' } }],
        subject,
        htmlbody: htmlBody,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`[EMAIL] ZeptoMail error ${resp.status}:`, text);
      return;
    }

    console.log(`[EMAIL] Sent '${subject}' to ${toEmail}`);
  } catch (err) {
    console.error(`[EMAIL] Failed '${subject}' to ${toEmail}:`, err.message);
  }
}

// ── Buyer emails ──

export async function sendOrderConfirmation(toEmail, toName, orderNumber, totalZar, items = []) {
  const itemRows = items.map(i =>
    `<tr><td style="padding:8px;border-bottom:1px solid #eee">${i.product_name || i.name}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${i.quantity}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right">R${(i.unit_price || i.unit_price_zar || 0).toFixed(2)}</td></tr>`
  ).join('');

  const html = wrap(`
    <h2 style="color:#1a1a2e">Order Confirmed — ${orderNumber}</h2>
    <p>Thank you for your order from Elite TCG!</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0">
      <thead><tr style="background:#f5f5f5"><th style="padding:8px;text-align:left">Item</th><th style="padding:8px;text-align:center">Qty</th><th style="padding:8px;text-align:right">Price</th></tr></thead>
      <tbody>${itemRows}</tbody>
    </table>
    <p style="font-size:18px;font-weight:bold">Total: R${totalZar.toFixed(2)}</p>
    <p>We'll notify you when your order ships.</p>`);

  await sendEmail(toEmail, toName, `Order Confirmed — ${orderNumber}`, html);
}

export async function sendShippingNotification(toEmail, toName, orderNumber, trackingNumber) {
  const trackingUrl = `https://www.thecourierguy.co.za/tracking?waybill=${trackingNumber}`;
  const html = wrap(`
    <h2 style="color:#1a1a2e">Your Order Has Shipped — ${orderNumber}</h2>
    <p>Great news! Your order is on its way.</p>
    <p><strong>Tracking Number:</strong> ${trackingNumber}</p>
    <p>${btn(trackingUrl, 'Track Your Parcel')}</p>`);

  await sendEmail(toEmail, toName, `Your Order Has Shipped — ${orderNumber}`, html);
}

export async function sendOrderCancelled(toEmail, toName, orderNumber) {
  const html = wrap(`
    <h2 style="color:#1a1a2e">Order Cancelled — ${orderNumber}</h2>
    <p>Your order has been cancelled and your payment will be refunded.</p>
    <p>If you didn't request this, please contact us.</p>`);

  await sendEmail(toEmail, toName, `Order Cancelled — ${orderNumber}`, html);
}

// ── Admin notification ──

export async function sendNewOrderNotification(orderNumber, customerName, totalZar, itemCount) {
  const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL || process.env.ZEPTOMAIL_FROM_EMAIL || 'admin@elitetcg.co.za';
  const html = wrap(`
    <h2 style="color:#1a1a2e">New Order Received — ${orderNumber}</h2>
    <table style="border-collapse:collapse;margin:16px 0">
      <tr><td style="padding:6px 12px;color:#888">Customer</td><td style="padding:6px 12px;font-weight:bold">${customerName || 'Guest'}</td></tr>
      <tr><td style="padding:6px 12px;color:#888">Items</td><td style="padding:6px 12px">${itemCount}</td></tr>
      <tr><td style="padding:6px 12px;color:#888">Total</td><td style="padding:6px 12px;font-weight:bold;color:#16a34a">R${totalZar.toFixed(2)}</td></tr>
    </table>
    <p>Log in to the admin dashboard to pack and ship this order.</p>
    <p>${btn('https://www.elitetcg.co.za/admin/orders', 'View Orders')}</p>`);

  await sendEmail(adminEmail, 'Elite TCG Admin', `New Order — ${orderNumber} (R${totalZar.toFixed(2)})`, html);
}

// ── Seller emails ──

export async function sendSellerSaleNotification(toEmail, sellerName, orderNumber, listingTitle, quantity, sellerAmount) {
  const html = wrap(`
    <h2 style="color:#1a1a2e">You Made a Sale!</h2>
    <p>Hi ${sellerName},</p>
    <p>Your listing <strong>${listingTitle}</strong> just sold.</p>
    <table style="border-collapse:collapse;margin:16px 0">
      <tr><td style="padding:6px 12px;color:#888">Order</td><td style="padding:6px 12px;font-weight:bold">${orderNumber}</td></tr>
      <tr><td style="padding:6px 12px;color:#888">Quantity</td><td style="padding:6px 12px">${quantity}</td></tr>
      <tr><td style="padding:6px 12px;color:#888">Your Payout</td><td style="padding:6px 12px;font-weight:bold;color:#16a34a">R${sellerAmount.toFixed(2)}</td></tr>
    </table>
    <p>Please prepare the item for shipping. You can manage your orders from the seller dashboard.</p>
    <p>${btn('https://www.elitetcg.co.za/seller/orders', 'View Orders')}</p>`);

  await sendEmail(toEmail, sellerName, `You Made a Sale — ${orderNumber}`, html);
}

export async function sendSellerPayoutNotification(toEmail, sellerName, orderNumber, payoutAmount) {
  const html = wrap(`
    <h2 style="color:#1a1a2e">Payout Pending — ${orderNumber}</h2>
    <p>Hi ${sellerName},</p>
    <p>A payout of <strong style="color:#16a34a">R${payoutAmount.toFixed(2)}</strong> has been created for order <strong>${orderNumber}</strong>.</p>
    <p>Your payout will be processed once the buyer confirms delivery.</p>`);

  await sendEmail(toEmail, sellerName, `Payout Pending — R${payoutAmount.toFixed(2)}`, html);
}

export async function sendDeliveryConfirmedToSeller(toEmail, sellerName, orderNumber) {
  const html = wrap(`
    <h2 style="color:#1a1a2e">Delivery Confirmed — ${orderNumber}</h2>
    <p>Hi ${sellerName},</p>
    <p>The buyer has confirmed delivery for order <strong>${orderNumber}</strong>.</p>
    <p>Your payout will be processed shortly.</p>`);

  await sendEmail(toEmail, sellerName, `Delivery Confirmed — ${orderNumber}`, html);
}

// ── Seller application emails ──

export async function sendSellerApplicationApproved(toEmail, displayName) {
  const html = wrap(`
    <h2 style="color:#1a1a2e">Congratulations, ${displayName}!</h2>
    <p>Your seller application has been <strong style="color:#16a34a">approved</strong>.</p>
    <p>You can now list your cards on the Elite TCG Marketplace and start selling.</p>
    <p>${btn('https://www.elitetcg.co.za/seller/listings/new', 'Create Your First Listing')}</p>`);

  await sendEmail(toEmail, displayName, 'Seller Application Approved — Elite TCG', html);
}

export async function sendSellerApplicationRejected(toEmail, displayName, reason) {
  const html = wrap(`
    <h2 style="color:#1a1a2e">Seller Application Update</h2>
    <p>Hi ${displayName},</p>
    <p>Unfortunately, your seller application was not approved at this time.</p>
    <p><strong>Reason:</strong> ${reason}</p>
    <p>You're welcome to reapply once you've addressed the above.</p>`);

  await sendEmail(toEmail, displayName, 'Seller Application Update — Elite TCG', html);
}

// ── Promotion emails ──

export async function sendPromotionConfirmation(toEmail, sellerName, listingTitle, tier, expiresAt) {
  const expDate = new Date(expiresAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
  const html = wrap(`
    <h2 style="color:#1a1a2e">Promotion Active — ${tier.charAt(0).toUpperCase() + tier.slice(1)}</h2>
    <p>Hi ${sellerName},</p>
    <p>Your <strong>${tier}</strong> promotion for <strong>${listingTitle}</strong> is now active.</p>
    <p>Your listing will receive boosted visibility until <strong>${expDate}</strong>.</p>
    <p>${btn('https://www.elitetcg.co.za/seller/promotions', 'View Promotions')}</p>`);

  await sendEmail(toEmail, sellerName, `Promotion Active — ${listingTitle}`, html);
}

// ── Subscription emails ──

export async function sendSubscriptionConfirmation(toEmail, toName, subscriptionNumber, tierName, monthlyAmount) {
  const html = wrap(`
    <h2 style="color:#1a1a2e">Welcome to Elite TCG Subscriptions!</h2>
    <p>Hi ${toName || 'Trainer'},</p>
    <p>Your <strong>${tierName}</strong> subscription is now active.</p>
    <table style="border-collapse:collapse;margin:16px 0">
      <tr><td style="padding:6px 12px;color:#888">Subscription</td><td style="padding:6px 12px;font-weight:bold">${subscriptionNumber}</td></tr>
      <tr><td style="padding:6px 12px;color:#888">Plan</td><td style="padding:6px 12px">${tierName}</td></tr>
      <tr><td style="padding:6px 12px;color:#888">Monthly</td><td style="padding:6px 12px;font-weight:bold;color:#16a34a">R${parseFloat(monthlyAmount).toFixed(2)}</td></tr>
    </table>
    <p>Your first box is being prepared and will ship soon. You'll receive a tracking email when it's on its way!</p>
    <p>${btn('https://www.elitetcg.co.za/subscriptions/my', 'Manage Subscription')}</p>`);

  await sendEmail(toEmail, toName, `Subscription Active — ${tierName}`, html);
}

export async function sendSubscriptionCancelled(toEmail, toName, subscriptionNumber, expiresAt) {
  const expDate = expiresAt
    ? new Date(expiresAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'the end of your current billing period';
  const html = wrap(`
    <h2 style="color:#1a1a2e">Subscription Cancelled — ${subscriptionNumber}</h2>
    <p>Hi ${toName || 'Trainer'},</p>
    <p>Your subscription <strong>${subscriptionNumber}</strong> has been cancelled.</p>
    <p>You'll still receive your box for the current period (until <strong>${expDate}</strong>).</p>
    <p>We'd love to have you back! You can resubscribe any time from our website.</p>
    <p>${btn('https://www.elitetcg.co.za/subscriptions', 'View Subscription Plans')}</p>`);

  await sendEmail(toEmail, toName, `Subscription Cancelled — ${subscriptionNumber}`, html);
}

export async function sendSubscriptionBoxShipped(toEmail, toName, boxNumber, trackingNumber) {
  const trackingSection = trackingNumber
    ? `<p><strong>Tracking Number:</strong> ${trackingNumber}</p>
       <p>${btn(`https://www.thecourierguy.co.za/tracking?waybill=${trackingNumber}`, 'Track Your Box')}</p>`
    : '<p>Tracking info will be available soon.</p>';

  const html = wrap(`
    <h2 style="color:#1a1a2e">Your Subscription Box Has Shipped!</h2>
    <p>Hi ${toName || 'Trainer'},</p>
    <p>Great news! Your subscription box <strong>${boxNumber}</strong> is on its way to you.</p>
    ${trackingSection}
    <p>Can't wait for you to open it!</p>`);

  await sendEmail(toEmail, toName, `Your Box Has Shipped — ${boxNumber}`, html);
}

export async function sendSubscriptionRenewalReminder(toEmail, toName, tierName, nextBillingDate, monthlyAmount) {
  const billingDate = new Date(nextBillingDate).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
  const html = wrap(`
    <h2 style="color:#1a1a2e">Subscription Renewal Reminder</h2>
    <p>Hi ${toName || 'Trainer'},</p>
    <p>Your <strong>${tierName}</strong> subscription will renew on <strong>${billingDate}</strong> for <strong>R${parseFloat(monthlyAmount).toFixed(2)}</strong>.</p>
    <p>Your next box is being curated with care!</p>
    <p>${btn('https://www.elitetcg.co.za/subscriptions/my', 'Manage Subscription')}</p>`);

  await sendEmail(toEmail, toName, `Renewal Reminder — ${tierName}`, html);
}

export async function sendSubscriptionPaymentFailed(toEmail, toName, subscriptionNumber, tierName) {
  const html = wrap(`
    <h2 style="color:#c41e3a">Payment Failed — ${subscriptionNumber}</h2>
    <p>Hi ${toName || 'Trainer'},</p>
    <p>We were unable to process your payment for the <strong>${tierName}</strong> subscription.</p>
    <p>Please update your payment method to continue receiving your monthly box.</p>
    <p>${btn('https://www.elitetcg.co.za/subscriptions/my', 'Update Payment')}</p>`);

  await sendEmail(toEmail, toName, `Payment Failed — ${subscriptionNumber}`, html);
}

export default {
  sendEmail,
  sendOrderConfirmation,
  sendNewOrderNotification,
  sendShippingNotification,
  sendOrderCancelled,
  sendSellerSaleNotification,
  sendSellerPayoutNotification,
  sendDeliveryConfirmedToSeller,
  sendSellerApplicationApproved,
  sendSellerApplicationRejected,
  sendPromotionConfirmation,
  sendSubscriptionConfirmation,
  sendSubscriptionCancelled,
  sendSubscriptionBoxShipped,
  sendSubscriptionRenewalReminder,
  sendSubscriptionPaymentFailed,
};
