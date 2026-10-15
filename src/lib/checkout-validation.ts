export type CheckoutLineInput = {
  unitId: string;
  source?: "box_size" | "variant";
  qty: number;
};

export type ResolvedCheckoutUnit = {
  id: string;
  source: "box_size" | "variant";
  vendorId: string | null;
};

function sourceFor(line: CheckoutLineInput): "box_size" | "variant" | null {
  if (line.source === undefined || line.source === "box_size") return "box_size";
  if (line.source === "variant") return "variant";
  return null;
}

/**
 * Validate untrusted checkout lines and, when supplied, prove every submitted
 * line resolved to a current database unit before creating an order.
 */
export function validateCheckoutLines(
  lines: readonly CheckoutLineInput[],
  resolvedUnits?: readonly ResolvedCheckoutUnit[],
  expectedVendorId?: string
): string | null {
  if (!Array.isArray(lines) || lines.length === 0) return "Your cart is empty.";

  const submittedKeys = new Set<string>();
  for (const line of lines) {
    if (!line || typeof line.unitId !== "string" || line.unitId.trim() === "") {
      return "One of the items in your cart is invalid. Please refresh your cart.";
    }
    const source = sourceFor(line);
    if (!source || !Number.isSafeInteger(line.qty) || line.qty <= 0) {
      return "One of the items in your cart has an invalid quantity or option. Please review your cart.";
    }
    const key = `${source}:${line.unitId}`;
    if (submittedKeys.has(key)) {
      return "Your cart contains a duplicate item. Please refresh your cart and try again.";
    }
    submittedKeys.add(key);
  }

  if (resolvedUnits) {
    const resolvedKeys = new Set(
      resolvedUnits.map((unit) => `${unit.source}:${unit.id}`)
    );
    for (const key of submittedKeys) {
      if (!resolvedKeys.has(key)) {
        return "One of the items in your cart is no longer available. Please refresh your cart.";
      }
    }
    if (expectedVendorId) {
      for (const unit of resolvedUnits) {
        if (submittedKeys.has(`${unit.source}:${unit.id}`) && unit.vendorId !== expectedVendorId) {
          return "This item belongs to another store. Please remove it from your cart and try again.";
        }
      }
    }
  }

  return null;
}
