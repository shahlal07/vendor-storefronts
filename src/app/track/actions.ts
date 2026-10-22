"use server";

import { after } from "next/server";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentVendor } from "@/lib/tenant";
import type { Tables } from "@/lib/supabase/types";
import { sendAdminPaymentProofAlert, sendVendorPaymentProofAlert, ADMIN_ALERT_EMAIL } from "@/lib/email";

export type UploadProofState = { error: string } | { success: true } | undefined;

export type TrackedOrder = Pick<
  Tables<"orders">,
  | "id"
  | "order_number"
  | "items"
  | "delivery"
  | "status"
  | "created_at"
  | "tracking_number"
  | "courier_name"
  | "payment_method"
  | "payment_status"
  | "payment_account_id"
  | "payment_rejection_reason"
  | "total"
  | "vendor_id"
>;

/**
 * Guest lookup is deliberately server-side: it rate-limits by request IP,
 * resolves the tenant from the request hostname, and returns only the fields
 * required by the tracking UI. Direct client execution of the underlying
 * SECURITY DEFINER RPC is revoked by the accompanying migration.
 */
export async function lookupGuestOrder(orderNumber: string, contact: string): Promise<TrackedOrder | null> {
  const normalizedOrderNumber = orderNumber.trim().toUpperCase();
  const normalizedContact = contact.trim();
  if (!/^(?:ORD|TAG)-\d{4,}$/i.test(normalizedOrderNumber) || normalizedContact.length < 5 || normalizedContact.length > 254) {
    return null;
  }

  const requestHeaders = await headers();
  const identifier =
    requestHeaders.get("x-real-ip")?.trim() ||
    requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";

  const admin = createAdminClient();
  const limitResult = await admin.rpc("check_and_record_rate_limit", {
    p_bucket: "order_lookup",
    p_identifier: identifier,
    p_max_attempts: 20,
    p_window_minutes: 10,
    p_lock_minutes: 15,
  });
  const limitRows = limitResult.data as { allowed: boolean; retry_after: string | null }[] | null;
  if (limitResult.error || limitRows?.[0]?.allowed !== true) return null;

  let vendor;
  try {
    vendor = await getCurrentVendor();
  } catch {
    return null;
  }

  const lookupResult = await admin.rpc("find_order_by_number_and_contact", {
    p_order_number: normalizedOrderNumber,
    p_contact: normalizedContact,
    p_vendor_id: vendor.id,
  });
  if (lookupResult.error) return null;

  const row = (lookupResult.data as unknown as TrackedOrder[] | null)?.[0];
  if (!row) return null;

  // Explicit allowlist: never send cost snapshots, customer IDs, payment proof
  // paths, or other internal order columns to a guest tracking response.
  return {
    id: row.id,
    order_number: row.order_number,
    items: row.items,
    delivery: row.delivery,
    status: row.status,
    created_at: row.created_at,
    tracking_number: row.tracking_number,
    courier_name: row.courier_name,
    payment_method: row.payment_method,
    payment_status: row.payment_status,
    payment_account_id: row.payment_account_id,
    payment_rejection_reason: row.payment_rejection_reason,
    total: row.total,
    vendor_id: row.vendor_id,
  };
}

const MAX_PROOF_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

export async function uploadPaymentProof(
  _prev: UploadProofState,
  formData: FormData
): Promise<UploadProofState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Please sign in to upload your payment proof." };

  const orderNumber = String(formData.get("orderNumber") ?? "").trim();
  const file = formData.get("proof");

  if (!orderNumber) return { error: "Missing order number." };
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Please choose a screenshot or PDF receipt to upload." };
  }
  if (file.size > MAX_PROOF_BYTES) {
    return { error: "That file is too large — please keep it under 5MB." };
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    return { error: "Please upload a JPG, PNG, WebP or PDF file." };
  }

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "jpg";
  // Folder-per-user path, matching the review-images convention -- the
  // storage RLS policy keys off this first segment being the caller's uid.
  const path = `${user.id}/${orderNumber}-${crypto.randomUUID()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from("payment-proofs")
    .upload(path, file, { contentType: file.type });

  if (uploadError) {
    return { error: "Couldn't upload that file. Please try again." };
  }

  // Customers have no UPDATE policy on orders by design -- this RPC is the
  // only path, and it can only touch the payment-proof columns of an order
  // they own that isn't already verified.
  const { error: rpcError } = await supabase.rpc("attach_payment_proof", {
    p_order_number: orderNumber,
    p_proof_path: path,
  });

  if (rpcError) {
    return { error: "Couldn't attach that proof to your order. Please contact us on WhatsApp." };
  }

  // Notify the owning vendor from trusted order/vendor records, not a client-supplied address.
  const { data: order } = await supabase
    .from("orders")
    .select("total, vendor_id, customer_id, delivery")
    .eq("order_number", orderNumber)
    .maybeSingle();
  if (order?.vendor_id) {
    const adminClient = createAdminClient();
    const [{ data: vendor }, { data: owner }, { data: customer }] = await Promise.all([
      adminClient.from("vendors").select("name, contact_email, email, subdomain").eq("id", order.vendor_id).maybeSingle(),
      adminClient.from("vendor_admins").select("email").eq("vendor_id", order.vendor_id).eq("role", "owner").limit(1).maybeSingle(),
      supabase.from("profiles").select("email").eq("id", order.customer_id).maybeSingle(),
    ]);
    const vendorEmail = vendor?.contact_email || vendor?.email || owner?.email;
    if (vendorEmail) {
      after(() => sendVendorPaymentProofAlert({
        to: vendorEmail,
        orderNumber,
        total: Number(order.total ?? 0),
        customerEmail: customer?.email ?? (order.delivery as { email?: string } | null)?.email ?? "Customer",
        vendorAdminUrl: vendor?.subdomain ? `https://admin.${vendor.subdomain}.nashemann.store/admin/orders` : "https://admin.nashemann.store/admin/orders",
      }));
    } else {
      console.warn(`[email] Payment proof saved for order ${orderNumber}, but no vendor email is configured.`);
    }
  }

  if (ADMIN_ALERT_EMAIL) {
    const adminAlertEmail = ADMIN_ALERT_EMAIL;
    after(() => sendAdminPaymentProofAlert({ to: adminAlertEmail, orderNumber, total: Number(order?.total ?? 0) }));
  }

  return { success: true };
}
