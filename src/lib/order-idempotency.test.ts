import { describe, expect, it } from "vitest";
import { isCheckoutIdempotencyToken, scopedOrderIdempotencyKey } from "./order-idempotency";

describe("checkout idempotency", () => {
  it("accepts an opaque UUIDv4 token", () => {
    expect(isCheckoutIdempotencyToken("a6c1c1f1-6e90-4ab2-9d94-b7a5ec96b33e")).toBe(true);
  });

  it.each([null, undefined, "", "123", "customer:order", "a6c1c1f1-6e90-4ab2-9d94-b7a5ec96b33g"])(
    "rejects an invalid token (%s)",
    (token) => {
      expect(isCheckoutIdempotencyToken(token)).toBe(false);
      expect(scopedOrderIdempotencyKey("customer-1", token)).toBeNull();
    }
  );

  it("scopes the same token to different customers", () => {
    const token = "a6c1c1f1-6e90-4ab2-9d94-b7a5ec96b33e";
    expect(scopedOrderIdempotencyKey("customer-a", token)).toBe("customer-a:a6c1c1f1-6e90-4ab2-9d94-b7a5ec96b33e");
    expect(scopedOrderIdempotencyKey("customer-b", token)).not.toBe(scopedOrderIdempotencyKey("customer-a", token));
  });

  it("normalizes valid tokens consistently", () => {
    expect(scopedOrderIdempotencyKey("customer-a", "A6C1C1F1-6E90-4AB2-9D94-B7A5EC96B33E"))
      .toBe("customer-a:a6c1c1f1-6e90-4ab2-9d94-b7a5ec96b33e");
  });
});
