-- Checkout now performs all customer/tenant/cart/price/shipping/payment validation
-- in the server action, then inserts using the server-only service_role client.
-- Browser roles must not be able to forge arbitrary canonical orders directly.
DROP POLICY IF EXISTS "customers create own orders" ON public.orders;
REVOKE INSERT ON TABLE public.orders FROM PUBLIC, anon, authenticated;
GRANT INSERT ON TABLE public.orders TO service_role;
