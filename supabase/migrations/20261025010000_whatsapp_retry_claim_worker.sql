-- Phase 3: atomic claiming for scheduled WhatsApp retries.
-- Called only by the server-side service role from the authenticated Vercel cron route.
create or replace function public.claim_whatsapp_notification_retries(p_batch_size integer default 20)
returns table (
  id uuid,
  order_number text,
  event_type text,
  recipient_phone text,
  template_name text,
  template_language text,
  payload jsonb,
  attempts integer
)
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Recover abandoned sends. These are retried with the same idempotency row.
  update public.whatsapp_notification_outbox
     set state = 'failed',
         provider_status = 'stale_sending_recovered',
         last_error = coalesce(last_error, 'Recovered stale sending record after worker interruption'),
         next_attempt_at = now(),
         updated_at = now()
   where state = 'sending'
     and updated_at < now() - interval '10 minutes'
     and attempts < 6;

  return query
  with candidates as (
    select o.id
      from public.whatsapp_notification_outbox o
     where o.state in ('queued', 'failed')
       and o.next_attempt_at <= now()
       and o.attempts < 6
     order by o.next_attempt_at asc, o.created_at asc
     for update skip locked
     limit greatest(1, least(coalesce(p_batch_size, 20), 50))
  )
  update public.whatsapp_notification_outbox o
     set state = 'sending',
         attempts = o.attempts + 1,
         provider_status = 'retrying',
         updated_at = now(),
         last_error = null
    from candidates c
   where o.id = c.id
  returning o.id, o.order_number, o.event_type, o.recipient_phone,
            o.template_name, o.template_language, o.payload, o.attempts;
end;
$$;

revoke all on function public.claim_whatsapp_notification_retries(integer) from public;
revoke all on function public.claim_whatsapp_notification_retries(integer) from anon;
revoke all on function public.claim_whatsapp_notification_retries(integer) from authenticated;
grant execute on function public.claim_whatsapp_notification_retries(integer) to service_role;
