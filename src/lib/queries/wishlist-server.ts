import { createClient } from "@/lib/supabase/server";
import { getCurrentVendor } from "@/lib/tenant";

export type WishlistProduct = {
  id: string;
  slug: string;
  name: string;
  image: string | null;
  price: number | null;
  discount_price: number | null;
  status: string;
  rating_avg?: number;
  review_count?: number;
};

type WishlistRow = {
  created_at: string;
  product: WishlistProduct | WishlistProduct[] | null;
};

function firstProduct(product: WishlistRow["product"]): WishlistProduct | null {
  return Array.isArray(product) ? (product[0] ?? null) : product;
}

export async function getWishlistPreviewForCurrentUser(limit = 4): Promise<WishlistProduct[]> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const vendor = await getCurrentVendor();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- The checked-in Database type predates the live tenant-scoped schema.
  const query = supabase.from("wishlists") as any;

  const { data } = await query
    .select("created_at, product:products(id, slug, name, image, price, discount_price, status)")
    .eq("profile_id", user.id)
    .eq("vendor_id", vendor.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  return ((data ?? []) as WishlistRow[])
    .map((row) => firstProduct(row.product))
    .filter((p): p is WishlistProduct => p !== null && p.status === "published");
}

export async function getFullWishlistForCurrentUser(): Promise<WishlistProduct[]> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const vendor = await getCurrentVendor();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- The checked-in Database type predates the live tenant-scoped schema.
  const query = supabase.from("wishlists") as any;

  const { data } = await query
    .select("created_at, product:products(id, slug, name, image, price, discount_price, status, rating_avg, review_count)")
    .eq("profile_id", user.id)
    .eq("vendor_id", vendor.id)
    .order("created_at", { ascending: false });

  return ((data ?? []) as WishlistRow[])
    .map((row) => firstProduct(row.product))
    .filter((p): p is WishlistProduct => p !== null && p.status === "published");
}
