# ReBuket — Upgrade notes (commission · chat relay · taxi · UI)

This release adds:

1. **Marketplace commission system** (per-product / per-shop / platform-wide)
2. **Telegram chat relay** between customer ↔ shop via the existing main bot + shop bot — neither party sees the other's Telegram contacts
3. **Taxi delivery payer selector** (buyer pays driver / fixed platform fee)
4. **Admin earnings + settings dashboard**
5. **Premium UI overlay** (`client/css/premium.css`)
6. **Seller chat UI inside the seller panel** + admin chat viewer for dispute moderation
7. **Extended seller profile editing** (phone, description, delivery info, categories)

All changes are **additive** — no migrations rename or drop existing columns.

---

## 1. One-time DB migration (REQUIRED)

Run **`migrations/002_commission_chat_taxi.sql`** in your Supabase SQL editor.

It creates:

- `platform_settings` (default commission %, taxi fixed fee)
- `chat_messages` (relay history)
- `chat_sessions` (active chat per Telegram chat_id)

…and adds nullable columns to `products`, `shops`, `orders`. Existing rows keep working unchanged.

## 2. Restart the server

No new env vars required. The server picks up:

- New routes: `/api/admin/earnings`, `/api/admin/settings`, `/api/platform-settings`, `/api/admin/orders/:id/messages`, `/api/shops/admin/orders/:id/messages` (GET/POST)
- New telegram.js relay handlers (chat after `payment_confirmed`)
- Commission breakdown stored on every new order

## 3. Pricing semantics

Two modes coexist on `products.pricing_mode`:

| Mode | Listed price means | Commission |
|---|---|---|
| **`inclusive`** (NEW — for shop products) | What the customer pays | Deducted from seller payout |
| **`exclusive`** (legacy — eco / private) | What the seller wants | Added on top, customer pays more |

Example with `commission_percent = 20`:

- Shop product, listed 400 (`inclusive`) → customer pays 400, seller receives 320, platform fee 80
- Eco product, listed 400 (`exclusive`) → customer pays 480, seller receives 400, platform fee 80

`controllers/products.createProduct` automatically marks new products as `inclusive` when the seller is a registered active shop. The legacy channel-publishing pricing (`*1.20` upcharge) is preserved for non-shop products.

## 4. Chat relay flow

After admin confirms payment (`payment_confirmed`):

1. `chat_active = true` is set on the order
2. `chat_sessions` rows are created for the customer's Telegram chat_id and each participating shop's chat_id
3. Customer gets a notification in main bot — **any further plain-text message in main bot is relayed to the shop**
4. Shop gets a notification in shop bot — **any further plain-text message in shop bot is relayed to the customer**
5. Either side can `/endchat` to leave the relay
6. Shop can also chat via the seller-panel web UI (which calls `/api/shops/admin/orders/:id/messages`)
7. Admin can view (read-only) the entire conversation from the admin panel orders tab → "💬 Открыть чат"

All messages are persisted in `chat_messages` for audit and dispute review.

## 5. Taxi delivery payer

Checkout step 2 now shows a payer selector when "Такси" is chosen:

- **`buyer`** — order total = subtotal; customer pays the driver directly
- **`fixed`** — order total = subtotal + `platform_settings.taxi_fixed_fee` (default 50 сом, editable in admin → ⚙️ Настройки)

Stored on `orders.delivery_payer` and `orders.delivery_fee`.

## 6. Where to find things

| Feature | File |
|---|---|
| Migration | `migrations/002_commission_chat_taxi.sql` |
| Commission service | `server/src/services/commission.js` |
| Chat persistence | `server/src/services/chat.js` |
| Chat REST endpoints | `server/src/controllers/chat.js` |
| Earnings + settings endpoints | `server/src/controllers/admin_earnings.js` |
| Order creation w/ commission | `server/src/controllers/orders.js` |
| Telegram relay + chat activation | `server/src/services/telegram.js` (search `activateOrderChatFlow`, `relayShopToCustomer`, `relayCustomerToShop`) |
| Premium CSS overlay | `client/css/premium.css` |
| Admin earnings/settings UI | `client/js/admin.js` (`renderEarnings`, `renderSettings`, `adminViewChat`) |
| Seller chat UI | `client/js/main.js` (`toggleShopChat`, `loadShopChat`, `sendShopChat`) |
| Checkout taxi payer UI | `client/index.html` (search `taxi-payer-block`) |
| Shop profile edits | `client/index.html` (`#edit-shop-modal`) + `server/src/controllers/shops.js` |

## 7. Mini App context

The customer-side UX runs as a Telegram Mini App. Key integration points unchanged:

- `Telegram.WebApp.initDataUnsafe.user.id` is captured into `customer_chat_id` on order creation, so the bot can reach the customer afterwards.
- After `payment_confirmed`, the customer receives the chat-opened CTA in main bot and just types replies there — they don't need to navigate inside the Mini App for chat.
- Shops can use either the seller-panel web UI (also a Mini App view) or the shop bot directly for chat.
