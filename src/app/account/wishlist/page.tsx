import { createClient } from "@/lib/supabase/server";
import { WishlistGrid } from "@/components/account/wishlist-grid";
import type { ProductWithBoxSizes } from "@/lib/queries/products";

export default async function AccountWishlistPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data } = await supabase
    .from("wishlists")
    .select(
      "product:products(id, slug, name, product_type, attributes, origin, tagline, image, rating_avg, review_count, sweetness, fiber, season, created_at, status, product_box_sizes(id, box_size_kg, selling_price, stock_qty, active), product_variants(id, attributes, label, selling_price, stock_qty, active))"
    )
    .eq("profile_id", user!.id);

  const products: ProductWithBoxSizes[] = (data ?? [])
    .map((row) => (Array.isArray(row.product) ? row.product[0] ?? null : row.product))
    .filter((p): p is NonNullable<typeof p> => p !== null && p.status === "published")
    .map((p) => {
      const activeSizes = (p.product_box_sizes ?? [])
        .filter((b) => b.active)
        .sort((a, b) => a.box_size_kg - b.box_size_kg);
      const activeVariants = (p.product_variants ?? [])
        .filter((v) => v.active)
        .map((v) => ({ ...v, attributes: (v.attributes ?? {}) as Record<string, string> }));
      const cheapestBox = activeSizes.reduce<(typeof activeSizes)[number] | null>(
        (min, b) => (min === null || b.selling_price < min.selling_price ? b : min),
        null
      );
      const cheapestVariant = activeVariants.reduce<(typeof activeVariants)[number] | null>(
        (min, v) => (min === null || v.selling_price < min.selling_price ? v : min),
        null
      );
      return {
        id: p.id,
        slug: p.slug,
        name: p.name,
        product_type: p.product_type,
        attributes: (p.attributes ?? {}) as Record<string, unknown>,
        origin: p.origin,
        tagline: p.tagline,
        image: p.image,
        rating_avg: Number(p.rating_avg),
        review_count: p.review_count,
        sweetness: p.sweetness,
        fiber: p.fiber,
        season: p.season,
        created_at: p.created_at,
        boxSizes: activeSizes,
        variants: activeVariants,
        minPrice: cheapestBox
          ? Number(cheapestBox.selling_price)
          : cheapestVariant
            ? Number(cheapestVariant.selling_price)
            : null,
        defaultBoxSizeId: cheapestBox?.id ?? cheapestVariant?.id ?? null,
        defaultUnitSource: cheapestBox ? ("box_size" as const) : ("variant" as const),
        // Best-seller/limited-harvest badges aren't shown on wishlist cards
        // (see WishlistCard) -- safe, unused defaults here rather than
        // running the same cross-catalog comparison for no visible effect.
        isBestSeller: false,
        isLimitedHarvest: false,
      };
    });

  return (
    <div>
      <h1 className="font-serif text-2xl font-bold mb-2">Your Wishlist</h1>
      <p className="text-sm text-ink-light mb-6">Pick up where you left off</p>
      <WishlistGrid initialProducts={products} userId={user!.id} />
    </div>
  );
}
