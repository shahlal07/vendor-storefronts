const CHECKOUT_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Accept only an opaque UUIDv4 generated for the current checkout form. */
export function isCheckoutIdempotencyToken(value: unknown): value is string {
  return typeof value === "string" && CHECKOUT_TOKEN_PATTERN.test(value.trim());
}

/**
 * Scope browser-supplied retries to the authenticated/anonymous Supabase user.
 * The raw token is not authority by itself and cannot collide across customers.
 */
export function scopedOrderIdempotencyKey(customerId: string, token: unknown): string | null {
  if (!customerId || !isCheckoutIdempotencyToken(token)) return null;
  return `${customerId}:${token.trim().toLowerCase()}`;
}
