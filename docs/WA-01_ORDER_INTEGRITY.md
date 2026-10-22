# WA-01 — Canonical order integrity and rollout contract

Status: implementation review / staging verification pending  
Stock validation PR: pending creation from branch `feature/wa-01-stock-integrity-only`

## Scope

WA-01 hardens the *existing* order system before an official WhatsApp adapter is introduced. It must not create an alternative order table, fee ledger, or stock path. Every confirmed order remains in `public.orders` and uses the existing database triggers for platform-fee snapshots, vendor-plan fee snapshots, inventory, notifications, referral handling and cancellation/refund credits.

## Implemented in this branch

- The checkout form creates and retains an opaque UUIDv4 idempotency token for retries in the current tab. The server scopes it to the current Supabase identity and writes the resulting key to the existing unique `orders.idempotency_key` field.
- A retry with the same identity, key and vendor returns the pre-existing order without repeating the application-level address, coupon-usage or email side effects. Concurrent submissions are arbitrated by the existing database unique index; the losing request reads the winner and returns it.
- The only canonical storefront order insert in the current storefront flow goes through the server action after server-side customer, tenant, line, database-price, shipping, discount and payment checks. Direct `anon`/`authenticated` INSERT privileges are handled separately by [PR #12](https://github.com/shahlal07/vendor-storefronts/pull/12).
- The proposed stock function locks each stock row, validates item/vendor/product ownership, rejects malformed decrement requests and raises on insufficient or unconfigured stock. An exception in the order-insert trigger should roll the whole insert transaction back, including earlier item decrements and other transactional trigger effects. For cancellation/refund, an unresolved or NULL-stock item is recorded as a warning rather than making a previously valid status transition impossible.
- Unit tests cover malformed keys and identity-scoping behavior. GitHub Actions verifies the TypeScript app and build; the database migration is not exercised by those application checks.

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

## Required database and rollout verification

**Do not apply the stock-function migration to production until it has passed in a non-production database.** The active Supabase project examined during WA-01 is production, so concurrency/rollback checks below are release gates, not evidence of completion. Direct browser order INSERT lockdown is separate in PR #12.

| Check | Procedure | Required result |
|---|---|---|
| Direct customer insert is denied | Covered separately by [PR #12](https://github.com/shahlal07/vendor-storefronts/pull/12); verify direct REST INSERT after that migration | Permission denied; no order/trigger side effects |
| Canonical checkout still works | Place a normal COD test order through the deployed server action | One canonical order, expected database fee snapshots and exactly one stock decrement |
| Duplicate submission | Submit the same form token twice sequentially and in parallel | One `orders` row; both callers resolve to the same order number |
| Concurrent last item | Set a test SKU stock to 1; concurrently insert two separate orders requesting 1 each | One succeeds; the other fails; final stock is 0 and there is one successful order |
| Multi-line rollback | First line has stock; second line is out of stock; submit together | Entire order transaction rolls back; first line stock and all order-trigger records are unchanged |
| NULL stock | Try decrementing a test SKU whose stock is NULL | Order fails closed; no order persists |
| Wrong vendor/product | Test an item ID belonging to a different product/vendor | Order insert rolls back and stock remains untouched |
| Cancellation/refund replay | Cancel/refund one order and repeat status update | Stock and fee credit are restored once only, under existing trigger/adjustment dedupe logic |
| Tenant isolation | Two test vendors and two test customer identities | One vendor/customer cannot resolve another vendor's intent/order |
| Retry side effects | Replay an already-created checkout token | Existing order returned; no second coupon usage increment or duplicate application email |

Record the environment, test fixture IDs, SQL output, CI run, deployment SHA and migration result in the PR before removing its draft status. Do not run the inventory scenarios against the live store's real products or customer orders.

## Known boundary / next phase

This stock-guard branch does not include Meta webhooks or WhatsApp intent conversion. Direct order INSERT locking and the application retry key are handled separately in PR #12. The next phase must add durable webhook receipt/deduplication and a transaction-safe intent-to-order association; a database unique idempotency key on web checkout alone cannot cover a process crash between a WhatsApp intent confirmation and its canonical order commit.
