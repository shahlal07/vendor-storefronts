import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type RetryRow = {
  id: string;
  order_number: string;
  event_type: string;
  recipient_phone: string;
  template_name: string;
  template_language: string;
  payload: {
    orderNumber?: string;
    status?: string;
    courierName?: string;
    trackingNumber?: string;
    vendorName?: string;
  };
  attempts: number;
};

function retryTime(attempts: number): string {
  const delayMs = Math.min(6 * 60 * 60 * 1000, 30_000 * 2 ** Math.min(attempts, 10));
  return new Date(Date.now() + delayMs).toISOString();
}

async function handle(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization");
  if (!secret || authorization !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    return NextResponse.json({ error: "WhatsApp Cloud API is not configured" }, { status: 503 });
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("claim_whatsapp_notification_retries", { p_batch_size: 20 });
  if (error) {
    console.error("[whatsapp-retry] Could not claim outbox rows:", error.message);
    return NextResponse.json({ error: "Could not claim retry rows" }, { status: 500 });
  }

  const rows = (data ?? []) as RetryRow[];
  let accepted = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const payload = row.payload ?? {};
      const response = await fetch(`https://graph.facebook.com/v23.0/${encodeURIComponent(phoneNumberId)}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: row.recipient_phone,
          type: "template",
          template: {
            name: row.template_name,
            language: { code: row.template_language || "en" },
            components: [{ type: "body", parameters: [
              { type: "text", text: String(payload.orderNumber ?? row.order_number) },
              { type: "text", text: String(payload.status ?? "Order update") },
              { type: "text", text: String(payload.courierName ?? "Not assigned") },
              { type: "text", text: String(payload.trackingNumber ?? "Not available") },
              { type: "text", text: String(payload.vendorName ?? "Nashemann") },
            ] }],
          },
        }),
        cache: "no-store",
      });
      const responseText = await response.text();
      let messageId: string | null = null;
      let errorText = responseText.slice(0, 1000);
      if (response.ok) {
        try {
          messageId = (JSON.parse(responseText) as { messages?: Array<{ id?: string }> }).messages?.[0]?.id ?? null;
        } catch {
          errorText = "Meta returned an unreadable success response";
        }
        if (!messageId) errorText = "Meta returned no message ID";
      }

      if (response.ok && messageId) {
        const { error: saveError } = await supabase.from("whatsapp_notification_outbox").update({
          state: "accepted",
          provider_message_id: messageId,
          provider_status: "accepted",
          accepted_at: new Date().toISOString(),
          last_error: null,
          next_attempt_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", row.id).eq("state", "sending");
        if (saveError) {
          console.error("[whatsapp-retry] Accepted message but failed to save provider ID:", saveError.message);
          failed++;
        } else accepted++;
        continue;
      }

      const { error: saveError } = await supabase.from("whatsapp_notification_outbox").update({
        state: "failed",
        provider_status: `http_${response.status}`,
        last_error: `HTTP ${response.status}: ${errorText}`.slice(0, 1000),
        next_attempt_at: retryTime(row.attempts),
        updated_at: new Date().toISOString(),
      }).eq("id", row.id).eq("state", "sending");
      if (saveError) console.error("[whatsapp-retry] Could not persist provider failure:", saveError.message);
      failed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      const { error: saveError } = await supabase.from("whatsapp_notification_outbox").update({
        state: "failed",
        provider_status: "network_error",
        last_error: message.slice(0, 1000),
        next_attempt_at: retryTime(row.attempts),
        updated_at: new Date().toISOString(),
      }).eq("id", row.id).eq("state", "sending");
      if (saveError) console.error("[whatsapp-retry] Could not persist network failure:", saveError.message);
      failed++;
    }
  }

  return NextResponse.json({ claimed: rows.length, accepted, failed, maxAttempts: 6 });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
