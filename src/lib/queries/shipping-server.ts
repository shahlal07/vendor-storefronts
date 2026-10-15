import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getCurrentVendor } from "@/lib/tenant";

export async function getShippingRateServer(
  supabase: SupabaseClient,
  province: string,
  city: string
): Promise<number> {
  const vendor = await getCurrentVendor();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- The checked-in Database type predates the live tenant-scoped schema.
  const query = supabase.from("shipping_zones") as any;
  const { data } = await query
    .select("city, rate")
    .eq("vendor_id", vendor.id)
    .eq("province", province)
    .eq("active", true);

  if (!data || data.length === 0) return 250;
  const cityMatch = data.find((z: { city: string | null; rate: number }) => z.city?.toLowerCase() === city.trim().toLowerCase());
  if (cityMatch) return Number(cityMatch.rate);
  const provinceDefault = data.find((z: { city: string | null; rate: number }) => z.city === null);
  return provinceDefault ? Number(provinceDefault.rate) : 250;
}

export async function getDeliveryCoverage(): Promise<Record<string, string[]>> {
  const supabase = await createClient();
  const vendor = await getCurrentVendor();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- The checked-in Database type predates the live tenant-scoped schema.
  const query = supabase.from("shipping_zones") as any;
  const { data } = await query
    .select("province, city")
    .eq("vendor_id", vendor.id)
    .eq("active", true)
    .not("city", "is", null)
    .order("province", { ascending: true });

  const byProvince: Record<string, string[]> = {};
  for (const zone of (data ?? []) as { province: string; city: string | null }[]) {
    if (!zone.city) continue;
    (byProvince[zone.province] ??= []).push(zone.city);
  }
  return byProvince;
}
