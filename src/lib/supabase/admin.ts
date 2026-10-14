import "server-only";
import { createClient } from "@supabase/supabase-js";

let adminClient: ReturnType<typeof createClient<any>> | null = null;

/** Server-only client for trusted cross-vendor lookups and Auth metadata updates. */
export function createAdminClient() {
  if (adminClient) return adminClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for trusted server-side operations.");
  }
  adminClient = createClient<any>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  return adminClient;
}
