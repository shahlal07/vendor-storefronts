import { describe, expect, it } from "vitest";
import { validateCheckoutLines } from "./checkout-validation";

describe("validateCheckoutLines", () => {
  it("accepts valid box-size and variant lines", () => {
    expect(
      validateCheckoutLines([
        { unitId: "box-1", qty: 2 },
        { unitId: "variant-1", source: "variant", qty: 1 },
      ])
    ).toBeNull();
  });

  it("rejects an empty cart", () => {
    expect(validateCheckoutLines([])).toBe("Your cart is empty.");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid quantity %s",
    (qty) => {
      expect(validateCheckoutLines([{ unitId: "box-1", qty }])).toContain("invalid quantity");
    }
  );

  it("rejects missing identifiers", () => {
    expect(validateCheckoutLines([{ unitId: " ", qty: 1 }])).toContain("invalid. Please refresh");
  });

  it("rejects duplicate lines instead of allowing map overwrite to change quantity", () => {
    expect(
      validateCheckoutLines([
        { unitId: "box-1", qty: 1 },
        { unitId: "box-1", qty: 4 },
      ])
    ).toContain("duplicate item");
  });

  it("rejects a cart if any submitted unit did not resolve from the database", () => {
    expect(
      validateCheckoutLines(
        [
          { unitId: "box-1", qty: 1 },
          { unitId: "deleted-box", qty: 1 },
        ],
        [{ id: "box-1", source: "box_size", vendorId: "vendor-a" }]
      )
    ).toContain("no longer available");
  });

  it("rejects a resolved item owned by a different storefront vendor", () => {
    expect(
      validateCheckoutLines(
        [{ unitId: "foreign-box", qty: 1 }],
        [{ id: "foreign-box", source: "box_size", vendorId: "vendor-b" }],
        "vendor-a"
      )
    ).toContain("belongs to another store");
  });

  it("matches a variant only to a resolved variant, not a box size with the same ID", () => {
    expect(
      validateCheckoutLines(
        [{ unitId: "same-id", source: "variant", qty: 1 }],
        [{ id: "same-id", source: "box_size", vendorId: "vendor-a" }]
      )
    ).toContain("no longer available");
  });
});
