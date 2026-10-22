-- This SECURITY DEFINER function mutates private rate-limit state and accepts
-- caller-controlled bucket/identifier/threshold parameters. It must only be
-- callable by trusted server code, which uses the service-role client.
REVOKE EXECUTE ON FUNCTION public.check_and_record_rate_limit(text, text, integer, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_and_record_rate_limit(text, text, integer, integer, integer)
  TO service_role;
