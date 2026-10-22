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
