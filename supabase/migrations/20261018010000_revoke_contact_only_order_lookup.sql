-- Guest lookup now runs through a trusted, rate-limited server action.
-- Neither contact-only lookup nor direct order-number+contact lookup should be
-- callable by browser roles. The server action uses service_role and returns a
-- strict allowlist of order fields.
REVOKE EXECUTE ON FUNCTION public.find_orders_by_contact(text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.find_order_by_number_and_contact(text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_order_by_number_and_contact(text, text, uuid)
  TO service_role;
