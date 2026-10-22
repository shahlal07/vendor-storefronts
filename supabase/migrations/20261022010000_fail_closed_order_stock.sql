-- Direct customer INSERTs must not be possible through Supabase REST:
-- the customer-facing checkout is a server action that verifies line ownership,
-- price, shipping, discounts, payment method, and tenant before using the
-- server-only service-role client. This prevents forged order totals/items and
-- cross-vendor order creation through a publishable key.
DROP POLICY IF EXISTS "customers create own orders" ON public.orders;
REVOKE INSERT ON TABLE public.orders FROM PUBLIC, anon, authenticated;
GRANT INSERT ON TABLE public.orders TO service_role;

-- Fail closed when an order would consume unavailable inventory.
-- The existing AFTER INSERT trigger calls this function inside the order's
-- transaction; any raised exception rolls back the order and all its trigger
-- side effects (including stock/audit/fee snapshots).
CREATE OR REPLACE FUNCTION public.adjust_stock_for_order_items(
  p_order_id uuid,
  p_items jsonb,
  p_direction integer,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  item jsonb;
  v_qty integer;
  v_variant_id uuid;
  v_source text;
  v_product_id uuid;
  v_box_size numeric;
  v_box record;
  v_variant record;
  v_simple record;
  v_new_qty integer;
  v_vendor_id uuid;
BEGIN
  IF p_direction NOT IN (-1, 1) THEN
    RAISE EXCEPTION 'invalid stock adjustment direction' USING ERRCODE = '22023';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'order items must be a JSON array' USING ERRCODE = '22023';
  END IF;

  SELECT vendor_id INTO v_vendor_id
  FROM public.orders
  WHERE id = p_order_id;

  IF v_vendor_id IS NULL THEN
    RAISE EXCEPTION 'order not found for stock adjustment' USING ERRCODE = '23503';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := NULLIF(item->>'qty', '')::integer;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      IF p_direction = -1 THEN
        RAISE EXCEPTION 'order item quantity must be a positive integer' USING ERRCODE = '22023';
      END IF;

      INSERT INTO public.order_item_stock_warnings (order_id, vendor_id, item, reason)
      VALUES (p_order_id, v_vendor_id, item, 'missing or invalid qty during restock');
      CONTINUE;
    END IF;

    v_variant_id := NULLIF(item->>'variant_id', '')::uuid;
    v_product_id := NULLIF(item->>'product_id', '')::uuid;
    v_source := item->>'variant_source';
    v_box_size := NULLIF(item->>'box_size_kg', '')::numeric;

    IF v_source = 'simple' THEN
      SELECT id, stock_qty, vendor_id
      INTO v_simple
      FROM public.products
      WHERE id = v_product_id
      FOR UPDATE;

      IF v_simple.id IS NULL OR v_simple.stock_qty IS NULL THEN
        IF p_direction = -1 THEN
          RAISE EXCEPTION 'stock item could not be resolved for order %', p_order_id USING ERRCODE = '23503';
        END IF;
        INSERT INTO public.order_item_stock_warnings (order_id, vendor_id, item, reason)
        VALUES (p_order_id, v_vendor_id, item, 'simple-model product row not found or has no stock_qty');
        CONTINUE;
      END IF;

      IF v_simple.vendor_id IS DISTINCT FROM v_vendor_id THEN
        RAISE EXCEPTION 'order item belongs to a different vendor' USING ERRCODE = '23514';
      END IF;
      IF p_direction = -1 AND v_simple.stock_qty < v_qty THEN
        RAISE EXCEPTION 'insufficient stock for product %: requested %, available %', v_product_id, v_qty, v_simple.stock_qty USING ERRCODE = 'P0001';
      END IF;

      v_new_qty := v_simple.stock_qty + (p_direction * v_qty);
      UPDATE public.products SET stock_qty = v_new_qty, updated_at = now() WHERE id = v_simple.id;
      INSERT INTO public.inventory_audit_log (vendor_id, product_id, order_id, change_qty, previous_qty, new_qty, reason)
      VALUES (v_vendor_id, v_simple.id, p_order_id, v_new_qty - v_simple.stock_qty, v_simple.stock_qty, v_new_qty, p_reason);
      CONTINUE;
    END IF;

    IF v_variant_id IS NOT NULL AND v_source = 'variant' THEN
      SELECT id, stock_qty, vendor_id, product_id
      INTO v_variant
      FROM public.product_variants
      WHERE id = v_variant_id
      FOR UPDATE;

      IF v_variant.id IS NULL THEN
        IF p_direction = -1 THEN
          RAISE EXCEPTION 'variant stock item could not be resolved for order %', p_order_id USING ERRCODE = '23503';
        END IF;
        INSERT INTO public.order_item_stock_warnings (order_id, vendor_id, item, reason)
        VALUES (p_order_id, v_vendor_id, item, 'product_variants row not found for variant_id');
        CONTINUE;
      END IF;

      IF v_variant.vendor_id IS DISTINCT FROM v_vendor_id OR
         (v_product_id IS NOT NULL AND v_variant.product_id IS DISTINCT FROM v_product_id) THEN
        RAISE EXCEPTION 'order variant belongs to a different vendor or product' USING ERRCODE = '23514';
      END IF;
      IF p_direction = -1 AND v_variant.stock_qty < v_qty THEN
        RAISE EXCEPTION 'insufficient stock for variant %: requested %, available %', v_variant_id, v_qty, v_variant.stock_qty USING ERRCODE = 'P0001';
      END IF;

      v_new_qty := v_variant.stock_qty + (p_direction * v_qty);
      UPDATE public.product_variants SET stock_qty = v_new_qty, updated_at = now() WHERE id = v_variant.id;
      INSERT INTO public.inventory_audit_log (vendor_id, variant_id, product_id, order_id, change_qty, previous_qty, new_qty, reason)
      VALUES (v_vendor_id, v_variant.id, v_variant.product_id, p_order_id, v_new_qty - v_variant.stock_qty, v_variant.stock_qty, v_new_qty, p_reason);
      CONTINUE;
    END IF;

    IF v_variant_id IS NOT NULL AND v_source = 'box_size' THEN
      SELECT id, stock_qty, vendor_id, product_id
      INTO v_box
      FROM public.product_box_sizes
      WHERE id = v_variant_id
      FOR UPDATE;
    ELSIF v_product_id IS NOT NULL AND v_box_size IS NOT NULL THEN
      SELECT pbs.id, pbs.stock_qty, pbs.vendor_id, pbs.product_id
      INTO v_box
      FROM public.product_box_sizes pbs
      WHERE pbs.product_id = v_product_id
        AND pbs.box_size_kg = v_box_size
      LIMIT 1
      FOR UPDATE;
    ELSE
      IF p_direction = -1 THEN
        RAISE EXCEPTION 'unrecognized order item shape for order %', p_order_id USING ERRCODE = '22023';
      END IF;
      INSERT INTO public.order_item_stock_warnings (order_id, vendor_id, item, reason)
      VALUES (p_order_id, v_vendor_id, item, 'unrecognized item shape: no variant_id and no (product_id, box_size_kg)');
      CONTINUE;
    END IF;

    IF v_box.id IS NULL THEN
      IF p_direction = -1 THEN
        RAISE EXCEPTION 'box-size stock item could not be resolved for order %', p_order_id USING ERRCODE = '23503';
      END IF;
      INSERT INTO public.order_item_stock_warnings (order_id, vendor_id, item, reason)
      VALUES (p_order_id, v_vendor_id, item, 'product_box_sizes row not found');
      CONTINUE;
    END IF;

    IF v_box.vendor_id IS DISTINCT FROM v_vendor_id OR
       (v_product_id IS NOT NULL AND v_box.product_id IS DISTINCT FROM v_product_id) THEN
      RAISE EXCEPTION 'order box size belongs to a different vendor or product' USING ERRCODE = '23514';
    END IF;
    IF p_direction = -1 AND v_box.stock_qty < v_qty THEN
      RAISE EXCEPTION 'insufficient stock for box size %: requested %, available %', v_variant_id, v_qty, v_box.stock_qty USING ERRCODE = 'P0001';
    END IF;

    v_new_qty := v_box.stock_qty + (p_direction * v_qty);
    UPDATE public.product_box_sizes SET stock_qty = v_new_qty, updated_at = now() WHERE id = v_box.id;
    INSERT INTO public.inventory_audit_log (vendor_id, box_size_id, product_id, order_id, change_qty, previous_qty, new_qty, reason)
    VALUES (v_vendor_id, v_box.id, v_box.product_id, p_order_id, v_new_qty - v_box.stock_qty, v_box.stock_qty, v_new_qty, p_reason);
  END LOOP;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.adjust_stock_for_order_items(uuid, jsonb, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.adjust_stock_for_order_items(uuid, jsonb, integer, text) TO service_role;
