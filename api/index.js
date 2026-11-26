// Tap Payments demo checkout - one Vercel serverless function for every /api/* route.
// vercel.json rewrites /api/<path> -> /api/index?path=<path>.
// Keeps the SECRET key on the server; the browser only ever sees the PUBLIC key.
const TAP_API = 'https://api.tap.company/v2';
const TAP_SECRET_KEY = process.env.TAP_SECRET_KEY || '';
const TAP_PUBLIC_KEY = process.env.TAP_PUBLIC_KEY || '';
const TAP_MERCHANT_ID = process.env.TAP_MERCHANT_ID || '';
const CURRENCY = process.env.CURRENCY || 'EGP';

// Demo shopper. Tap needs a phone number to save cards.
const DEMO_CUSTOMER = {
  first_name: 'Test',
  last_name: 'Shopper',
  email: 'test.shopper@example.com',
  phone: { country_code: '965', number: '51234567' },
};

const PRODUCTS = [
  { id: 'p1', name: 'Wireless Headphones', price: 12.5, emoji: '🎧' },
  { id: 'p2', name: 'Smart Watch', price: 25, emoji: '⌚' },
  { id: 'p3', name: 'Coffee Mug', price: 3.75, emoji: '☕' },
];

const httpError = (status, message) => Object.assign(new Error(message), { status });

async function tap(method, url, body) {
  const res = await fetch(TAP_API + url, {
    method,
    headers: {
      Authorization: `Bearer ${TAP_SECRET_KEY}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok || data.errors) {
    const msg = (data.errors && data.errors.map(e => `${e.code}: ${e.description}`).join('; ')) || text;
    const err = httpError(res.status === 404 ? 404 : 502, `Tap ${method} ${url} failed (${res.status}): ${msg}`);
    err.tap = data;
    throw err;
  }
  return data;
}

// Each browser keeps its own Tap customer id (in localStorage) so its saved cards persist.
function requireCustomer(id) {
  if (!id || !/^cus_[A-Za-z0-9_]+$/.test(id)) throw httpError(400, 'customerId is required');
  return id;
}

async function getOrCreateCustomer(id) {
  if (process.env.TAP_CUSTOMER_ID) return process.env.TAP_CUSTOMER_ID;
  if (id && /^cus_[A-Za-z0-9_]+$/.test(id)) {
    try { return (await tap('GET', `/customers/${id}`)).id || id; } catch { /* fall through and create a new one */ }
  }
  return (await tap('POST', '/customers', DEMO_CUSTOMER)).id;
}

function summarizeCharge(c) {
  return {
    id: c.id,
    status: c.status,
    amount: c.amount,
    currency: c.currency,
    description: c.description,
    response: c.response,
    card: c.card ? { id: c.card.id, brand: c.card.brand, last_four: c.card.last_four } : null,
    save_card: c.save_card,
  };
}

function siteUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return process.env.BASE_URL || `${proto}://${host}`;
}

async function handle(req, path) {
  const q = req.query || {};
  const body = req.body || {};
  let m;

  if (req.method === 'GET' && path === 'config') {
    return {
      publicKey: TAP_PUBLIC_KEY,
      merchantId: TAP_MERCHANT_ID,
      currency: CURRENCY,
      customerId: await getOrCreateCustomer(q.customerId),
      customer: DEMO_CUSTOMER,
      products: PRODUCTS,
    };
  }

  if (req.method === 'GET' && path === 'cards') {
    const customerId = requireCustomer(q.customerId);
    let cards = [];
    try { cards = (await tap('GET', `/card/${customerId}`)).data || []; }
    catch (e) { if (e.status !== 404) throw e; } // 404 = no cards yet
    return cards.map(c => ({
      id: c.id, brand: c.brand, last4: c.last4 || c.last_four,
      exp_month: c.exp_month, exp_year: c.exp_year, name: c.name,
    }));
  }

  if (req.method === 'DELETE' && (m = path.match(/^cards\/(card_[A-Za-z0-9_]+)$/))) {
    const customerId = requireCustomer(q.customerId);
    return tap('DELETE', `/card/${customerId}/${m[1]}`);
  }

  // body: { productId, customerId, tokenId, saveCard } for a new card, or { productId, customerId, cardId } for a saved card
  if (req.method === 'POST' && path === 'pay') {
    const { productId, tokenId, cardId, saveCard } = body;
    const customerId = requireCustomer(body.customerId);
    const product = PRODUCTS.find(p => p.id === productId);
    if (!product) throw httpError(400, 'Unknown product');
    if (!tokenId && !cardId) throw httpError(400, 'tokenId or cardId required');

    // A saved card id can't be charged directly: create a one-time token from it first.
    let sourceId = tokenId;
    if (cardId) {
      const tok = await tap('POST', '/tokens', {
        saved_card: { card_id: cardId, customer_id: customerId },
        client_ip: (req.headers['x-forwarded-for'] || '127.0.0.1').split(',')[0].trim(),
      });
      sourceId = tok.id;
    }

    const base = siteUrl(req);
    const charge = await tap('POST', '/charges', {
      amount: product.price,
      currency: CURRENCY,
      threeDSecure: true,
      customer_initiated: true,
      save_card: Boolean(saveCard) && !cardId,
      description: product.name,
      reference: { transaction: 'txn_' + Date.now(), order: 'ord_' + Date.now() },
      metadata: { udf1: product.id },
      customer: { id: customerId },
      ...(TAP_MERCHANT_ID ? { merchant: { id: TAP_MERCHANT_ID } } : {}),
      source: { id: sourceId },
      redirect: { url: `${base}/result.html` },
      post: { url: `${base}/api/webhook` },
    });

    // INITIATED -> shopper completes 3DS on Tap's page, then returns to /result.html?tap_id=...
    if (charge.status === 'INITIATED' && charge.transaction && charge.transaction.url) {
      return { redirectUrl: charge.transaction.url, chargeId: charge.id };
    }
    return { charge: summarizeCharge(charge) };
  }

  if (req.method === 'GET' && (m = path.match(/^charges\/(chg_[A-Za-z0-9_]+)$/))) {
    return summarizeCharge(await tap('GET', `/charges/${m[1]}`));
  }

  if (req.method === 'POST' && path === 'webhook') {
    console.log('Tap webhook:', body.id, body.status);
    return { received: true };
  }

  throw httpError(404, 'Not found');
}

module.exports = async (req, res) => {
  const send = (code, obj) => {
    res.statusCode = code;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(obj));
  };
  const path = String((req.query && req.query.path) || '').replace(/^\/+|\/+$/g, '');
  if (!TAP_SECRET_KEY && path !== 'webhook') {
    return send(500, { error: 'TAP_SECRET_KEY is not set in the Vercel project settings.' });
  }
  try {
    send(200, await handle(req, path));
  } catch (e) {
    console.error(e.message);
    send(e.status || 500, { error: e.message, tap: e.tap });
  }
};
