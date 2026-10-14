import "server-only";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentVendor, isPlatformHost } from "@/lib/tenant";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { sendCustomerWelcomeEmail } from "@/lib/email";

/**
 * Everything that must happen after a session exists, regardless of HOW the
 * customer signed in (Google OAuth code exchange, or email+password).
 *
 * Both paths need it, so it lives here rather than only inside
 * /auth/callback -- an email sign-in that skipped the vendor binding would
 * leave a customer whose profile isn't scoped to this store, which then
 * fails confusingly later at checkout instead of here at sign-in.
 */
export async function finishSignIn(
  supabase: SupabaseClient,
  origin: string,
  host: string | null,
  returnTo: string
): Promise<NextResponse> {
  if (!isPlatformHost(host)) {
    const vendor = await getCurrentVendor();
    const { error: scopeError } = await supabase.rpc("ensure_customer_vendor", { p_vendor_id: vendor.id });
    if (scopeError) {
      await supabase.auth.signOut();
      return NextResponse.redirect(`${origin}/login?error=account_belongs_to_another_store`);
    }
  }

  // Google OAuth never supplies a phone number, and email signup doesn't
  // ask for one either -- the store needs one on file for delivery, so gate
  // any not-yet-completed account through the one-time completion step
  // rather than asking again at every login.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    const { data: profile } = await supabase.from("profiles").select("phone, name").eq("id", user.id).maybeSingle();

    // Send a one-time welcome only for newly created accounts. A server-only
    // app_metadata marker prevents repeats across subsequent logins/callbacks.
    const appMetadata = (user.app_metadata ?? {}) as Record<string, unknown>;
    if (!appMetadata.nashemann_welcome_email_sent_at && !appMetadata.nashemann_welcome_email_skipped) {
      const ageMs = Date.now() - new Date(user.created_at).getTime();
      const isNewAccount = Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000;
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      if (serviceRoleKey && supabaseUrl && user.email) {
        const admin = createSupabaseClient(supabaseUrl, serviceRoleKey, {
          auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
        });
        if (isNewAccount) {
          const sent = await sendCustomerWelcomeEmail({
            to: user.email,
            name: profile?.name ?? String(user.user_metadata?.name ?? "there"),
          });
          if (sent) {
            const { error: metadataError } = await admin.auth.admin.updateUserById(user.id, {
              app_metadata: { ...appMetadata, nashemann_welcome_email_sent_at: new Date().toISOString() },
            });
            if (metadataError) console.error("[email] Welcome sent but idempotency marker failed:", metadataError.message);
          }
        } else {
          await admin.auth.admin.updateUserById(user.id, {
            app_metadata: { ...appMetadata, nashemann_welcome_email_skipped: true },
          });
        }
      }
    }

    if (!profile?.phone) {
      return NextResponse.redirect(`${origin}/complete-profile?returnTo=${encodeURIComponent(returnTo)}`);
    }
  }

  return NextResponse.redirect(`${origin}${returnTo}`);
}
