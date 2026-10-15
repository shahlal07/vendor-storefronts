import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Image from "next/image";
import { getProductBySlug } from "@/lib/queries/products";
import { getReviewsForProduct, getMyHelpfulVotedReviewIds } from "@/lib/queries/reviews";
import { getFrequentlyBoughtTogether } from "@/lib/queries/frequently-bought-together";
import { getSiteChrome } from "@/lib/queries/site";
import { getSiteContent } from "@/lib/queries/site-content";
import { reviewCategoryList } from "@/lib/review-categories";
import { buildSpecs } from "@/lib/product-types";
import { getAddonGroups } from "@/lib/product-addons";
import { ProductPurchasePanel } from "@/components/product-purchase-panel";
import { ReviewForm } from "@/components/review-form";
import { ProductCareSection } from "@/components/product-care-section";
import { MiniProductCard } from "@/components/account/mini-product-card";
import { ReviewHelpfulButton } from "@/components/review-helpful-button";
import { starsHTML } from "@/lib/stars";
import { productImageSrc } from "@/lib/product-image";
import { SITE_URL, absoluteUrl } from "@/lib/site-url";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const [product, { brand }] = await Promise.all([getProductBySlug(slug), getSiteContent()]);
  if (!product) return { title: "Product not found" };
  const description = product.tagline ?? `${product.name} from our orchards in ${product.origin ?? "Pakistan"} — delivered fresh within 24 hours, Cash on Delivery.`;
  const ogImage = product.image ? productImageSrc(product.image, 1000) : "/opengraph-image";
  return {
    title: product.name,
    description,
    alternates: { canonical: `/product/${product.slug}` },
    openGraph: { type: "website", title: `${product.name} — ${brand.logoText}`, description, url: `/product/${product.slug}`, images: [{ url: ogImage, alt: product.name }] },
    twitter: { card: "summary_large_image", title: `${product.name} — ${brand.logoText}`, description, images: [ogImage] },
  };
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  if (!product) notFound();
  const [reviews, frequentlyBoughtTogether, { settings }, content] = await Promise.all([
    getReviewsForProduct(product.id),
    getFrequentlyBoughtTogether(product.id, product.slug),
    getSiteChrome(),
    getSiteContent(),
  ]);
  const myHelpfulVotes = await getMyHelpfulVotedReviewIds(reviews.map((r: { id: string }) => r.id));
  const subRatingLabels = reviewCategoryList(content.reviewCategories).map((c) => ({ key: c.column, label: c.label }));
  const images = Array.from(new Set([product.image, ...(product.gallery ?? [])].filter((img): img is string => Boolean(img))));
  const specs = buildSpecs(product);
  const purchasableUnits = [...product.boxSizes, ...product.variants];
  const inStock = purchasableUnits.some((u) => u.stock_qty > 0);
  const prices = purchasableUnits.map((u) => Number(u.selling_price));
  const productJsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    description: product.tagline ?? undefined,
    image: product.image ? absoluteUrl(productImageSrc(product.image, 1000)) : undefined,
    brand: { "@type": "Brand", name: content.brand.logoText },
    ...(product.origin ? { countryOfOrigin: product.origin } : {}),
    offers: {
      "@type": "AggregateOffer",
      priceCurrency: "PKR",
      lowPrice: prices.length ? Math.min(...prices) : undefined,
      highPrice: prices.length ? Math.max(...prices) : undefined,
      offerCount: purchasableUnits.length,
      availability: inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      url: `${SITE_URL}/product/${product.slug}`,
    },
    ...(product.review_count > 0 ? { aggregateRating: { "@type": "AggregateRating", ratingValue: Number(product.rating_avg), reviewCount: product.review_count } } : {}),
  };

  return (
    <div className="px-[5%] py-10 max-w-6xl mx-auto">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(productJsonLd) }} />
      <ProductPurchasePanel productId={product.id} productSlug={product.slug} productName={product.name} images={images} videoUrl={product.video_url} boxSizes={product.boxSizes} variants={product.variants} whatsappNumber={settings?.support_whatsapp} addonGroups={getAddonGroups(product.attributes)} />
      <div className="mt-10 max-w-3xl">
        {product.origin && <div className="text-xs font-semibold uppercase tracking-wide text-orchard-green mb-2">{product.origin}</div>}
        <h1 className="font-serif text-3xl md:text-4xl font-bold mb-2">{product.name}</h1>
        <div className="flex items-center gap-2 mb-4">
          <span className="text-mango-orange" dangerouslySetInnerHTML={{ __html: starsHTML(Number(product.rating_avg)) }} />
          <span className="text-sm text-ink-light">{Number(product.rating_avg).toFixed(1)} ({product.review_count} reviews)</span>
        </div>
        {product.tagline && <p className="text-lg font-medium text-mango-deep mb-6">{product.tagline}</p>}
        {specs.length > 0 && <dl className="grid grid-cols-2 sm:grid-cols-3 gap-5 mb-8 bg-cream-warm rounded-brand p-5">{specs.map((s) => <div key={s.label}><dt className="text-[11px] uppercase tracking-wide text-ink-light mb-0.5">{s.label}</dt><dd className="font-semibold text-sm">{s.value}</dd></div>)}</dl>}
        {product.description?.map((paragraph: string, i: number) => <p key={i} className="text-ink-light mb-4 leading-relaxed">{paragraph}</p>)}
        <ProductCareSection productType={product.product_type} storageTip={product.storage_tip} ripeningTip={product.ripening_tip} recipeSuggestions={product.recipe_suggestions ?? []} />
        {frequentlyBoughtTogether.length > 0 && <div className="mb-10"><h3 className="font-serif font-bold text-lg mb-3">Frequently Bought Together</h3><div className="grid grid-cols-2 gap-3 max-w-md">{frequentlyBoughtTogether.map((p) => <MiniProductCard key={p.id} product={p} />)}</div></div>}
      </div>
      <section id="reviews" className="mt-14 max-w-3xl" aria-label="Reviews">
        <h2 className="font-serif text-2xl font-bold mb-5">Reviews {product.review_count > 0 && `(${product.review_count})`}</h2>
        <div className="mb-8"><ReviewForm productId={product.id} productSlug={product.slug} reviewCategories={content.reviewCategories} /></div>
        {reviews.length === 0 ? <p className="text-ink-light text-sm">No reviews yet — be the first to share your experience.</p> : <div className="flex flex-col gap-6">
          {reviews.map((review) => <div key={review.id} className="border-b border-border-subtle pb-6">
            <div className="flex items-center gap-2 mb-1"><span className="text-mango-orange text-sm" dangerouslySetInnerHTML={{ __html: starsHTML(review.rating) }} />{review.verified_purchase && <span className="text-xs bg-orchard-green/10 text-orchard-green font-semibold px-2 py-0.5 rounded-full">Verified Purchase</span>}</div>
            {review.title && <h3 className="font-semibold">{review.title}</h3>}
            <p className="text-sm text-ink-light mt-1">{review.body}</p>
            {review.images && review.images.length > 0 && <div className="flex gap-2 mt-3">{review.images.map((src, i) => <div key={i} className="relative w-16 h-16 rounded-brand-sm overflow-hidden bg-cream-warm"><Image src={src} alt="" fill className="object-cover" sizes="64px" /></div>)}</div>}
            {subRatingLabels.some((s) => review[s.key]) && <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-xs text-ink-light">{subRatingLabels.filter((s) => review[s.key]).map((s) => <span key={s.key}>{s.label}: <span className="text-mango-orange font-semibold">{review[s.key]}/5</span></span>)}</div>}
            <div className="flex items-center justify-between mt-3"><div className="text-xs text-ink-light">{review.profile?.name ?? "Anonymous"} · {new Date(review.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</div><ReviewHelpfulButton reviewId={review.id} initialCount={review.helpful_count} initialVoted={myHelpfulVotes.has(review.id)} /></div>
            {review.admin_reply_body && <div className="mt-3 bg-cream-warm rounded-brand p-4"><p className="text-xs font-bold uppercase tracking-wide text-mango-orange">Response from {content.brand.logoText}</p><p className="text-sm text-ink mt-1">{review.admin_reply_body}</p>{review.admin_reply_images && review.admin_reply_images.length > 0 && <div className="flex gap-2 mt-3">{review.admin_reply_images.map((src, i) => <div key={i} className="relative w-16 h-16 rounded-brand-sm overflow-hidden bg-surface"><Image src={src} alt="" fill className="object-cover" sizes="64px" /></div>)}</div>}{review.admin_reply_at && <div className="text-xs text-ink-light mt-2">{new Date(review.admin_reply_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</div>}</div>}
          </div>)}
        </div>}
      </section>
    </div>
  );
}
