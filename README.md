# Tap Payments – simple e2e checkout (test mode)

Pick a product → pay with a Tap test card → (optional) save the card → buy again with the saved card.

Live demo: https://tap-checkout-demo-chi.vercel.app

## Project layout
| Path | What it is |
|---|---|
| `public/index.html` | Shop page: products, Tap Web Card SDK v2, saved cards, recent orders |
| `public/result.html` | Page Tap returns the shopper to after 3-D Secure; confirms the charge status |
| `public/style.css` | Styling |
| `api/index.js` | One Vercel serverless function that handles every `/api/*` route and calls the Tap API |
| `vercel.json` | Rewrites `/api/<path>` to `api/index.js?path=<path>` |

No npm packages and no build step.

## Deploy on Vercel
1. Push this folder to a GitHub repo.
2. vercel.com → Add New → Project → import the repo. Keep the **Other** preset and leave the build settings empty.
3. Add these environment variables (see `.env.example`), then click Deploy:
   - `TAP_SECRET_KEY` – test secret key (`sk_test_…`) from the Tap dashboard → goSell → API Credentials
   - `TAP_PUBLIC_KEY` – test public key (`pk_test_…`)
   - `TAP_MERCHANT_ID` – your Tap merchant id
   - Optional: `CURRENCY` (default `KWD`), `BASE_URL` (default: the site's own address), `TAP_CUSTOMER_ID` (use one fixed Tap customer for every visitor)
4. Every push to `main` redeploys automatically. After changing environment variables, redeploy from the Vercel dashboard.

## Flow
| Step | Browser | Server → Tap API |
|---|---|---|
| Load | `GET /api/config?customerId=` (id kept in `localStorage`) | `GET /v2/customers/{id}`, or `POST /v2/customers` the first time |
| New card | Tap Web Card SDK v2 → `CardSDK.tokenize()` → `tok_…` | `POST /v2/charges` with `source.id = tok_…`, `save_card`, `customer.id` |
| 3DS | redirect to `transaction.url`, back to `/result.html?tap_id=chg_…` | `GET /v2/charges/{id}` to confirm status |
| Saved cards | `GET /api/cards?customerId=` | `GET /v2/card/{customer_id}` |
| Pay with saved card | choose the card, click Pay | `POST /v2/tokens` `{saved_card:{card_id, customer_id}}` → `POST /v2/charges` |
| Remove card | Remove | `DELETE /v2/card/{customer_id}/{card_id}` |
| Webhook | – | Tap calls `POST /api/webhook` (logged in Vercel's function logs) |

## Test cards
Expiry `01/39` + CVV `100` = approved; expiry `05/22` = declined.
VISA `4012000033330026` (no 3DS), MC `5123450000000008` (3DS), MC `5111111111111118` (no 3DS).

## Notes
- The secret key stays on the server; the page only gets the public key.
- Vercel functions have no lasting disk, so each browser keeps its Tap customer id and its recent orders in `localStorage`. A different browser or a private window starts as a new shopper; clear the site data to start over.
- Saving cards must be enabled on your Tap merchant account, and the customer needs a phone number (the demo customer has one).
- The Pay button doesn't wait for the card form's "valid" event; Tap validates the card on `tokenize()` and the page shows an error if it's incomplete.
