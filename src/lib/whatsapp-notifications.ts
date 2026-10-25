/**
 * Optional WhatsApp Cloud API adapter for order notifications.
 * Configure WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN,
 * WHATSAPP_ORDER_TEMPLATE_NAME and optionally WHATSAPP_TEMPLATE_LANGUAGE.
 * Approved template must have five BODY parameters: order number, status,
 * courier, tracking number, vendor/store name.
 */
type WhatsAppOrderUpdate = {
  phone: string | null | undefined;
  orderNumber: string;
  status: string;
  courierName?: string | null;
  trackingNumber?: string | null;
  vendorName?: string | null;
};

function normalizeWhatsAppPhone(value: string): string | null {
  let phone = value.replace(/[^\d+]/g, "");
  if (phone.startsWith("+")) phone = phone.slice(1);
  if (phone.startsWith("00")) phone = phone.slice(2);
  if (phone.startsWith("0")) phone = "92" + phone.slice(1);
  if (phone.startsWith("3") && phone.length === 10) phone = "92" + phone;
  return /^\d{8,15}$/.test(phone) ? phone : null;
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
  try {
    const response = await fetch(`https://graph.facebook.com/v23.0/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", recipient_type: "individual", to, type: "template",
        template: {
          name: templateName,
          language: { code: process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en" },
          components: [{ type: "body", parameters: [
            { type: "text", text: update.orderNumber },
            { type: "text", text: update.status },
            { type: "text", text: update.courierName || "Not assigned" },
            { type: "text", text: update.trackingNumber || "Not available" },
            { type: "text", text: update.vendorName || "Nashemann" },
          ] }],
        },
      }),
      cache: "no-store",
    });
    if (!response.ok) console.error(`[whatsapp] Provider rejected order ${update.orderNumber} (${response.status}): ${(await response.text()).slice(0, 1000)}`);
  } catch (error) {
    console.error(`[whatsapp] Network error for order ${update.orderNumber}:`, error);
  }
}
