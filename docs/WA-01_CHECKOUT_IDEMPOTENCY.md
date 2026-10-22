# WA-01 — Idempotent checkout rollout

This PR separates the application-level checkout hardening from the untested stock-trigger rewrite in draft PR #11.

## Change

- An opaque UUIDv4 token is held in the current browser tab for the duration of a checkout retry and scoped to the current Supabase Auth identity on the server.
- The existing unique `orders.idempotency_key` index decides the winner of concurrent submissions that carry the same token. A retry resolves to the already-created order and must not re-run coupon usage/email/address side effects.
- The canonical storefront order insert now uses the server-only service-role client, after the existing server action has validated customer session, current vendor/host, every resolved item and vendor, database-backed prices, shipping, coupons/discounts and payment account.
- The migration revokes direct browser-role INSERT access to `public.orders` and removes the permissive customer INSERT policy. Customer-facing checkout must continue through the validated server action; `service_role` retains INSERT permission.

## Verification

GitHub Actions must pass tests, Next route type generation, TypeScript, ESLint and production build; Vercel preview must report READY. After production deployment, apply the migration and verify that `anon`/`authenticated` lack INSERT privilege while `service_role` retains it. A normal checkout E2E test must be performed in a test environment, not by creating a real customer order merely to test.

## Fee/identity behavior

This does not add a second order ledger or any new fee. Canonical rows still flow through existing platform-fee and vendor-plan-fee snapshot triggers and settlement behavior. A click, WhatsApp link, inbound question or unconfirmed draft is not an order. WhatsApp sender identity/intent conversion belongs to later phases and must use a trusted identity mapping plus durable event-to-order uniqueness.

## Scope boundary

The row-locked stock fail-closed function, including concurrent last-unit, multi-item rollback and legacy refund/restock tests, remains in [draft PR #11](https://github.com/shahlal07/vendor-storefronts/pull/11). Do not merge the stock-function migration without a passing non-production database test.
