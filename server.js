// Tap Payments demo checkout - zero-dependency Node server (Node 18+).
// Keeps the SECRET key on the server; the browser only ever sees the PUBLIC key.
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---- config (.env) ---------------------------------------------------------
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const PORT = Number(process.env.PORT || 3000);
// On Render, RENDER_EXTERNAL_URL is set automatically (e.g. https://tap-checkout-demo.onrender.com)
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const TAP_SECRET_KEY = process.env.TAP_SECRET_KEY || '';
const TAP_PUBLIC_KEY = process.env.TAP_PUBLIC_KEY || '';
const TAP_MERCHANT_ID = process.env.TAP_MERCHANT_ID || '';
const CURRENCY = process.env.CURRENCY || 'KWD';
const TAP_API = 'https://api.tap.company/v2';

// Demo shopper (one user for this demo). Tap needs a phone to save cards.
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

// ---- tiny JSON store (customer id + orders) --------------------------------
const DB_FILE = path.join(__dirname, 'data.json');
const db = fs.existsSync(DB_FILE)
  ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
  : { customerId: null, orders: [] };
const saveDb = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

// ---- Tap API helper ---------------------------------------------------------
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
    const err = new Error(`Tap ${method} ${url} failed (${res.status}): ${msg}`);
    err.status = res.status === 404 ? 404 : 502;
    err.tap = data;
    throw err;
  }
  return data;
}

async function ensureCustomer() {
  // Cloud hosts often wipe local files on restart; pin the customer with TAP_CUSTOMER_ID
  // so saved cards survive restarts.
  if (process.env.TAP_CUSTOMER_ID) return process.env.TAP_CUSTOMER_ID;
  if (db.customerId) return db.customerId;
  const c = await tap('POST', '/customers', DEMO_CUSTOMER);
  db.customerId = c.id;
  saveDb();
  console.log(`Created Tap customer ${c.id}  ->  set TAP_CUSTOMER_ID=${c.id} to keep saved cards across restarts`);
  return c.id;
}

async function listCards(customerId) {
  try {
    const r = await tap('GET', `/card/${customerId}`);
    return r.data || [];
  } catch (e) {
    if (e.status === 404) return []; // Tap returns 404 when the customer has no cards
    throw e;
  }
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
    payment_agreement: c.payment_agreement ? c.payment_agreement.id : null,
  };
}

// ---- routes -----------------------------------------------------------------
const routes = {
  'GET /api/config': async () => ({
    publicKey: TAP_PUBLIC_KEY,
    merchantId: TAP_MERCHANT_ID,
    currency: CURRENCY,
    customerId: await ensureCustomer(),
    customer: DEMO_CUSTOMER,
    products: PRODUCTS,
  }),

  'GET /api/cards': async () => {
    const cards = await listCards(await ensureCustomer());
    return cards.map(c => ({
      id: c.id, brand: c.brand, last4: c.last4 || c.last_four,
      exp_month: c.exp_month, exp_year: c.exp_year, name: c.name,
    }));
  },

  'DELETE /api/cards/:id': async (_req, params) =>
    tap('DELETE', `/card/${await ensureCustomer()}/${params.id}`),

  // body: { productId, tokenId } for a new card, or { productId, cardId } for a saved card
  'POST /api/pay': async (req) => {
    const { productId, tokenId, cardId, saveCard } = req.body || {};
    const product = PRODUCTS.find(p => p.id === productId);
    if (!product) throw Object.assign(new Error('Unknown product'), { status: 400 });
    if (!tokenId && !cardId) throw Object.assign(new Error('tokenId or cardId required'), { status: 400 });

    const customerId = await ensureCustomer();

    // A saved card id can't be charged directly: create a one-time token from it first.
    let sourceId = tokenId;
    if (cardId) {
      const tok = await tap('POST', '/tokens', {
        saved_card: { card_id: cardId, customer_id: customerId },
        client_ip: '127.0.0.1',
      });
      sourceId = tok.id;
    }

    const orderId = 'ord_' + Date.now();
    const charge = await tap('POST', '/charges', {
      amount: product.price,
      currency: CURRENCY,
      threeDSecure: true,
      customer_initiated: true,
      save_card: Boolean(saveCard) && !cardId,
      description: product.name,
      reference: { transaction: 'txn_' + Date.now(), order: orderId },
      metadata: { udf1: product.id },
      customer: { id: customerId },
      ...(TAP_MERCHANT_ID ? { merchant: { id: TAP_MERCHANT_ID } } : {}),
      source: { id: sourceId },
      redirect: { url: `${BASE_URL}/result.html` },
      post: { url: `${BASE_URL}/api/webhook` }, // only reachable if BASE_URL is public
    });

    db.orders.unshift({ orderId, chargeId: charge.id, product: product.name, amount: product.price, status: charge.status, at: new Date().toISOString() });
    saveDb();

    // INITIATED -> customer must complete 3DS on Tap's page, then comes back to /result.html?tap_id=...
    if (charge.status === 'INITIATED' && charge.transaction && charge.transaction.url) {
      return { redirectUrl: charge.transaction.url, chargeId: charge.id };
    }
    return { charge: summarizeCharge(charge) };
  },

  'GET /api/charges/:id': async (_req, params) => {
    const charge = await tap('GET', `/charges/${params.id}`);
    const o = db.orders.find(o => o.chargeId === charge.id);
    if (o && o.status !== charge.status) { o.status = charge.status; saveDb(); }
    return summarizeCharge(charge);
  },

  'GET /api/orders': async () => db.orders.slice(0, 10),

  'POST /api/webhook': async (req) => {
    console.log('Tap webhook:', req.body && req.body.id, req.body && req.body.status);
    return { received: true };
  },
};

function match(method, url) {
  for (const key of Object.keys(routes)) {
    const [m, pattern] = key.split(' ');
    if (m !== method) continue;
    const names = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)')) + '$');
    const hit = url.match(re);
    if (hit) return { handler: routes[key], params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(hit[i + 1])])) };
  }
  return null;
}

// ---- static files -----------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
function serveStatic(res, urlPath) {
  const file = path.normalize(path.join(__dirname, 'public', urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE_URL);
  if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);

  const route = match(req.method, url.pathname);
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (!route) return send(404, { error: 'Not found' });
  if (!TAP_SECRET_KEY && url.pathname !== '/api/webhook') return send(500, { error: 'TAP_SECRET_KEY is not set. Copy .env.example to .env and add your test keys.' });

  let raw = '';
  for await (const chunk of req) raw += chunk;
  try { req.body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { error: 'Invalid JSON' }); }

  try {
    send(200, await route.handler(req, route.params));
  } catch (e) {
    console.error(e.message);
    send(e.status || 500, { error: e.message, tap: e.tap });
  }
});

server.listen(PORT, () => {
  console.log(`Tap demo checkout running at ${BASE_URL}`);
  if (!TAP_SECRET_KEY.startsWith('sk_test_')) console.warn('⚠  TAP_SECRET_KEY should be a sk_test_ key for this demo.');
});
