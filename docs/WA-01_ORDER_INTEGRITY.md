# WA-01 — Canonical order integrity and rollout contract

Status: **Phase 1 order-engine hardening complete** (2026-10-22). Code and stock migration are merged; production grants/function were read back; the zero-cost CI integration test passed.  
Stock validation: [merged PR #13](https://github.com/shahlal07/vendor-storefronts/pull/13). Production migration history version: `20261022180345` (`20261022_fail_closed_order_stock_races`).

## Scope

WA-01 hardens the *existing* order system before an official WhatsApp adapter is introduced. It must not create an alternative order table, fee ledger, or stock path. Every confirmed order remains in `public.orders` and uses the existing database triggers for platform-fee snapshots, vendor-plan fee snapshots, inventory, notifications, referral handling and cancellation/refund credits.

## Implemented in this branch

- The checkout form creates and retains an opaque UUIDv4 idempotency token for retries in the current tab. The server scopes it to the current Supabase identity and writes the resulting key to the existing unique `orders.idempotency_key` field.
- A retry with the same identity, key and vendor returns the pre-existing order without repeating the application-level address, coupon-usage or email side effects. Concurrent submissions are arbitrated by the existing database unique index; the losing request reads the winner and returns it.
- The only canonical storefront order insert in the current storefront flow goes through the server action after server-side customer, tenant, line, database-price, shipping, discount and payment checks. Direct `anon`/`authenticated` INSERT privileges are handled separately by [PR #12](https://github.com/shahlal07/vendor-storefronts/pull/12).
- The deployed stock function locks each stock row, validates item/vendor/product ownership, rejects malformed decrement requests and raises on insufficient or unconfigured stock. Synthetic PostgreSQL integration tests proved an order-insert exception rolls the whole insert transaction back, including earlier item decrements and stock-audit side effects. For cancellation/refund, an unresolved or NULL-stock legacy item is recorded as a warning rather than blocking the status transition.
- Unit tests cover malformed checkout tokens, normalization and customer scoping. GitHub Actions run [#39828498738](https://github.com/shahlal07/vendor-storefronts/actions/runs/39828498738) passed both the app-quality job and the PostgreSQL migration integration job. The synthetic database suite applies the exact stock migration in PostgreSQL 16 and exercises the real function.

## Identity contract for WhatsApp conversion

1. Never put a phone string, guessed UUID, or fabricated placeholder into `orders.customer_id`.
2. A WhatsApp sender is identified from a valid signed Meta webhook event and its trusted `wa_id`; a browser-supplied vendor/customer identifier is not proof.
3. A later WhatsApp conversion handler must resolve a verified channel identity to an existing Supabase Auth profile, or create/link an appropriate guest identity only in trusted server-side code. Phone normalization, identity collisions, consent, retention and account-claiming must be tested before live use.
4. A click, prefilled WhatsApp link, question, draft, abandoned conversation, invalid intent token or unconfirmed cart is **not an order**. It must not decrement stock, notify as a new order, create fee snapshots or enter settlements.
5. Only explicit customer confirmation after the server re-resolves vendor/catalog/stock/price/payment constraints may create one canonical `orders` row. The WhatsApp event/intent ID needs its own durable unique conversion boundary in a future webhook phase; the browser checkout token is not a substitute for webhook event deduplication.

## Fee and settlement contract

- Preserve the existing two separate fee concepts: `platform_fee_amount`/percentage snapshot (marketplace/platform commission) and `vendor_plan_fee_amount` (vendor subscription's per-order charge). Do not add a special WhatsApp commission, bypass fee snapshot triggers, or calculate fee amounts from message text.
- For website checkout, pressing **Place Order** is the customer's explicit order submission. The current settlement generator counts a `pending` order unless its order status is `cancelled`/`refunded` or its payment status is `failed`/`refunded`. That current policy is preserved here; it must not be silently changed as a side effect of WhatsApp support. Existing cancellation/refund billing-credit triggers remain authoritative.
- The live `platform_pricing` row is presently Rs 20 per order and Rs 7,000 per month. Some shared planning notes say Rs 5,999 per month. This branch intentionally changes neither amount. Treat Rs 7,000 as the active configured price in production until Finance approves a change; reconcile the stale documented price before editing plan prices or implementing monthly billing changes.
- Retries must not generate a second order or a second set of order-level fee snapshots. Incomplete WhatsApp intents must never enter monthly settlement aggregates.

## Acceptance evidence — 2026-10-22

**The stock migration is applied to the active Supabase project** `eznxsosvsgkhexbjoolh` under migration version `20261022180345`. A read-only production read-back confirmed the deployed function has row locks, insufficient-stock and vendor/product checks, remains SECURITY DEFINER, and is executable only by the database owner and `service_role`. Existing order-insert decrement and cancellation/refund-restock triggers still point to the expected trigger functions.

The test database runs entirely in a disposable PostgreSQL 16 service inside standard GitHub-hosted CI on this public repository. It uses synthetic rows and does not create or use a paid Supabase branch.

| Acceptance check | Result | Evidence |
|---|---|---|
| Direct browser-role order INSERT is denied | **PASS** | Production privilege read-back: `anon` and `authenticated` INSERT privileges false; customer INSERT policy absent; `service_role` INSERT true |
| Guest order lookup / rate-limit RPCs restricted | **PASS** | Production ACL read-back after storefront PR #9/#10 and vendor-admins PR #9: browser-role execution false; intended `service_role` execution true |
| Simple product, variant and box-size decrements | **PASS** | PostgreSQL integration job |
| Shortage fails with no partial stock/order/audit side effects | **PASS** | PostgreSQL integration job |
| Multi-line order rolls back earlier stock updates when a later line is unavailable | **PASS** | PostgreSQL integration job |
| NULL stock, invalid quantity, wrong vendor/product fail closed | **PASS** | PostgreSQL integration job |
| Legacy unresolved item still allows cancel/refund with a warning | **PASS** | PostgreSQL integration job |
| Cancellation/refund stock restoration happens once | **PASS** | PostgreSQL integration job |
| Two concurrent orders racing for the last unit | **PASS** | Two overlapping inserts; exactly one order and audit persist; final test stock is zero |
| Duplicate idempotency key cannot create another order or decrement stock twice | **PASS** | PostgreSQL integration job; existing unique `orders.idempotency_key` index remains in production |
| Checkout token rejects malformed values and is scoped per customer | **PASS** | Vitest helper tests |
| Full authenticated customer checkout E2E against production | **NOT RUN** | No synthetic order was placed in production because it would create a real order and mutate inventory; app CI/build and READY production deployment are verified instead |
| Signed Meta webhook to verified WhatsApp sender identity | **LATER PHASE** | WhatsApp provider adapter/intent conversion are not implemented in WA-01 |

## Fee, identity and release boundary

- Preserve the existing fee split: `platform_fee_amount`/percentage snapshot (marketplace commission) and `vendor_plan_fee_amount` (vendor plan fee per eligible order). The stock migration does not alter fee computation, settlement logic, prices, or any order/stock row.
- The live `platform_pricing` row is Rs 20/order and Rs 7,000/month. Treat Rs 7,000 as the current runtime amount; older Rs 5,999 planning notes do not authorize a price change. Reconcile the stale note in the separate Finance/pricing task before any billing change.
- The current settlement generator includes a pending order unless order status is cancelled/refunded or payment status is failed/refunded. This existing behavior was preserved, not silently changed.
- A click, link-out, inquiry, draft, abandoned conversation or invalid WhatsApp intent is never a canonical order and must not incur order fees or decrement stock. Only explicit customer confirmation after fresh tenant/catalog/price/stock/payment validation can create one row in `public.orders`; its existing triggers remain the single source for stock, fee snapshots and refunds.
- Do not place synthetic/fake orders in production as a smoke test. Use the free CI database for transactional stock tests. Full authenticated checkout E2E and Meta send/receive verification are separate rollout gates before live WhatsApp order conversion.
- WhatsApp identity must later map a signed Meta `wa_id` to a verified/existing Auth identity or to a deliberately designed secure guest identity. Never fabricate `orders.customer_id`, accept a browser-supplied vendor/customer identity as authority, or replace durable Meta event-to-order uniqueness with a web checkout token.

## Known boundary / next phase

Phase 1 deliberately does not include Meta webhooks, connected-number onboarding or WhatsApp intent conversion. Next, WA-02 builds the shared/vendor-number registry, WA-03 adds signed durable Meta webhooks, and WA-04 implements verified sender identity and an atomic intent-to-canonical-order conversion boundary. Web checkout idempotency alone is not sufficient to deduplicate Meta events after a process crash.
