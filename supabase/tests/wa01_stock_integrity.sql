-- Install test-only triggers that mirror the production insert-decrement
-- and once-only cancellation/refund restock conditions.
CREATE OR REPLACE FUNCTION public.wa01_test_decrement_order_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM public.adjust_stock_for_order_items(NEW.id, NEW.items, -1, 'order_placed');
  RETURN NEW;
END $$;

CREATE TRIGGER wa01_test_orders_decrement_stock
AFTER INSERT ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.wa01_test_decrement_order_stock();

CREATE OR REPLACE FUNCTION public.wa01_test_restock_cancelled_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status IN ('cancelled', 'refunded')
     AND OLD.status IS DISTINCT FROM NEW.status
     AND OLD.status NOT IN ('cancelled', 'refunded') THEN
    PERFORM public.adjust_stock_for_order_items(
      NEW.id, NEW.items, 1,
      CASE WHEN NEW.status = 'cancelled' THEN 'order_cancelled' ELSE 'order_refunded' END
    );
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER wa01_test_orders_restock
AFTER UPDATE OF status ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.wa01_test_restock_cancelled_order();
-- Execute after wa01_stock_schema.sql and the real production stock migration.
-- All fixture identities and data are synthetic and confined to the CI database.
\set ON_ERROR_STOP on

INSERT INTO public.products(id, vendor_id, stock_qty) VALUES
 ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',5),
 ('22222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',9),
 ('33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',NULL),
 ('44444444-4444-4444-8444-444444444444','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',0);

INSERT INTO public.product_variants(id, vendor_id, product_id, stock_qty) VALUES
 ('55555555-5555-4555-8555-555555555555','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','44444444-4444-4444-8444-444444444444',4),
 ('66666666-6666-4666-8666-666666666666','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222',4),
 ('77777777-7777-4777-8777-777777777777','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','44444444-4444-4444-8444-444444444444',NULL);

INSERT INTO public.product_box_sizes(id, vendor_id, product_id, box_size_kg, stock_qty) VALUES
 ('88888888-8888-4888-8888-888888888888','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','44444444-4444-4444-8444-444444444444',1,4),
 ('99999999-9999-4999-8999-999999999999','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','44444444-4444-4444-8444-444444444444',2,0),
 ('abababab-abab-4bab-8bab-abababababab','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','44444444-4444-4444-8444-444444444444',3,NULL);

-- 1. Simple-product decrement is accurate and audited.
INSERT INTO public.orders(id,vendor_id,items) VALUES
 ('10000000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '[{"product_id":"11111111-1111-4111-8111-111111111111","qty":2,"variant_source":"simple"}]');
DO $$
BEGIN
  IF (SELECT stock_qty FROM public.products WHERE id='11111111-1111-4111-8111-111111111111') <> 3 THEN
    RAISE EXCEPTION 'simple product decrement was not applied';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.inventory_audit_log WHERE order_id='10000000-0000-4000-8000-000000000001' AND change_qty=-2 AND previous_qty=5 AND new_qty=3) THEN
    RAISE EXCEPTION 'simple product audit record is incorrect';
  END IF;
END $$;

