"use server";

import { headers } from "next/headers";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendWhatsAppOrderUpdate } from "@/lib/whatsapp";
import { getShippingRateServer } from "@/lib/queries/shipping-server";
import { sendOrderConfirmationEmail, sendAdminNewOrderAlert, sendVendorNewOrderEmail, ADMIN_ALERT_EMAIL } from "@/lib/email";
import { computeDiscount, computeOrderTotal } from "@/lib/discount";
import { variantLabel } from "@/lib/variant-label";
import { getOrderItemVariantLabel, type OrderItem } from "@/lib/order-item";
import { getAddonGroups, addonSelectionLabel, totalAddonPrice } from "@/lib/product-addons";
import { validateCheckoutLines } from "@/lib/checkout-validation";
import { getCurrentVendor } from "@/lib/tenant";
import { scopedOrderIdempotencyKey } from "@/lib/order-idempotency";

export type OrderLineInput = {
  unitId: string;
  source?: "box_size" | "variant";
  qty: number;
  addonSelections?: Record<string, string[]>;
};
export type PlaceOrderState = { error: string } | { success: true; orderNumber: string } | undefined;
const PK_PHONE_PATTERN = /^(?:\+92|0092|0)?3\d{2}[-\s]?\d{7}$/;
export type CheckCouponState =
  | { valid: false; message: string }
  | { valid: true; discountType: string; discountValue: number; message: string }
  | undefined;

export async function checkCoupon(code: string, subtotal: number, vendorId: string): Promise<CheckCouponState> {
  const supabase = await createClient();
  const headersList = await headers();
  const ip = headersList.get("x-forwarded-for")?.split(",")[0]?.trim() || headersList.get("x-real-ip") || "unknown";
  const { data: rateLimitData } = await supabase.rpc("check_and_record_coupon_attempt", { p_identifier: ip }).single();
  const rateLimit = rateLimitData as { allowed?: boolean } | null;
  if (!rateLimit?.allowed) return { valid: false, message: "Too many attempts. Please try again in a few minutes." };
  const { data: { user } } = await supabase.auth.getUser();
  const { data: couponData } = await supabase.rpc("validate_coupon", { p_code: code, p_order_amount: subtotal, p_vendor_id: vendorId, p_customer_id: user?.id }).single();
  const data = couponData as { valid?: boolean; message?: string; discount_type?: string; discount_value?: number | string } | null;
  if (!data?.valid) return { valid: false, message: data?.message ?? "Invalid coupon code." };
  return { valid: true, discountType: data.discount_type ?? "", discountValue: Number(data.discount_value ?? 0), message: data.message ?? "Coupon applied." };
}

