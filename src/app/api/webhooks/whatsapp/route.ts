import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function verifySignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  const expectedToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (mode === "subscribe" && expectedToken && token === expectedToken && challenge) {
    return new NextResponse(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return NextResponse.json({ error: "Webhook verification failed" }, { status: 403 });
}

type MetaStatus = {
  id?: string;
  status?: string;
  timestamp?: string;
  errors?: Array<{ title?: string; message?: string; code?: number }>;
};

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  if (!verifySignature(rawBody, request.headers.get("x-hub-signature-256"))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: { entry?: Array<{ changes?: Array<{ value?: { statuses?: MetaStatus[] } }> }> };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const statuses = (payload.entry ?? []).flatMap((entry) =>
    (entry.changes ?? []).flatMap((change) => change.value?.statuses ?? [])
  );
  if (!statuses.length) return NextResponse.json({ received: true });

  let supabase;
  try {
    supabase = createAdminClient();
  } catch (error) {
    console.error("[whatsapp-webhook] Supabase admin client unavailable:", error);
    return NextResponse.json({ error: "Webhook persistence unavailable" }, { status: 500 });
  }

  let persistenceFailed = false;
  for (const status of statuses) {
    if (!status.id || !status.status) continue;
    const normalized = status.status.toLowerCase();
    const state = normalized === "sent" ? "accepted"
      : normalized === "delivered" ? "delivered"
      : normalized === "read" ? "read"
      : normalized === "failed" ? "failed"
      : null;
    if (!state) continue;

    const { data: existing, error: readError } = await supabase
      .from("whatsapp_notification_outbox")
      .select("id, state")
      .eq("provider_message_id", status.id)
      .maybeSingle();
    if (readError) {
      console.error("[whatsapp-webhook] Could not read notification state:", readError.message);
      persistenceFailed = true;
      continue;
    }
    // Unknown provider IDs are safe to ignore (e.g. messages sent outside this app).
    if (!existing) continue;

    // Provider callbacks can arrive out of order. Never downgrade read/delivered
    // to accepted, and don't overwrite a final read state with a later callback.
    const rank: Record<string, number> = { queued: 0, sending: 1, accepted: 2, delivered: 3, read: 4, failed: 4 };
    if ((rank[existing.state] ?? 0) > (rank[state] ?? 0)) continue;
    if (existing.state === "read") continue;

    const now = new Date().toISOString();
    const update: Record<string, unknown> = {
      state, provider_status: normalized, updated_at: now,
      ...(state === "delivered" ? { delivered_at: now } : {}),
      ...(state === "read" ? { read_at: now } : {}),
      ...(state === "failed" ? { last_error: (status.errors ?? []).map((e) => e.message || e.title || String(e.code ?? "provider error")).join("; ").slice(0, 1000) || "Meta reported message failure" } : {}),
    };
    if (state === "accepted") update.accepted_at = now;
    const { error } = await supabase.from("whatsapp_notification_outbox").update(update).eq("id", existing.id);
    if (error) {
      console.error("[whatsapp-webhook] Could not update notification status:", error.message);
      persistenceFailed = true;
    }
  }

  // Return non-2xx on persistence failure so Meta can retry the callback.
  if (persistenceFailed) return NextResponse.json({ error: "Could not persist all statuses" }, { status: 500 });
  return NextResponse.json({ received: true });
}
