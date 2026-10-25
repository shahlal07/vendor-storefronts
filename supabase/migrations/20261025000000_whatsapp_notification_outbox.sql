-- Phase 2: durable WhatsApp notification ledger and provider status tracking.
-- Apply through the project's normal Supabase migration workflow before enabling this code.
create table if not exists public.whatsapp_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  order_number text not null,
  event_type text not null check (event_type in ('order_received', 'order_status', 'tracking_update')),
  recipient_phone text not null,
  template_name text not null,
  template_language text not null default 'en',
  payload jsonb not null default '{}'::jsonb,
  state text not null default 'queued' check (state in ('queued', 'sending', 'accepted', 'delivered', 'read', 'failed')),
  provider_message_id text unique,
  provider_status text,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  accepted_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz
);
create index if not exists whatsapp_outbox_retry_idx on public.whatsapp_notification_outbox (state, next_attempt_at) where state in ('queued', 'failed');
create index if not exists whatsapp_outbox_order_idx on public.whatsapp_notification_outbox (order_number, created_at desc);
alter table public.whatsapp_notification_outbox enable row level security;
-- Intentionally no anon/authenticated policies: this ledger is service-role/server-only.
comment on table public.whatsapp_notification_outbox is 'Server-only durable ledger for WhatsApp order notifications and Meta delivery receipts.';