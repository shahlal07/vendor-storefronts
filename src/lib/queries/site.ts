import { createClient } from "@/lib/supabase/server";
import { getCurrentVendor } from "@/lib/tenant";

export async function getSiteChrome() {
  const supabase = await createClient();
  const vendor = await getCurrentVendor();

  // Live schema contains vendor_id; checked-in generated types are older.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- The checked-in Database type predates the live tenant-scoped schema.
  const query = supabase.from("public_business_settings") as any;
  const { data: settings } = await query
    .select("*")
    .eq("vendor_id", vendor.id)
    .maybeSingle();

  return { vendor, settings };
}
