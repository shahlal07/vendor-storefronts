"use client";

import { useEffect, useRef, useState, useActionState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { useCart } from "@/lib/cart-context";
import { useUser } from "@/lib/use-user";
import { resolveCartLines, type CartLine } from "@/lib/queries/cart";
import { getShippingRate, PAKISTAN_PROVINCES } from "@/lib/queries/shipping";
import { getAddressesForCurrentUserClient } from "@/lib/queries/addresses-client";
import { createClient as createBrowserSupabaseClient } from "@/lib/supabase/client";
import { placeOrder, checkCoupon, type PlaceOrderState, type OrderLineInput } from "@/app/checkout/actions";
import { productImageSrc } from "@/lib/product-image";
import { formatPKR } from "@/lib/format";
import { computeDiscount, computeOrderTotal } from "@/lib/discount";
import type { SiteContent } from "@/lib/queries/site-content";
import { PaymentMethodSelector, type PaymentMethodValue } from "@/components/payment-method-selector";
import { BoughtTogetherStrip } from "@/components/bought-together-strip";
import type { Tables } from "@/lib/supabase/types";
import { isCheckoutIdempotencyToken } from "@/lib/order-idempotency";

const PENDING_CHECKOUT_KEY = "theaamghar_pending_checkout";
const CHECKOUT_IDEMPOTENCY_SESSION_KEY = "nashemann_checkout_idempotency_v1";

type PendingCheckout = { lines: OrderLineInput[]; form: Record<string, string> };

function fillFormField(form: HTMLFormElement, name: string, value: string) {
  const field = form.elements.namedItem(name);
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) field.value = value;
}

function addressLine1(address: Tables<"addresses">) {
  const row = address as Tables<"addresses"> & { address_line1?: string; address?: string };
  return row.address_line1 ?? row.address ?? "";
}

