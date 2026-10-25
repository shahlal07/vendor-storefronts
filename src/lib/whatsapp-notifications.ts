import "server-only";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Optional WhatsApp Cloud API adapter with a durable server-only outbox.
 * The approved template must have five BODY parameters: order number, status,
 * courier, tracking number, vendor/store name.
 */
type WhatsAppOrderUpdate = {
  phone: string | null | undefined;
  orderNumber: string;
  status: string;
  courierName?: string | null;
  trackingNumber?: string | null;
  vendorName?: string | null;
  eventType?: "order_received" | "order_status" | "tracking_update";
};

function normalizeWhatsAppPhone(value: string): string | null {
  let phone = value.replace(/[^\d+]/g, "");
  if (phone.startsWith("+")) phone = phone.slice(1);
  if (phone.startsWith("00")) phone = phone.slice(2);
  if (phone.startsWith("0")) phone = "92" + phone.slice(1);
  if (phone.startsWith("3") && phone.length === 10) phone = "92" + phone;
  return /^\d{8,15}$/.test(phone) ? phone : null;
}

function retryAt(attempt: number): string {
  const delayMs = Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.min(attempt, 7));
  return new Date(Date.now() + delayMs).toISOString();
}

export async function sendWhatsAppOrderUpdate(update: WhatsAppOrderUpdate): Promise<void> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const templateName = process.env.WHATSAPP_ORDER_TEMPLATE_NAME;
  if (!phoneNumberId || !accessToken || !templateName) {
    console.info("[whatsapp] Not configured; order notification skipped.");
    return;
  }
  if (!update.phone) return;
  const to = normalizeWhatsAppPhone(update.phone);
  if (!to) {
    console.warn(`[whatsapp] Invalid customer phone for order ${update.orderNumber}; skipped.`);
    return;
  }

  const language = process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en";
  const eventType = update.eventType || "order_status";
  const payload = {
    orderNumber: update.orderNumber,
    status: update.status,
    courierName: update.courierName || "Not assigned",
    trackingNumber: update.trackingNumber || "Not available",
    vendorName: update.vendorName || "Nashemann",
  };
  // Hash the normalized content so a repeated server action cannot send the
  // same logical notification twice. Different status/tracking events remain distinct.
  const idempotencyKey = createHash("sha256")
    .update(JSON.stringify({ eventType, to, templateName, language, payload }))
    .digest("hex");

  let supabase;
  let outboxId: string;
  try {
    supabase = createAdminClient();
    const { data: inserted, error: insertError } = await supabase
      .from("whatsapp_notification_outbox")
      .insert({
        idempotency_key: idempotencyKey,
        order_number: update.orderNumber,
        event_type: eventType,
        recipient_phone: to,
        template_name: templateName,
        template_language: language,
        payload,
        state: "sending",
        attempts: 1,
        updated_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (insertError?.code === "23505") {
      // Existing record means this exact logical event was already processed
      // or is in flight; don't risk duplicate delivery.
      return;
    }
    if (insertError || !inserted?.id) {
      console.error("[whatsapp] Could not create outbox record:", insertError?.message);
      return;
    }
    outboxId = inserted.id;
  } catch (error) {
    console.error("[whatsapp] Outbox unavailable; notification not sent:", error);
    return;
  }

  try {
    const response = await fetch(`https://graph.facebook.com/v23.0/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "template",
        template: {
          name: templateName,
          language: { code: language },
          components: [{ type: "body", parameters: [
            { type: "text", text: payload.orderNumber },
            { type: "text", text: payload.status },
            { type: "text", text: payload.courierName },
            { type: "text", text: payload.trackingNumber },
            { type: "text", text: payload.vendorName },
          ] }],
        },
      }),
      cache: "no-store",
    });
    const responseText = await response.text();
    let providerMessageId: string | null = null;
    let providerError = responseText.slice(0, 1000);
    if (response.ok) {
      try {
        const body = JSON.parse(responseText) as { messages?: Array<{ id?: string }> };
        providerMessageId = body.messages?.[0]?.id ?? null;
      } catch {
        providerError = "Meta returned an unreadable success response";
      }
      if (!providerMessageId) providerError = "Meta accepted the request but returned no message ID";
    }

    if (response.ok && providerMessageId) {
      const { error } = await supabase.from("whatsapp_notification_outbox").update({
        state: "accepted",
        provider_message_id: providerMessageId,
        provider_status: "accepted",
        accepted_at: new Date().toISOString(),
        last_error: null,
        next_attempt_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", outboxId);
      if (error) console.error("[whatsapp] Could not persist provider acceptance:", error.message);
      return;
    }

    const { error } = await supabase.from("whatsapp_notification_outbox").update({
      state: "failed",
      provider_status: "failed",
      last_error: `HTTP ${response.status}: ${providerError}`.slice(0, 1000),
      next_attempt_at: retryAt(1),
      updated_at: new Date().toISOString(),
    }).eq("id", outboxId);
    if (error) console.error("[whatsapp] Could not persist provider failure:", error.message);
    console.error(`[whatsapp] Provider rejected order ${update.orderNumber} (HTTP ${response.status}).`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown network error";
    const { error: updateError } = await supabase.from("whatsapp_notification_outbox").update({
      state: "failed",
      provider_status: "network_error",
      last_error: message.slice(0, 1000),
      next_attempt_at: retryAt(1),
      updated_at: new Date().toISOString(),
    }).eq("id", outboxId);
    if (updateError) console.error("[whatsapp] Could not persist network failure:", updateError.message);
    console.error(`[whatsapp] Network error for order ${update.orderNumber}:`, message);
  }
}