export async function placeOrder(lines: OrderLineInput[], formData: FormData): Promise<PlaceOrderState> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Please sign in to place your order." };

  const idempotencyKey = scopedOrderIdempotencyKey(user.id, formData.get("idempotencyToken"));
  if (!idempotencyKey) return { error: "Your checkout session expired. Refresh checkout and try again." };

  const currentVendor = await getCurrentVendor();
  const { data: existingOrder, error: idempotencyLookupError } = await supabase
    .from("orders")
    .select("order_number, customer_id, vendor_id")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (idempotencyLookupError) {
    console.error("[checkout] idempotency lookup failed:", idempotencyLookupError.message);
    return { error: "We couldn't safely verify this checkout attempt. Please refresh and try again." };
  }
  if (existingOrder) {
    if (existingOrder.customer_id === user.id && existingOrder.vendor_id === currentVendor.id) {
      return { success: true, orderNumber: existingOrder.order_number };
    }
    return { error: "This checkout attempt has already been used. Refresh checkout to start a new order." };
  }

  const lineValidationError = validateCheckoutLines(lines);
  if (lineValidationError) return { error: lineValidationError };
  if (lines.length === 0) return { error: "Your cart is empty." };

  const fullName = String(formData.get("fullName") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const address = String(formData.get("address") ?? "").trim();
  const city = String(formData.get("city") ?? "").trim();
  const province = String(formData.get("province") ?? "").trim();
  const postalCode = String(formData.get("postalCode") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim().slice(0, 500);
  const isGift = formData.get("isGift") === "true";
  const giftMessage = isGift ? String(formData.get("giftMessage") ?? "").trim().slice(0, 300) : "";
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!EMAIL_PATTERN.test(email)) return { error: "Enter a valid email address." };

  if (!fullName || !phone || !email || !address || !city || !province) return { error: "Please fill in all required delivery details." };
  if (!PK_PHONE_PATTERN.test(phone)) return { error: "Enter a valid Pakistani mobile number, e.g. 0300-1234567." };

  const boxSizeLines = lines.filter((l) => (l.source ?? "box_size") === "box_size");
  const variantLines = lines.filter((l) => l.source === "variant");

  const [{ data: boxSizes, error: boxSizesError }, { data: variants, error: variantsError }] = await Promise.all([
    boxSizeLines.length > 0
      ? supabase.from("product_box_sizes").select("id, box_size_kg, selling_price, stock_qty, active, product:products(id, name, vendor_id, status, product_type, attributes)").in("id", boxSizeLines.map((l) => l.unitId))
      : Promise.resolve({ data: [], error: null }),
    variantLines.length > 0
      ? supabase.from("product_variants").select("id, attributes, label, selling_price, stock_qty, active, product:products(id, name, vendor_id, status, product_type, attributes)").in("id", variantLines.map((l) => l.unitId))
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (boxSizesError || variantsError) return { error: "Something went wrong reading your cart. Please try again." };

  // The generated Supabase relationship type can represent a many-to-one product
  // join as an array. Normalize it once so checkout always handles one product.
  const normalizedBoxSizes = (boxSizes ?? []).map((unit) => ({
    ...unit,
    product: Array.isArray(unit.product) ? unit.product[0] ?? null : unit.product,
  }));
  const normalizedVariants = (variants ?? []).map((unit) => ({
    ...unit,
    product: Array.isArray(unit.product) ? unit.product[0] ?? null : unit.product,
  }));

  // Reject the entire submission if even one submitted unit disappeared or
  // was invalid. Without this check, the loops below silently omit unresolved
  // IDs and can create an order for only part of the customer's cart.
  const resolvedUnits = [
    ...normalizedBoxSizes.map((unit) => ({
      id: unit.id,
      source: "box_size" as const,
      vendorId: unit.product?.vendor_id ?? null,
    })),
    ...normalizedVariants.map((unit) => ({
      id: unit.id,
      source: "variant" as const,
      vendorId: unit.product?.vendor_id ?? null,
    })),
  ];
  const unresolvedLineError = validateCheckoutLines(lines, resolvedUnits, currentVendor.id);
  if (unresolvedLineError) return { error: unresolvedLineError };

  const qtyByUnit = new Map(lines.map((l) => [l.unitId, l.qty]));
  const addonsByUnit = new Map(lines.map((l) => [l.unitId, l.addonSelections]));
  const orderItems: OrderItem[] = [];
  let subtotal = 0;
  let vendorId: string | null = null;

  for (const box of normalizedBoxSizes) {
    const qty = qtyByUnit.get(box.id) ?? 0;
    if (qty <= 0 || !box.active || !box.product || box.product.status !== "published") return { error: "One of the items in your cart is no longer available." };
    if (box.stock_qty < qty) return { error: `Only ${box.stock_qty} left of ${box.product.name} (${box.box_size_kg}kg) -- please adjust the quantity.` };
    const unitPrice = Number(box.selling_price);
    const addonGroups = getAddonGroups(box.product.attributes as Record<string, unknown>);
    const addonSelections = addonsByUnit.get(box.id) ?? {};
    const addonPrice = totalAddonPrice(addonGroups, addonSelections);
    const addonLabel = addonSelectionLabel(addonGroups, addonSelections);
    orderItems.push({
      product_id: box.product.id,
      name: box.product.name,
      variety: box.product.name,
      qty,
      unit_price: unitPrice,
      box_size_kg: Number(box.box_size_kg),
      product_type: box.product.product_type,
      variant_id: box.id,
      variant_source: "box_size",
      variant_label: variantLabel({ kind: "box_size", box_size_kg: Number(box.box_size_kg) }),
      variant_attributes: {
        box_size_kg: Number(box.box_size_kg),
        ...(addonLabel ? { addon_label: addonLabel, addon_price: addonPrice } : {}),
      },
    });
    subtotal += unitPrice * qty + addonPrice;
    if (vendorId && vendorId !== box.product.vendor_id) return { error: "Your cart contains products from different stores. Please check out one store at a time." };
    vendorId = box.product.vendor_id;
  }

  for (const variant of normalizedVariants) {
    const qty = qtyByUnit.get(variant.id) ?? 0;
    if (qty <= 0 || !variant.active || !variant.product || variant.product.status !== "published") return { error: "One of the items in your cart is no longer available." };
    const label = variantLabel({ kind: "variant", attributes: (variant.attributes ?? {}) as Record<string, string>, label: variant.label });
    if (variant.stock_qty < qty) return { error: `Only ${variant.stock_qty} left of ${variant.product.name} (${label}) -- please adjust the quantity.` };
    const unitPrice = Number(variant.selling_price);
    const addonGroups = getAddonGroups(variant.product.attributes as Record<string, unknown>);
    const addonSelections = addonsByUnit.get(variant.id) ?? {};
    const addonPrice = totalAddonPrice(addonGroups, addonSelections);
    const addonLabel = addonSelectionLabel(addonGroups, addonSelections);
    orderItems.push({
      product_id: variant.product.id,
      name: variant.product.name,
      variety: variant.product.name,
      qty,
      unit_price: unitPrice,
      product_type: variant.product.product_type,
      variant_id: variant.id,
      variant_source: "variant",
      variant_label: label,
      variant_attributes: {
        ...((variant.attributes ?? {}) as Record<string, string>),
        ...(addonLabel ? { addon_label: addonLabel, addon_price: addonPrice } : {}),
      },
    });
    subtotal += unitPrice * qty + addonPrice;
    if (vendorId && vendorId !== variant.product.vendor_id) return { error: "Your cart contains products from different stores. Please check out one store at a time." };
    vendorId = variant.product.vendor_id;
  }

  if (!vendorId) return { error: "Something went wrong. Please try again." };

  const { error: scopeError } = await supabase.rpc("ensure_customer_vendor", { p_vendor_id: vendorId });
  if (scopeError) return { error: "This customer account belongs to another store. Please sign in with the account used for this store." };

  let shippingFee = await getShippingRateServer(supabase, province, city);
  const couponCode = String(formData.get("couponCode") ?? "").trim();
  const useWelcomeDiscount = String(formData.get("useWelcomeDiscount") ?? "") === "true";
  let discountAmount = 0;
  let appliedCouponCode: string | null = null;
  let welcomeDiscountGranted = false;

  if (useWelcomeDiscount) {
    const { data: claimData } = await supabase.rpc("claim_welcome_discount").single();
    const claimResult = claimData as { discount_percent?: number | string | null } | null;
    if (claimResult?.discount_percent) {
      discountAmount = Math.round((subtotal * Number(claimResult.discount_percent)) / 100);
      welcomeDiscountGranted = true;
      appliedCouponCode = "WELCOME";
    }
  } else if (couponCode) {
    const { data: couponData } = await supabase.rpc("validate_coupon", { p_code: couponCode, p_order_amount: subtotal, p_vendor_id: vendorId, p_customer_id: user.id }).single();
    const couponResult = couponData as { valid?: boolean; discount_type?: string; discount_value?: number | string } | null;
    if (couponResult?.valid) {
      appliedCouponCode = couponCode.toUpperCase();
      const result = computeDiscount(couponResult.discount_type, Number(couponResult.discount_value), subtotal, shippingFee);
      discountAmount = result.discountAmount;
      shippingFee = result.shippingFee;
    }
  }

  const total = computeOrderTotal(subtotal, shippingFee, discountAmount);
  const requestedMethod = String(formData.get("paymentMethod") ?? "cod");
  const requestedAccountId = String(formData.get("paymentAccountId") ?? "").trim();
  let paymentMethod = "cod";
  let paymentAccountId: string | null = null;

  // A vendor can turn COD off from Settings -- re-check server-side rather
  // than trusting the client hid the option, since this form field isn't
  // otherwise validated against anything.
  if (requestedMethod === "cod") {
    // business_settings itself is admin-only RLS -- public_business_settings
    // is the customer-facing view (same pattern used by shipping-server.ts).
    const { data: settings } = await supabase.from("public_business_settings").select("cod_enabled").eq("vendor_id", vendorId).maybeSingle();
    if (settings && settings.cod_enabled === false) return { error: "Cash on Delivery isn't available for this store. Please choose another payment method." };
  }

  if (["bank", "easypaisa", "jazzcash"].includes(requestedMethod) && requestedAccountId) {
    const { data: account } = await supabase.from("payment_accounts").select("id, method").eq("id", requestedAccountId).eq("vendor_id", vendorId).eq("active", true).maybeSingle();
    if (account && account.method === requestedMethod) {
      paymentMethod = requestedMethod;
      paymentAccountId = account.id;
    }
  }

  // Direct browser-role inserts to public.orders are disabled by the
  // accompanying migration. Only this validated server action may create a
  // customer order, using the server-only service-role client after all
  // tenant, price, payment, and delivery checks have completed.
  const adminClient = createAdminClient();
  const { data: order, error: insertError } = await adminClient
    .from("orders")
    .insert({
      customer_id: user.id,
      vendor_id: vendorId,
      idempotency_key: idempotencyKey,
      items: orderItems,
      delivery: { full_name: fullName, phone, email, address, city, postal_code: postalCode || null, notes: notes || null },
      subtotal,
      shipping_fee: shippingFee,
      discount_code: appliedCouponCode,
      discount_amount: discountAmount,
      total,
      payment_method: paymentMethod,
      payment_account_id: paymentAccountId,
      is_gift: isGift,
      gift_message: isGift ? giftMessage || null : null,
    })
    .select("order_number")
    .single();

  if (appliedCouponCode && !welcomeDiscountGranted && !insertError) {
    const { error: incrementError } = await supabase.rpc("increment_coupon_usage", { p_code: appliedCouponCode });
    // Non-fatal to the order (already placed), but a silently-discarded
    // failure here means the coupon's usage_count drifts from reality with
    // no trace -- log it so it's at least visible in server logs.
    if (incrementError) console.error(`increment_coupon_usage failed for ${appliedCouponCode} (order ${order?.order_number}):`, incrementError.message);
  }
  if (insertError?.code === "23505") {
    // Two requests with the same form token can race past the initial lookup.
    // The unique database index elects one winner; return its order without
    // re-running email/coupon/stock side effects in the losing request.
    const { data: retryOrder, error: retryLookupError } = await supabase
      .from("orders")
      .select("order_number, customer_id, vendor_id, discount_code")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (!retryLookupError && retryOrder &&
        retryOrder.customer_id === user.id &&
        retryOrder.vendor_id === vendorId) {
      if (welcomeDiscountGranted && retryOrder.discount_code !== "WELCOME") {
        await supabase.rpc("unclaim_welcome_discount");
      }
      return { success: true, orderNumber: retryOrder.order_number };
    }
  }
  if (insertError || !order) {
    // claim_welcome_discount() above already burned the one-time discount
    // (welcome_discount_claimed_at is set the moment it's called, not on
    // order success) -- if the order itself then failed to insert, the
    // customer would otherwise lose their welcome discount for nothing.
    if (welcomeDiscountGranted) await supabase.rpc("unclaim_welcome_discount");
    return { error: `Something went wrong placing your order${insertError?.message ? `: ${insertError.message}` : ". Please try again."}` };
  }

  const { data: existingAddress } = await supabase.from("addresses").select("id").eq("profile_id", user.id).eq("address", address).eq("city", city).maybeSingle();
  if (!existingAddress) {
    await supabase.from("addresses").insert({ profile_id: user.id, label: "Delivery Address", address, city, province, postal_code: postalCode || null, phone, is_default: false });
  }

  // Previously gated on user.email, which is always undefined for a guest's
  // anonymous session -- guests never got a confirmation email at all. The
  // email collected on this form is now always present regardless of
  // account status.
  // Fired via after() rather than awaited -- a slow/unreachable SMTP server
  // must never stall the "Placing Order..." UI the customer is staring at,
  // since the order itself has already succeeded by this point.
  // Resolve the owning vendor's notification address from trusted database records.
  const [{ data: vendor }, { data: vendorOwner }] = await Promise.all([
    adminClient.from("vendors").select("name, contact_email, email, subdomain").eq("id", vendorId).maybeSingle(),
    adminClient.from("vendor_admins").select("email").eq("vendor_id", vendorId).eq("role", "owner").limit(1).maybeSingle(),
  ]);
  const vendorEmail = vendor?.contact_email || vendor?.email || vendorOwner?.email || null;
  const itemsSummary = orderItems.map((i) => `${i.qty}x ${i.name} (${getOrderItemVariantLabel(i)})`).join(", ");

  after(async () => {
    await sendOrderConfirmationEmail({ to: email, orderNumber: order.order_number, items: orderItems, subtotal, shippingFee, discountAmount, total, fullName, address, city, paymentMethod });
    await sendWhatsAppOrderUpdate({
      phone,
      orderNumber: order.order_number,
      status: "Order received",
      vendorName: vendor?.name || "Nashemann",
    });
    if (vendorEmail) {
      await sendVendorNewOrderEmail({ to: vendorEmail, orderNumber: order.order_number, total, customerName: fullName, customerPhone: phone, address, city, itemsSummary, vendorAdminUrl: vendor?.subdomain ? `https://admin.${vendor.subdomain}.nashemann.store/admin/orders` : "https://admin.nashemann.store/admin/orders" });
    } else {
      console.warn(`[email] No vendor notification address found for order ${order.order_number} (vendor ${vendorId}).`);
    }
    if (ADMIN_ALERT_EMAIL) await sendAdminNewOrderAlert({ to: ADMIN_ALERT_EMAIL, orderNumber: order.order_number, total, customerName: fullName, itemsSummary });
  });

  return { success: true, orderNumber: order.order_number };
}
