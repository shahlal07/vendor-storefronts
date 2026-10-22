-- Minimal synthetic PostgreSQL schema for the real stock migration.
-- Runs only in an ephemeral GitHub Actions PostgreSQL service, never production.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

CREATE TABLE public.orders (
  id uuid PRIMARY KEY,
  vendor_id uuid NOT NULL,
  items jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  idempotency_key text UNIQUE
);
CREATE TABLE public.products (
  id uuid PRIMARY KEY,
  vendor_id uuid NOT NULL,
  stock_qty integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.product_variants (
  id uuid PRIMARY KEY,
  vendor_id uuid NOT NULL,
  product_id uuid NOT NULL,
  stock_qty integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.product_box_sizes (
  id uuid PRIMARY KEY,
  vendor_id uuid NOT NULL,
  product_id uuid NOT NULL,
  box_size_kg numeric NOT NULL,
  stock_qty integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.inventory_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id uuid NOT NULL,
  product_id uuid,
  variant_id uuid,
  box_size_id uuid,
  order_id uuid NOT NULL,
  change_qty integer NOT NULL,
  previous_qty integer NOT NULL,
  new_qty integer NOT NULL,
  reason text NOT NULL
);
CREATE TABLE public.order_item_stock_warnings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id uuid NOT NULL,
  vendor_id uuid NOT NULL,
  item jsonb NOT NULL,
  reason text NOT NULL
);
