# WhatsApp order notifications — Phase 2

## Scope delivered in this phase
- Durable server-only notification ledger with unique idempotency keys, shared by storefront checkout and vendor-admin status/tracking actions.
- Sender integration that records each eligible notification before calling Meta, stores the provider message ID and acceptance state, and persists provider/network failures with a retry timestamp.
- Provider acceptance and delivery lifecycle fields (accepted, delivered, read, failed).
- A Meta webhook endpoint for verification and status callbacks.
- Operational query indexes by retry eligibility and order number.
- Retry scheduling fields to support a later scheduled worker without coupling retries to customer checkout.

## Database migration
Apply supabase/migrations/20261025000000_whatsapp_notification_outbox.sql using the existing Supabase migration workflow. The table has RLS enabled and intentionally grants no direct client policies. Server-side code must use the service-role client only.

## Meta webhook configuration
Set server-only environment variables:
- WHATSAPP_WEBHOOK_VERIFY_TOKEN: random secret used for Meta's GET verification challenge.
- WHATSAPP_APP_SECRET: Meta app secret used to verify POST request signatures.
- NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY: existing server-side Supabase configuration.

Subscribe the Meta app to WhatsApp message status webhooks. POST signature verification uses X-Hub-Signature-256; invalid signatures are rejected. Status callbacks are matched by the provider message ID and update the ledger. Unknown message IDs are ignored safely.

## Sender and lifecycle
- accepted means Meta accepted the API request; it does not mean delivered.
- Webhook status transitions update the row and timestamps.
- queued / failed rows retain next_attempt_at and attempts for a future scheduled retry worker. The sender records an initial attempt; automatic replay remains Phase 3 so this phase does not introduce an uncoordinated background job.
- This phase establishes durable records and delivery receipts; automatic retry execution and an admin dashboard are Phase 3 work.
- Keep credentials server-only. Never expose access tokens, app secrets, or service-role keys to browser code.