-- 2. Variant and box-size paths both decrement the correct inventory rows.
INSERT INTO public.orders(id,vendor_id,items) VALUES
 ('10000000-0000-4000-8000-000000000002','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '[{"product_id":"44444444-4444-4444-8444-444444444444","variant_id":"55555555-5555-4555-8555-555555555555","qty":1,"variant_source":"variant"}]');
INSERT INTO public.orders(id,vendor_id,items) VALUES
 ('10000000-0000-4000-8000-000000000003','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '[{"product_id":"44444444-4444-4444-8444-444444444444","variant_id":"88888888-8888-4888-8888-888888888888","qty":1,"variant_source":"box_size","box_size_kg":1}]');
DO $$
BEGIN
  IF (SELECT stock_qty FROM public.product_variants WHERE id='55555555-5555-4555-8555-555555555555') <> 3 THEN
    RAISE EXCEPTION 'variant decrement was not applied';
  END IF;
  IF (SELECT stock_qty FROM public.product_box_sizes WHERE id='88888888-8888-4888-8888-888888888888') <> 3 THEN
    RAISE EXCEPTION 'box-size decrement was not applied';
  END IF;
END $$;

-- 3. Insufficient quantity must fail with P0001 and leave no order/stock/audit effects.
DO $$
DECLARE v_state text; v_audit_before bigint; v_stock_before integer;
BEGIN
  SELECT count(*) INTO v_audit_before FROM public.inventory_audit_log;
  SELECT stock_qty INTO v_stock_before FROM public.products WHERE id='11111111-1111-4111-8111-111111111111';
  BEGIN
    INSERT INTO public.orders(id,vendor_id,items) VALUES
    ('10000000-0000-4000-8000-000000000004','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
     '[{"product_id":"11111111-1111-4111-8111-111111111111","qty":4,"variant_source":"simple"}]');
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  END;
  IF v_state IS DISTINCT FROM 'P0001' THEN RAISE EXCEPTION 'expected P0001 for shortage; got %', v_state; END IF;
  IF EXISTS (SELECT 1 FROM public.orders WHERE id='10000000-0000-4000-8000-000000000004') THEN RAISE EXCEPTION 'failed order persisted'; END IF;
  IF (SELECT stock_qty FROM public.products WHERE id='11111111-1111-4111-8111-111111111111') <> v_stock_before THEN RAISE EXCEPTION 'stock changed after failed order'; END IF;
  IF (SELECT count(*) FROM public.inventory_audit_log) <> v_audit_before THEN RAISE EXCEPTION 'audit side effect persisted after failed order'; END IF;
END $$;

-- 4. Multi-line shortage rolls back earlier item decrements, audits and order row.
DO $$
DECLARE v_state text; v_simple_before integer; v_audit_before bigint;
BEGIN
  SELECT stock_qty INTO v_simple_before FROM public.products WHERE id='11111111-1111-4111-8111-111111111111';
  SELECT count(*) INTO v_audit_before FROM public.inventory_audit_log;
  BEGIN
    INSERT INTO public.orders(id,vendor_id,items) VALUES
    ('10000000-0000-4000-8000-000000000005','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
     '[{"product_id":"11111111-1111-4111-8111-111111111111","qty":1,"variant_source":"simple"},{"product_id":"44444444-4444-4444-8444-444444444444","variant_id":"99999999-9999-4999-8999-999999999999","qty":1,"variant_source":"box_size","box_size_kg":2}]');
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  END;
  IF v_state IS DISTINCT FROM 'P0001' THEN RAISE EXCEPTION 'expected P0001 for multi-line shortage; got %', v_state; END IF;
  IF EXISTS (SELECT 1 FROM public.orders WHERE id='10000000-0000-4000-8000-000000000005') THEN RAISE EXCEPTION 'multi-line failed order persisted'; END IF;
  IF (SELECT stock_qty FROM public.products WHERE id='11111111-1111-4111-8111-111111111111') <> v_simple_before THEN RAISE EXCEPTION 'first line decrement was not rolled back'; END IF;
  IF (SELECT count(*) FROM public.inventory_audit_log) <> v_audit_before THEN RAISE EXCEPTION 'first line audit was not rolled back'; END IF;
END $$;

-- 5. Wrong vendor and wrong product/variant must fail closed.
DO $$
DECLARE v_state text;
BEGIN
  BEGIN
    INSERT INTO public.orders(id,vendor_id,items) VALUES
    ('10000000-0000-4000-8000-000000000006','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
     '[{"product_id":"22222222-2222-4222-8222-222222222222","qty":1,"variant_source":"simple"}]');
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  END;
  IF v_state IS DISTINCT FROM '23514' THEN RAISE EXCEPTION 'expected vendor constraint failure; got %',v_state; END IF;

  v_state := NULL;
  BEGIN
    INSERT INTO public.orders(id,vendor_id,items) VALUES
    ('10000000-0000-4000-8000-000000000007','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
     '[{"product_id":"11111111-1111-4111-8111-111111111111","variant_id":"55555555-5555-4555-8555-555555555555","qty":1,"variant_source":"variant"}]');
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  END;
  IF v_state IS DISTINCT FROM '23514' THEN RAISE EXCEPTION 'expected product/variant mismatch failure; got %',v_state; END IF;
END $$;

-- 6. NULL stock and malformed quantities fail with explicit error states.
DO $$
DECLARE v_state text;
BEGIN
  BEGIN
    INSERT INTO public.orders(id,vendor_id,items) VALUES
    ('10000000-0000-4000-8000-000000000008','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
     '[{"product_id":"33333333-3333-4333-8333-333333333333","qty":1,"variant_source":"simple"}]');
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  END;
  IF v_state IS DISTINCT FROM 'P0001' THEN RAISE EXCEPTION 'expected P0001 for NULL stock; got %',v_state; END IF;

  v_state := NULL;
  BEGIN
    INSERT INTO public.orders(id,vendor_id,items) VALUES
    ('10000000-0000-4000-8000-000000000009','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
     '[{"product_id":"11111111-1111-4111-8111-111111111111","qty":0,"variant_source":"simple"}]');
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  END;
  IF v_state IS DISTINCT FROM '22023' THEN RAISE EXCEPTION 'expected 22023 for invalid qty; got %',v_state; END IF;
END $$;

-- 7. Cancel/refund restock happens once; repeat status writes cannot restock again.
INSERT INTO public.orders(id,vendor_id,items) VALUES
 ('10000000-0000-4000-8000-000000000010','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '[{"product_id":"11111111-1111-4111-8111-111111111111","qty":1,"variant_source":"simple"}]');
UPDATE public.orders SET status='cancelled' WHERE id='10000000-0000-4000-8000-000000000010';
UPDATE public.orders SET status='cancelled' WHERE id='10000000-0000-4000-8000-000000000010';
DO $$
BEGIN
  IF (SELECT stock_qty FROM public.products WHERE id='11111111-1111-4111-8111-111111111111') <> 3 THEN
    RAISE EXCEPTION 'cancelled item was not decremented then restocked once';
  END IF;
  IF (SELECT count(*) FROM public.inventory_audit_log WHERE order_id='10000000-0000-4000-8000-000000000010') <> 2 THEN
    RAISE EXCEPTION 'expected exactly one decrement and one restock audit entry';
  END IF;
END $$;

-- 8. A legacy order with no resolvable item may still cancel and records a warning.
ALTER TABLE public.orders DISABLE TRIGGER wa01_test_orders_decrement_stock;
INSERT INTO public.orders(id,vendor_id,items) VALUES
 ('10000000-0000-4000-8000-000000000011','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '[{"product_id":"deadbeef-dead-4eef-8eef-deadbeefdead","qty":1,"variant_source":"simple"}]');
ALTER TABLE public.orders ENABLE TRIGGER wa01_test_orders_decrement_stock;
UPDATE public.orders SET status='refunded' WHERE id='10000000-0000-4000-8000-000000000011';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.order_item_stock_warnings WHERE order_id='10000000-0000-4000-8000-000000000011') THEN
    RAISE EXCEPTION 'legacy restock did not record warning';
  END IF;
  IF (SELECT status FROM public.orders WHERE id='10000000-0000-4000-8000-000000000011') <> 'refunded' THEN
    RAISE EXCEPTION 'legacy refund status transition was blocked';
  END IF;
END $$;

-- 9. Duplicate idempotency keys cannot create a second order or decrement stock twice.
DO $
DECLARE v_state text; v_stock_before integer; v_key_count integer;
BEGIN
  SELECT stock_qty INTO v_stock_before FROM public.products WHERE id='11111111-1111-4111-8111-111111111111';
  INSERT INTO public.orders(id,vendor_id,items,idempotency_key) VALUES
   ('10000000-0000-4000-8000-000000000012','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '[{"product_id":"11111111-1111-4111-8111-111111111111","qty":1,"variant_source":"simple"}]',
    'customer-session:a6c1c1f1-6e90-4ab2-9d94-b7a5ec96b33e');
  BEGIN
    INSERT INTO public.orders(id,vendor_id,items,idempotency_key) VALUES
     ('10000000-0000-4000-8000-000000000013','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '[{"product_id":"11111111-1111-4111-8111-111111111111","qty":1,"variant_source":"simple"}]',
      'customer-session:a6c1c1f1-6e90-4ab2-9d94-b7a5ec96b33e');
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  END;
  IF v_state IS DISTINCT FROM '23505' THEN RAISE EXCEPTION 'expected unique-key violation 23505; got %',v_state; END IF;
  SELECT count(*) INTO v_key_count FROM public.orders
    WHERE idempotency_key='customer-session:a6c1c1f1-6e90-4ab2-9d94-b7a5ec96b33e';
  IF v_key_count <> 1 THEN RAISE EXCEPTION 'duplicate idempotency key persisted % orders',v_key_count; END IF;
  IF EXISTS (SELECT 1 FROM public.orders WHERE id='10000000-0000-4000-8000-000000000013') THEN
    RAISE EXCEPTION 'duplicate idempotency order persisted';
  END IF;
  IF (SELECT stock_qty FROM public.products WHERE id='11111111-1111-4111-8111-111111111111') <> v_stock_before - 1 THEN
    RAISE EXCEPTION 'duplicate idempotency attempt changed stock more than once';
  END IF;
  IF EXISTS (SELECT 1 FROM public.inventory_audit_log WHERE order_id='10000000-0000-4000-8000-000000000013') THEN
    RAISE EXCEPTION 'duplicate idempotency attempt wrote stock audit rows';
  END IF;
END $;

-- 10. Refunding a normally decrementing order restores stock exactly once.
DO $
DECLARE v_stock_before integer;
BEGIN
  SELECT stock_qty INTO v_stock_before FROM public.products WHERE id='11111111-1111-4111-8111-111111111111';
  INSERT INTO public.orders(id,vendor_id,items) VALUES
   ('10000000-0000-4000-8000-000000000014','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '[{"product_id":"11111111-1111-4111-8111-111111111111","qty":1,"variant_source":"simple"}]');
  UPDATE public.orders SET status='refunded' WHERE id='10000000-0000-4000-8000-000000000014';
  UPDATE public.orders SET status='refunded' WHERE id='10000000-0000-4000-8000-000000000014';
  IF (SELECT stock_qty FROM public.products WHERE id='11111111-1111-4111-8111-111111111111') <> v_stock_before THEN
    RAISE EXCEPTION 'refund did not restore stock exactly once';
  END IF;
  IF (SELECT count(*) FROM public.inventory_audit_log WHERE order_id='10000000-0000-4000-8000-000000000014') <> 2 THEN
    RAISE EXCEPTION 'expected exactly one decrement and one refund restock audit entry';
  END IF;
END $;

SELECT 'WA-01 stock regression tests passed' AS result;
