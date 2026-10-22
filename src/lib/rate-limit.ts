import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

type RateLimitOptions = {
  maxAttempts: number;
  windowMinutes: number;
  lockMinutes: number;
};

type RateLimitResult = { allowed: boolean; retryAfter: string | null };

// This helper is server-only. The underlying SECURITY DEFINER RPC mutates a
// private rate-limit table, so it must never be callable directly by anon or
// authenticated API clients. Use the service-role client only from trusted
// server routes/actions and keep bucket/limits defined by server code.
export async function checkRateLimit(
  bucket: string,
  identifier: string,
  { maxAttempts, windowMinutes, lockMinutes }: RateLimitOptions
): Promise<RateLimitResult> {
  const supabase = createAdminClient();
  const result = await supabase.rpc("check_and_record_rate_limit", {
    p_bucket: bucket,
    p_identifier: identifier,
    p_max_attempts: maxAttempts,
    p_window_minutes: windowMinutes,
    p_lock_minutes: lockMinutes,
  });
  const data = result.data as { allowed: boolean; retry_after: string | null }[] | null;
  const row = data?.[0];
  const error = result.error;

  return {
    allowed: !error && row?.allowed === true,
    retryAfter: row?.retry_after ?? null,
  };
}

// Same x-forwarded-for/x-real-ip extraction checkCoupon() already uses,
// factored out for the new anonymous-caller rate-limited routes.
export function getRequestIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}
