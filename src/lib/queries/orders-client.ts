import { createClient } from "@/lib/supabase/client";

export async function getOrderByNumberClient(orderNumber: string) {
  const supabase = createClient();
  const { data } = await supabase
    .from("orders")
    .select("*")
    .eq("order_number", orderNumber)
    .maybeSingle();
  return data;
}

/**
 * Tracking without an account: bypasses RLS via a security-definer RPC that
 * only matches when both the order number AND a contact value (the email
 * OR the phone number captured at checkout, either works) are supplied --
 * lets a guest track an order even after losing the session (real or
 * anonymous) they checked out with. Phone comparison is digit-normalized
 * server-side, so "+92 321 9876543" and "03219876543" both match.
 * vendorId scopes the match to this storefront's own vendor -- the RPC runs
 * with elevated privilege and would otherwise match another vendor's order
 * placed with the same phone/email (a real cross-vendor leak, found and
 * fixed alongside the multi-order change below).
 */
export async function getOrderByNumberAndContactClient(orderNumber: string, contact: string, vendorId: string) {
  const supabase = createClient();
  const { data } = await supabase.rpc("find_order_by_number_and_contact", {
    p_order_number: orderNumber,
    p_contact: contact,
    p_vendor_id: vendorId,
  });
  return data?.[0] ?? null;
}
