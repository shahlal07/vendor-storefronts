-- Guest order lookup must require both an order number and a checkout contact.
-- The contact-only RPC returns full order rows (including delivery/payment fields)
-- and allows enumeration of every order tied to a known phone/email.
-- The storefront now uses find_order_by_number_and_contact instead.
REVOKE EXECUTE ON FUNCTION public.find_orders_by_contact(text, uuid)
  FROM PUBLIC, anon, authenticated;