export function CheckoutForm({ emptyStates }: { emptyStates: SiteContent["emptyStates"] }) {
  const searchParams = useSearchParams();
  const buynowUnitId = searchParams.get("buynow");
  const buynowSource = (searchParams.get("buynowSource") as "box_size" | "variant" | null) ?? "box_size";
  const buynowQty = Number(searchParams.get("qty")) || 1;
  const { items: cartItems, clearCart } = useCart();
  const { user, loading: userLoading } = useUser();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const guestSessionRef = useRef(false);
  const [idempotencyToken, setIdempotencyToken] = useState("");

  const lines: OrderLineInput[] = buynowUnitId ? [{ unitId: buynowUnitId, source: buynowSource, qty: buynowQty }] : cartItems;
  const [resolvedLines, setResolvedLines] = useState<CartLine[] | null>(null);
  const [shippingInfo, setShippingInfo] = useState<{ province: string; city: string; rate: number } | null>(null);
  const [province, setProvince] = useState("");
  const [city, setCity] = useState("");
  const [savedAddresses, setSavedAddresses] = useState<Tables<"addresses">[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState<string>("new");
  const [couponInput, setCouponInput] = useState("");
  const [couponChecking, setCouponChecking] = useState(false);
  const [couponState, setCouponState] = useState<{ status: "idle" | "valid" | "invalid"; message?: string; discountType?: string; discountValue?: number }>({ status: "idle" });
  const [welcomeDiscountPercent, setWelcomeDiscountPercent] = useState<number | null>(null);
  const [useWelcomeDiscount, setUseWelcomeDiscount] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodValue>("cod");
  const [paymentAccountId, setPaymentAccountId] = useState<string | null>(null);
  const [isGift, setIsGift] = useState(false);

  // placeOrder must only ever be sent what the customer actually saw and
  // approved in the order summary below. resolveCartLines() silently drops
  // any line whose unit is gone/inactive/unpublished (so the summary never
  // shows a broken item) -- but `lines` itself is the raw, unfiltered cart,
  // so submitting it as-is could include a line the customer never saw,
  // and the server would then hard-error on it ("no longer available")
  // with no context on an order that looked perfectly valid on screen.
  const submittableLines = resolvedLines ? lines.filter((l) => resolvedLines.some((rl) => rl.unitId === l.unitId)) : lines;
  const boundPlaceOrder = async (_prev: PlaceOrderState, formData: FormData) => placeOrder(submittableLines, formData);
  const [state, formAction, pending] = useActionState<PlaceOrderState, FormData>(boundPlaceOrder, undefined);

  // Keep the same opaque key across retry/reload in this tab. The server
  // scopes it to the authenticated (including anonymous) Supabase user.
  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem(CHECKOUT_IDEMPOTENCY_SESSION_KEY);
      const token = isCheckoutIdempotencyToken(stored) ? stored : window.crypto.randomUUID();
      window.sessionStorage.setItem(CHECKOUT_IDEMPOTENCY_SESSION_KEY, token);
      setIdempotencyToken(token);
    } catch {
      setIdempotencyToken(window.crypto.randomUUID());
    }
  }, []);

  useEffect(() => {
    resolveCartLines(lines).then(setResolvedLines);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(lines)]);

  useEffect(() => {
    const vendorId = resolvedLines?.[0]?.vendorId;
    if (!province || !city || !vendorId) return;
    let cancelled = false;
    getShippingRate(province, city, vendorId).then((rate) => {
      if (!cancelled) setShippingInfo({ province, city, rate });
    });
    return () => { cancelled = true; };
  }, [province, city, resolvedLines]);

  const shippingFee = shippingInfo && shippingInfo.province === province && shippingInfo.city === city ? shippingInfo.rate : null;
  // True only while a rate fetch for the currently-selected province/city is
  // still in flight (both required fields are filled, so the browser won't
  // block submission on them) -- distinct from "no rate configured", which
  // resolves to shippingFee === null too but isn't a pending state.
  const shippingResolving = Boolean(province && city && shippingFee === null);

  // Checkout no longer forces an account. A signed-out customer is given a
  // real-but-anonymous Supabase session instead, which satisfies
  // orders.customer_id (NOT NULL) and every RLS policy/trigger keyed off
  // auth.uid() without any of them changing. They can still attach a real
  // account later; the anonymous user is upgraded in place rather than
  // creating a second one.
  //
  // If the anonymous provider is switched off at the project level, this
  // degrades to the previous behaviour (stash the form, send them to signup,
  // resume automatically) rather than dead-ending them at checkout.
  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    // guestSessionRef guards the re-entry from requestSubmit() below: the
    // useUser() hook hasn't re-rendered with the new session yet at that
    // point, so `user` is still null and this would otherwise loop forever.
    if (user || userLoading || guestSessionRef.current) return;
    e.preventDefault();
    const form = e.currentTarget;
    const formValues = Object.fromEntries(new FormData(form).entries()) as Record<string, string>;

    const supabase = createBrowserSupabaseClient();
    const { error: anonError } = await supabase.auth.signInAnonymously();
    if (!anonError) {
      // Session cookies are written synchronously by the browser client, so
      // the Server Action below will see the guest session.
      guestSessionRef.current = true;
      form.requestSubmit();
      return;
    }

    try { window.localStorage.setItem(PENDING_CHECKOUT_KEY, JSON.stringify({ lines, form: formValues } satisfies PendingCheckout)); } catch {}
    const returnTo = buynowUnitId ? `/checkout?buynow=${buynowUnitId}&buynowSource=${buynowSource}&qty=${buynowQty}` : "/checkout";
    router.push(`/signup?returnTo=${encodeURIComponent(returnTo)}`);
  }

  useEffect(() => {
    if (!user || !formRef.current) return;
    let pendingCheckout: PendingCheckout | null = null;
    try {
      const raw = window.localStorage.getItem(PENDING_CHECKOUT_KEY);
      pendingCheckout = raw ? JSON.parse(raw) : null;
    } catch {}
    if (!pendingCheckout) return;
    window.localStorage.removeItem(PENDING_CHECKOUT_KEY);
    const form = formRef.current;
    Object.entries(pendingCheckout.form).forEach(([name, value]) => fillFormField(form, name, value));
    setProvince(pendingCheckout.form.province ?? "");
    setCity(pendingCheckout.form.city ?? "");
    form.requestSubmit();
  }, [user]);

  useEffect(() => {
    if (!user) {
      Promise.resolve().then(() => setSavedAddresses([]));
      return;
    }
    let cancelled = false;
    async function load() {
      const supabase = createBrowserSupabaseClient();
      const [{ data: profile }, addresses] = await Promise.all([
        supabase.from("profiles").select("name, phone, welcome_discount_percent, welcome_discount_claimed_at").eq("id", user!.id).single(),
        getAddressesForCurrentUserClient(),
      ]);
      if (cancelled) return;
      setSavedAddresses(addresses);
      setWelcomeDiscountPercent(profile?.welcome_discount_percent && !profile.welcome_discount_claimed_at ? Number(profile.welcome_discount_percent) : null);
      const hasPending = (() => { try { return Boolean(window.localStorage.getItem(PENDING_CHECKOUT_KEY)); } catch { return false; } })();
      if (hasPending) return;
      const form = formRef.current;
      if (form && profile?.name) fillFormField(form, "fullName", profile.name);
      const defaultAddress = addresses.find((a) => a.is_default) ?? addresses[0];
      if (defaultAddress) applyAddressToForm(defaultAddress, profile?.phone ?? "");
      else if (form && profile?.phone) fillFormField(form, "phone", profile.phone);
    }
    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  function applyAddressToForm(address: Tables<"addresses">, fallbackPhone = "") {
    const form = formRef.current;
    if (!form) return;
    const line1 = addressLine1(address);
    fillFormField(form, "phone", address.phone ?? fallbackPhone);
    fillFormField(form, "address", line1);
    fillFormField(form, "city", address.city);
    fillFormField(form, "postalCode", address.postal_code ?? "");
    setCity(address.city);
    setProvince(address.province ?? "");
    setSelectedAddressId(address.id);
  }

  function handleAddressSelect(value: string) {
    setSelectedAddressId(value);
    if (value === "new") {
      const form = formRef.current;
      if (form) ["phone", "address", "city", "postalCode"].forEach((name) => fillFormField(form, name, ""));
      setCity(""); setProvince(""); return;
    }
    const address = savedAddresses.find((a) => a.id === value);
    if (address) applyAddressToForm(address);
  }

  async function handleApplyCoupon() {
    const code = couponInput.trim();
    const vendorId = resolvedLines?.[0]?.vendorId;
    if (!code || !vendorId) return;
    setCouponChecking(true);
    const result = await checkCoupon(code, subtotal, vendorId);
    setCouponChecking(false);
    if (result?.valid) setCouponState({ status: "valid", message: result.message, discountType: result.discountType || undefined, discountValue: result.discountValue || undefined });
    else setCouponState({ status: "invalid", message: result?.message ?? "Invalid coupon code." });
  }

  useEffect(() => {
    if (state && "success" in state && state.success) {
      if (!buynowUnitId) clearCart();
      // Rotate before leaving so returning to checkout starts a fresh order
      // instead of replaying the just-completed order token.
      const nextToken = window.crypto.randomUUID();
      try {
        window.sessionStorage.setItem(CHECKOUT_IDEMPOTENCY_SESSION_KEY, nextToken);
      } catch {}
      setIdempotencyToken(nextToken);
      const tokenField = formRef.current?.elements.namedItem("idempotencyToken");
      if (tokenField instanceof HTMLInputElement) tokenField.value = nextToken;
      window.location.href = `/track?order=${state.orderNumber}`;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const subtotal = resolvedLines?.reduce((sum, l) => sum + l.lineTotal, 0) ?? 0;
  const discountAmount = useWelcomeDiscount && welcomeDiscountPercent
    ? computeDiscount("percent", welcomeDiscountPercent, subtotal, shippingFee ?? 0).discountAmount
    : couponState.status === "valid"
      ? computeDiscount(couponState.discountType, couponState.discountValue, subtotal, shippingFee ?? 0).discountAmount
      : 0;
  const total = computeOrderTotal(subtotal, shippingFee ?? 0, discountAmount);

  if (resolvedLines !== null && resolvedLines.length === 0) {
    return (
      <div className="text-center py-16">
        <div className="text-4xl mb-4" aria-hidden="true">🛒</div>
        <h2 className="font-serif text-2xl font-bold mb-2">{emptyStates.cartTitle}</h2>
        <p className="text-ink-light mb-6">{emptyStates.cartSubtitle}</p>
        <Link href="/#shop" className="bg-mango-orange text-white font-semibold px-8 py-3 rounded-full">Browse Products</Link>
      </div>
    );
  }

  return (
    // Mobile stacks everything in DOM/`order` sequence (address → payment →
    // discount → order summary → place order → bought-together, per a real
    // customer report that the old layout buried the order summary and
    // total price below the submit button on a phone). Desktop pins each
    // block back into its original two-column spot via md:col-start/
    // md:row-start, independent of that mobile order -- CSS Grid places
    // order-modified-document-order items into the next free row of their
    // explicit column, so this doesn't need to duplicate any markup.
    <form
      ref={formRef}
      action={formAction}
      onSubmit={handleSubmit}
      noValidate
      className="grid gap-5 md:grid-cols-[1.2fr_1fr] md:gap-x-10 md:gap-y-0 md:items-start"
    >
      <input type="hidden" name="idempotencyToken" value={idempotencyToken} />
      <div className="order-1 md:order-1 md:col-start-1 md:row-start-1 min-w-0">
        <div className="bg-surface border border-border-subtle rounded-2xl shadow-brand-sm p-6">
          <h2 className="font-serif text-xl font-bold mb-4">📍 Delivery Details</h2>
          {savedAddresses.length > 0 && (
            <div className="mb-4">
              <label htmlFor="savedAddress" className="text-sm font-medium block mb-1">Deliver to</label>
              <select id="savedAddress" value={selectedAddressId} onChange={(e) => handleAddressSelect(e.target.value)} className="w-full border-[1.5px] border-border-subtle rounded-xl px-4 py-3 text-sm bg-surface focus-visible:outline-none focus-visible:border-mango-orange transition-colors">
                {savedAddresses.map((a) => { const label = addressLine1(a); return <option key={a.id} value={a.id}>{a.label ?? a.city} — {label.slice(0, 40)}{label.length > 40 ? "…" : ""}</option>; })}
                <option value="new">+ Enter a new address</option>
              </select>
            </div>
          )}
          <div className="flex flex-col gap-4">
            <Field id="fullName" name="fullName" label={isGift ? "Recipient's Name" : "Full Name"} required maxLength={80} />
            <Field id="phone" name="phone" label="Phone Number" type="tel" required placeholder="03XX-XXXXXXX" maxLength={20} />
            <Field id="email" name="email" label="Email (for order confirmation & tracking)" type="email" required placeholder="you@example.com" maxLength={200} defaultValue={user?.email && !user.is_anonymous ? user.email : undefined} />
            <div>
              <label htmlFor="address" className="text-sm font-medium block mb-1">Street Address</label>
              <textarea id="address" name="address" required maxLength={200} rows={3} className="w-full border-[1.5px] border-border-subtle rounded-xl px-4 py-3 text-sm bg-surface focus-visible:outline-none focus-visible:border-mango-orange transition-colors" />
            </div>
            {/* min-w-0 on both grid items: a <select>'s intrinsic min-content
                width can be as wide as its longest <option> ("Islamabad
                Capital Territory") regardless of w-full, and CSS Grid's
                default min-width:auto lets that blow the item (and the
                whole form, and the whole page) past the viewport on mobile
                -- this was the real cause of the checkout page rendering
                off-center/horizontally scrollable on phones. */}
            <div className="grid grid-cols-2 gap-3">
              <div className="min-w-0">
                <label htmlFor="province" className="text-sm font-medium block mb-1">Province</label>
                <select id="province" name="province" required value={province} onChange={(e) => setProvince(e.target.value)} className="w-full border-[1.5px] border-border-subtle rounded-xl px-4 py-3 text-sm bg-surface focus-visible:outline-none focus-visible:border-mango-orange transition-colors">
                  <option value="">Select…</option>
                  {PAKISTAN_PROVINCES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div className="min-w-0">
                <label htmlFor="city" className="text-sm font-medium block mb-1">City</label>
                <input id="city" name="city" type="text" required maxLength={60} value={city} onChange={(e) => setCity(e.target.value)} className="w-full border-[1.5px] border-border-subtle rounded-xl px-4 py-3 text-sm bg-surface focus-visible:outline-none focus-visible:border-mango-orange transition-colors" />
              </div>
            </div>
            <Field id="postalCode" name="postalCode" label="Postal Code (optional)" maxLength={10} />
            <div>
              <label htmlFor="notes" className="text-sm font-medium block mb-1">Delivery Notes (optional)</label>
              <textarea id="notes" name="notes" maxLength={500} rows={2} placeholder="Gate code, landmark, preferred delivery time…" className="w-full border-[1.5px] border-border-subtle rounded-xl px-4 py-3 text-sm bg-surface focus-visible:outline-none focus-visible:border-mango-orange transition-colors" />
            </div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" name="isGift" value="true" checked={isGift} onChange={(e) => setIsGift(e.target.checked)} className="w-5 h-5 accent-mango-orange" />
              <span className="text-sm font-medium">🎁 This is a gift</span>
            </label>
            {isGift && (
              <div className="pl-2 border-l-2 border-mango-orange/30">
                <label htmlFor="giftMessage" className="text-sm font-medium block mb-1">Gift Message (optional)</label>
                <textarea id="giftMessage" name="giftMessage" maxLength={300} rows={2} placeholder="Happy birthday! Hope you enjoy this 🎁" className="w-full border-[1.5px] border-border-subtle rounded-xl px-4 py-3 text-sm bg-surface focus-visible:outline-none focus-visible:border-mango-orange transition-colors" />
                <p className="text-xs text-ink-light mt-1.5">We&apos;ll ship straight to the recipient — use their name and address above.</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="order-2 md:order-2 md:col-start-1 md:row-start-2 min-w-0">
        <div className="bg-surface border border-border-subtle rounded-2xl shadow-brand-sm p-6">
          <h2 className="font-serif text-xl font-bold mb-4">💰 Payment Method</h2>
          <input type="hidden" name="paymentMethod" value={paymentMethod} />
          <input type="hidden" name="paymentAccountId" value={paymentAccountId ?? ""} />
          <PaymentMethodSelector value={paymentMethod} onChange={(method, accountId) => { setPaymentMethod(method); setPaymentAccountId(accountId); }} total={total} vendorId={resolvedLines?.[0]?.vendorId ?? null} />
        </div>
      </div>

      <div className="order-3 md:order-3 md:col-start-1 md:row-start-3 min-w-0">
        <div className="bg-surface border border-border-subtle rounded-2xl shadow-brand-sm p-6">
          <h2 className="font-serif text-xl font-bold mb-4">🏷️ Discount</h2>
          <input type="hidden" name="useWelcomeDiscount" value={useWelcomeDiscount && welcomeDiscountPercent ? "true" : ""} />
          <input type="hidden" name="couponCode" value={!useWelcomeDiscount && couponState.status === "valid" ? couponInput.trim() : ""} />
          {welcomeDiscountPercent && (
            <label className="flex items-start gap-3 mb-4 p-3.5 bg-cream-warm rounded-xl cursor-pointer">
              <input type="checkbox" checked={useWelcomeDiscount} onChange={(e) => { setUseWelcomeDiscount(e.target.checked); if (e.target.checked) { setCouponInput(""); setCouponState({ status: "idle" }); } }} className="mt-0.5" />
              <span className="text-sm"><span className="font-semibold">Use my {welcomeDiscountPercent}% welcome discount</span><span className="block text-xs text-ink-light">One-time customer welcome discount.</span></span>
            </label>
          )}
          <div className="flex gap-2">
            <input type="text" value={couponInput} disabled={useWelcomeDiscount} onChange={(e) => { setCouponInput(e.target.value); if (couponState.status !== "idle") setCouponState({ status: "idle" }); }} placeholder="Enter coupon code" maxLength={40} className="flex-1 min-w-0 border-[1.5px] border-border-subtle rounded-full px-4 py-2.5 text-sm uppercase bg-surface focus-visible:outline-none focus-visible:border-mango-orange transition-colors disabled:opacity-50" />
            <button type="button" onClick={handleApplyCoupon} disabled={useWelcomeDiscount || couponChecking || !couponInput.trim()} className="shrink-0 bg-orchard-green text-white text-sm font-semibold px-5 py-2.5 rounded-full disabled:opacity-60">{couponChecking ? "Checking…" : "Apply"}</button>
          </div>
          {couponState.message && !useWelcomeDiscount && <p className={`text-xs mt-2 ${couponState.status === "valid" ? "text-orchard-green" : "text-error"}`}>{couponState.status === "valid" ? "✓ " : ""}{couponState.message}</p>}
        </div>
      </div>

      {/* Order Summary sits ahead of the submit button on mobile (order-4,
          before the order-5 button block below) so a customer sees the
          total before being asked to place the order -- previously it lived
          in a second grid column that only appeared AFTER the button when
          stacked on a phone. Desktop keeps it in the original right column
          (md:col-start-2 md:row-start-1), unaffected by that reordering. */}
      <div className="order-4 md:order-4 md:col-start-2 md:row-start-1 md:row-span-2 min-w-0">
        <div className="bg-cream-warm border border-border-subtle rounded-2xl shadow-brand-sm p-6 md:sticky md:top-24">
          <h2 className="font-serif text-xl font-bold mb-4">Order Summary</h2>
          {resolvedLines === null ? <p className="text-sm text-ink-light">Loading…</p> : <div className="flex flex-col gap-3 mb-4">
            {resolvedLines.map((line) => (
              <div key={line.unitId} className="flex gap-3 items-center pb-3 border-b border-border-subtle">
                {line.image && <Image src={productImageSrc(line.image, 400)} alt="" width={56} height={56} className="rounded-xl object-cover w-14 h-14 shrink-0" />}
                <div className="flex-1 min-w-0 text-sm"><div className="font-semibold">{line.name}</div><div className="text-ink-light text-xs">{line.source === "box_size" ? `${line.label} box` : line.label} × {line.qty}{line.addonLabel && ` + ${line.addonLabel}`}</div></div>
                <div className="shrink-0 font-bold text-mango-orange text-sm tabular-nums">{formatPKR(line.lineTotal)}</div>
              </div>
            ))}
          </div>}
          <div className="flex justify-between text-sm py-1 tabular-nums"><span className="text-ink-light">Subtotal</span><span>{formatPKR(subtotal)}</span></div>
          <div className="flex justify-between text-sm py-1 tabular-nums"><span className="text-ink-light">Shipping</span><span>{shippingFee === null ? "—" : formatPKR(shippingFee)}</span></div>
          {discountAmount > 0 && <div className="flex justify-between text-sm py-1 text-orchard-green tabular-nums"><span>Discount</span><span>−{formatPKR(discountAmount)}</span></div>}
          <div className="flex justify-between font-bold text-lg pt-3 mt-2 border-t-[1.5px] border-border-subtle tabular-nums"><span>Total</span><span className="text-mango-orange">{formatPKR(total)}</span></div>
          <p className="text-xs text-ink-light mt-4 pt-4 border-t border-border-subtle">🚚 Usually delivered next-day, or same-day if you order before 3pm.</p>
        </div>
      </div>

      <div className="order-5 md:order-5 md:col-start-1 md:row-start-4 min-w-0">
        {state && "error" in state && <p className="text-sm text-error mb-4">{state.error}</p>}
        <button type="submit" disabled={pending || !idempotencyToken || resolvedLines === null || shippingResolving} className="w-full bg-mango-orange text-white font-semibold py-4 rounded-full transition-transform hover:-translate-y-0.5 disabled:opacity-60 disabled:hover:translate-y-0">
          {pending ? "Placing Order…" : `${buynowUnitId ? "Buy Now" : "Place Order"} — ${formatPKR(total)}`}
        </button>
        {!user && !userLoading && (
          <p className="text-xs text-ink-light text-center mt-3">
            🔒 No account needed — check out as a guest. Want order history and faster checkout next time?{" "}
            <Link href={`/signup?returnTo=${encodeURIComponent("/checkout")}`} className="text-mango-orange font-semibold">
              Create a free account
            </Link>
            .
          </p>
        )}
      </div>

      <div className="order-6 md:order-6 md:col-start-2 md:row-start-3 min-w-0">
        {resolvedLines && resolvedLines.length > 0 && (
          <div className="mt-5">
            <BoughtTogetherStrip
              vendorId={resolvedLines[0]?.vendorId ?? null}
              excludeProductIds={resolvedLines.map((l) => l.productId)}
            />
          </div>
        )}
      </div>
    </form>
  );
}

function Field({ id, name, label, type = "text", required, maxLength, placeholder, defaultValue }: { id: string; name: string; label: string; type?: string; required?: boolean; maxLength?: number; placeholder?: string; defaultValue?: string }) {
  return <div><label htmlFor={id} className="text-sm font-medium block mb-1">{label}</label><input id={id} name={name} type={type} required={required} maxLength={maxLength} placeholder={placeholder} defaultValue={defaultValue} className="w-full border-[1.5px] border-border-subtle rounded-xl px-4 py-3 text-sm bg-surface focus-visible:outline-none focus-visible:border-mango-orange transition-colors" /></div>;
}
