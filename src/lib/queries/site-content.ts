import { createClient } from "@/lib/supabase/server";
import { getCurrentVendor } from "@/lib/tenant";
import { DEFAULT_SITE_CONTENT, mergeSiteContent, type SiteContent } from "@/lib/site-content-defaults";

export type { SiteContent };
export { DEFAULT_SITE_CONTENT, mergeSiteContent };

export async function getSiteContent(): Promise<SiteContent> {
  const supabase = await createClient();
  const vendor = await getCurrentVendor();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- The checked-in Database type predates the live tenant-scoped schema.
  const query = supabase.from("site_content") as any;
  const { data } = await query
    .select("content")
    .eq("vendor_id", vendor.id)
    .maybeSingle();

  return mergeSiteContent(DEFAULT_SITE_CONTENT, data?.content as Partial<SiteContent> | undefined);
}
