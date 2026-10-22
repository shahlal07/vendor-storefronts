#!/usr/bin/env bash
set -euo pipefail

PRODUCT_ID="11111111-1111-4111-8111-111111111111"
VENDOR_ID="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
ORDER_A="20000000-0000-4000-8000-000000000001"
ORDER_B="20000000-0000-4000-8000-000000000002"

psql -v ON_ERROR_STOP=1 -c "UPDATE public.products SET stock_qty=1 WHERE id='$PRODUCT_ID'; DELETE FROM public.inventory_audit_log WHERE product_id='$PRODUCT_ID'; DELETE FROM public.orders WHERE id IN ('$ORDER_A','$ORDER_B');"

# Pause both inserts before the AFTER INSERT stock trigger, increasing the
# chance that they reach the row lock at the same time. The stock row lock is
# the actual serialization mechanism being tested.
psql -v ON_ERROR_STOP=1 <<'SQL'
CREATE OR REPLACE FUNCTION public.wa01_test_concurrency_barrier()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  PERFORM pg_sleep(0.5);
  RETURN NEW;
END
$func$;
DROP TRIGGER IF EXISTS wa01_test_concurrency_barrier ON public.orders;
CREATE TRIGGER wa01_test_concurrency_barrier
BEFORE INSERT ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.wa01_test_concurrency_barrier();
SQL

set +e
psql -v ON_ERROR_STOP=1 <<SQL >/tmp/wa01-stock-a.log 2>&1 &
INSERT INTO public.orders(id,vendor_id,items) VALUES
 ('$ORDER_A','$VENDOR_ID','[{"product_id":"$PRODUCT_ID","qty":1,"variant_source":"simple"}]');
SQL
pid_a=$!
psql -v ON_ERROR_STOP=1 <<SQL >/tmp/wa01-stock-b.log 2>&1 &
INSERT INTO public.orders(id,vendor_id,items) VALUES
 ('$ORDER_B','$VENDOR_ID','[{"product_id":"$PRODUCT_ID","qty":1,"variant_source":"simple"}]');
SQL
pid_b=$!
wait "$pid_a"; status_a=$?
wait "$pid_b"; status_b=$?
set -e

if [[ "$status_a" -eq 0 && "$status_b" -eq 0 ]]; then
  cat /tmp/wa01-stock-a.log /tmp/wa01-stock-b.log
  echo "Both concurrent last-unit orders succeeded; oversell guard is broken." >&2
  exit 1
fi
if [[ "$status_a" -ne 0 && "$status_b" -ne 0 ]]; then
  cat /tmp/wa01-stock-a.log /tmp/wa01-stock-b.log
  echo "Both concurrent orders failed unexpectedly." >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 <<'SQL'
DO $test$
DECLARE v_stock integer; v_orders integer; v_audits integer;
BEGIN
  SELECT stock_qty INTO v_stock FROM public.products WHERE id='11111111-1111-4111-8111-111111111111';
  SELECT count(*) INTO v_orders FROM public.orders WHERE id IN ('20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002');
  SELECT count(*) INTO v_audits FROM public.inventory_audit_log WHERE order_id IN ('20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002');
  IF v_stock <> 0 THEN RAISE EXCEPTION 'expected final stock 0, got %', v_stock; END IF;
  IF v_orders <> 1 THEN RAISE EXCEPTION 'expected exactly one order, got %',v_orders; END IF;
  IF v_audits <> 1 THEN RAISE EXCEPTION 'expected exactly one inventory audit, got %',v_audits; END IF;
END
$test$;
SQL

echo "WA-01 concurrent last-unit test passed (one order succeeded, one failed)."
