# WhatsApp order notifications — Phase 3

## Scope
- Adds an authenticated server-side retry endpoint at `/api/cron/whatsapp-retries`.
- Claims retry work atomically through `claim_whatsapp_notification_retries` using row locks and `SKIP LOCKED`, so overlapping invocations do not claim the same row.
- Retries queued/failed rows only when due, caps attempts at six, and uses exponential backoff capped at six hours.
- Recovers rows left in `sending` for more than ten minutes when they remain below the attempt cap.
- Persists provider message IDs, acceptance, and failures; unknown delivery status remains distinct from accepted.
- Adds a daily Vercel Cron schedule while preserving the existing streak-reminder cron. The daily schedule is intentionally compatible with a no-cost Vercel Hobby deployment.

## Database
Migration: `supabase/migrations/20261025010000_whatsapp_retry_claim_worker.sql`.
The same migration was applied to the shared Supabase project. The claim function runs as invoker, has a fixed search path, and execution is revoked from public/anon/authenticated and granted only to service_role.

## Required server configuration
- `CRON_SECRET`: strong random bearer secret used to protect the retry endpoint.
- `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_ACCESS_TOKEN`: server-only Meta Cloud API credentials.
- Existing `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are required by the server-side Supabase client.
- `WHATSAPP_ORDER_TEMPLATE_NAME` and optional `WHATSAPP_TEMPLATE_LANGUAGE` must match an approved five-body-parameter template.

## Operational behavior
- The worker processes at most 20 rows per invocation.
- Rows with six attempts are no longer claimed automatically and require manual review.
- A message accepted by Meta is not necessarily delivered; delivery/read receipts are persisted by the Phase 2 webhook.
- The sender uses a durable outbox and idempotency key. Provider/network failures are stored with a retry timestamp.
- Do not enable live sends until Meta credentials, template approval, and recipient opt-in are confirmed.

## Deployment and cost note
The retry worker is scheduled daily at 13:05 UTC to avoid requiring a paid Vercel Cron tier. A row may wait until the next daily run even if its backoff expires earlier. More frequent scheduling requires a compatible paid Vercel plan or a separate scheduler whose free-tier limits have been confirmed.
