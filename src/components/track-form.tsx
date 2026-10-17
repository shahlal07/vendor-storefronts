"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useUser } from "@/lib/use-user";
import { getOrderByNumberAndContactClient, getOrderByNumberClient } from "@/lib/queries/orders-client";
import { formatPKR } from "@/lib/format";
import { PaymentProofPanel } from "@/components/payment-proof-panel";
import { getOrderItemVariantLabel } from "@/lib/order-item";
import { googleMapsUrl } from "@/lib/maps";
import { orderTrackingWhatsAppLink } from "@/lib/whatsapp";
import { WhatsAppIcon } from "@/components/contact-icons";
import type { Tables } from "@/lib/supabase/types";

const MANUAL_PAYMENT_METHODS = ["bank", "easypaisa", "jazzcash"];

type Order = Tables<"orders">;

const STATUS_STEPS = ["pending", "confirmed", "packed", "shipped", "delivered"] as const;
const STATUS_LABELS: Record<string, string> = {
  pending: "Order Placed",
  confirmed: "Confirmed",
  packed: "Packed",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
  refunded: "Refunded",
};
// "Open" = still in flight and worth surfacing by default. Delivered orders
// are done but not user-actionable, and cancelled/refunded are dead ends --
// both are still real history, just not what a guest is checking on first.
const TERMINAL_STATUSES = ["delivered", "cancelled", "refunded"];

type TrackMethod = "order" | "guest";

export function TrackForm({ whatsappNumber, vendorId }: { whatsappNumber: string | null; vendorId: string }) {
  const searchParams = useSearchParams();
  const { user, loading: userLoading } = useUser();
  const [method, setMethod] = useState<TrackMethod>("order");
  const [query, setQuery] = useState(searchParams.get("order") ?? "");
  const [contact, setContact] = useState("");
  // undefined = no search performed yet; null = searched, not found; an
  // array = found (may be a single-element array for the "order number"
  // method). Deriving "searched" from this instead of a separate boolean
  // avoids a synchronous setState at the top of search() that would
  // otherwise run inside the auto-search effect below.
  const [orders, setOrders] = useState<Order[] | null | undefined>(undefined);
  const searched = orders !== undefined;
  const [showHistory, setShowHistory] = useState(false);
  // Guards against React StrictMode's dev-only double-invoke (or rapid
  // re-searches) resolving out of order -- only the most recently *started*
  // request is allowed to commit its result, so a slower earlier request
  // can never clobber a newer one that already resolved.
  const latestRequestId = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Customer report: focusing the search box left it wherever the browser's
  // own "scroll input into view" happened to land it (often too low, close
  // to the keyboard) instead of a predictable spot. scrollIntoView's own
  // "start" alignment plus a small delay (letting the keyboard's open
  // animation finish first, so it isn't fighting that scroll) puts the
  // input at a consistent, comfortable position near the top every time.
  function handleSearchFocus() {
    setTimeout(() => {
      searchInputRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 300);
  }

  // Signed-in customers can look up their own order through RLS using the
  // order number. Guests must supply BOTH the order number and the checkout
  // email/phone; contact-only lookup exposed every order tied to a known
  // phone/email and returned private delivery/payment details.
  async function search(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    const requestId = ++latestRequestId.current;
    setShowHistory(false);
    if (method === "order") {
      const result = await getOrderByNumberClient(trimmed.toUpperCase());
      if (requestId === latestRequestId.current) setOrders(result ? [result] : null);
      return;
    }
    const trimmedContact = contact.trim();
    if (!trimmedContact) {
      setOrders(null);
      return;
    }
    const result = await getOrderByNumberAndContactClient(trimmed.toUpperCase(), trimmedContact, vendorId);
    if (requestId === latestRequestId.current) setOrders(result ? [result] : null);
  }

  useEffect(() => {
    const initial = searchParams.get("order");
    // search()'s setOrders call happens after an await, not synchronously
    // in this effect body -- the lint rule's static analysis can't trace
    // through the async boundary and flags the call site anyway.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (initial && user) search(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, searchParams]);

  if (userLoading) return null;

  const openOrders = orders?.filter((o) => !TERMINAL_STATUSES.includes(o.status)) ?? [];
  const historyOrders = orders?.filter((o) => TERMINAL_STATUSES.includes(o.status)) ?? [];
  // A single result (the common case, and always true for the "order
  // number" method) skips the summary-list layer entirely and goes straight
  // to the full detail view, same as before this change.
  const isSingleResult = orders?.length === 1;
  const visibleOrders = showHistory ? (orders ?? []) : openOrders;

  return (
    <div>
      <div className="flex gap-2 mb-4 justify-center">
        {(
          [
            { id: "order", label: "Order Number" },
            { id: "guest", label: "Guest Lookup" },
          ] as const
        ).map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() => {
              setMethod(opt.id);
              setOrders(undefined);
              setQuery("");
              setContact("");
            }}
            className={`px-4 py-2 rounded-full text-sm font-semibold transition-colors ${
              method === opt.id
                ? "bg-mango-orange text-white"
                : "bg-surface border-[1.5px] border-border-subtle text-ink-light hover:border-mango-orange"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          search(query);
        }}
        className="flex flex-col sm:flex-row gap-3 mb-8"
      >
        <input
          ref={searchInputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={handleSearchFocus}
          placeholder="Order number, e.g. ORD-100001"
          className="flex-1 min-w-0 scroll-mt-[calc(var(--nav-height)+1rem)] border-[1.5px] border-border-subtle rounded-full px-5 py-3 text-sm bg-surface focus-visible:outline-none focus-visible:border-mango-orange transition-colors"
        />
        {method === "guest" && (
          <input
            type="text"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            placeholder="Checkout email or phone"
            aria-label="Checkout email or phone"
            autoComplete="off"
            className="flex-1 min-w-0 border-[1.5px] border-border-subtle rounded-full px-5 py-3 text-sm bg-surface focus-visible:outline-none focus-visible:border-mango-orange transition-colors"
          />
        )}
        <button
          type="submit"
          className="w-full sm:w-auto shrink-0 bg-mango-orange text-white font-semibold px-6 py-3 rounded-full transition-transform hover:-translate-y-0.5"
        >
          Track
        </button>
      </form>

      {method === "order" && !user && (
        <p className="text-center text-xs text-ink-light -mt-5 mb-8">
          Tracking by order number needs you to be signed in. Guest?{" "}
          <button type="button" onClick={() => setMethod("guest")} className="text-mango-orange font-semibold">
            use guest lookup with your order number and checkout contact
          </button>{" "}
          or{" "}
          <Link href={`/login?returnTo=${encodeURIComponent(`/track${query ? `?order=${query}` : ""}`)}`} className="text-mango-orange font-semibold">
            sign in
          </Link>
          .
        </p>
      )}

      {searched && orders === null && (
        <p className="text-center text-ink-light py-10">
          {method === "order"
            ? "No order found with that number on your account."
            : "No order found. Check the order number and checkout email/phone."}
        </p>
      )}

      {orders && isSingleResult && <OrderDetail order={orders[0]} whatsappNumber={whatsappNumber} />}

      {orders && !isSingleResult && (
        <div>
          {visibleOrders.length === 0 ? (
            <p className="text-center text-ink-light py-10">
              No open orders found.{" "}
              <button type="button" onClick={() => setShowHistory(true)} className="text-mango-orange font-semibold">
                Show full order history ({historyOrders.length})
              </button>
              .
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-3 mb-4">
                {visibleOrders.map((o) => (
                  <OrderSummaryCard key={o.id} order={o} whatsappNumber={whatsappNumber} />
                ))}
              </div>
              {!showHistory && historyOrders.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowHistory(true)}
                  className="block mx-auto text-sm font-semibold text-mango-orange"
                >
                  Show order history ({historyOrders.length} more)
                </button>
              )}
              {showHistory && (
                <button
                  type="button"
                  onClick={() => setShowHistory(false)}
                  className="block mx-auto text-sm font-semibold text-mango-orange"
                >
                  Show open orders only
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Compact card for the "several orders on this contact" list -- expands
// into the full OrderDetail (status stepper, items, delivery address) in
// place when tapped, rather than navigating away, so the list position
// isn't lost.
function OrderSummaryCard({ order, whatsappNumber }: { order: Order; whatsappNumber: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const isTerminal = TERMINAL_STATUSES.includes(order.status);

  return (
    <div className="border border-border-subtle rounded-2xl overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-cream-warm transition-colors"
      >
        <div className="min-w-0">
          <div className="font-bold text-sm tabular-nums truncate">{order.order_number}</div>
          <div className="text-xs text-ink-light">
            {new Date(order.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
            {" · "}
            {formatPKR(order.total)}
          </div>
        </div>
        <span
          className={`shrink-0 text-xs font-semibold px-3 py-1 rounded-full ${
            isTerminal && order.status !== "delivered"
              ? "bg-error/10 text-error"
              : order.status === "delivered"
                ? "bg-orchard-green/10 text-orchard-green"
                : "bg-mango-orange/10 text-mango-deep"
          }`}
        >
          {STATUS_LABELS[order.status]}
        </span>
      </button>
      <div className="flex items-center gap-3 px-4 pb-4">
        <button type="button" onClick={() => setExpanded((v) => !v)} className="text-xs font-semibold text-mango-orange">
          {expanded ? "Hide details" : "View details"}
        </button>
        {whatsappNumber && (
          <a
            href={orderTrackingWhatsAppLink(whatsappNumber, order.order_number, STATUS_LABELS[order.status])}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#25D366]"
          >
            <WhatsAppIcon className="w-3.5 h-3.5" />
            Ask about this order
          </a>
        )}
      </div>
      {expanded && (
        <div className="border-t border-border-subtle p-4">
          <OrderDetail order={order} whatsappNumber={whatsappNumber} bare />
        </div>
      )}
    </div>
  );
}

function OrderDetail({
  order,
  whatsappNumber,
  bare,
}: {
  order: Order;
  whatsappNumber: string | null;
  // Nested inside OrderSummaryCard, which already shows the order number/
  // date/status/WhatsApp link in its own header row -- skip this
  // component's outer border and duplicate header in that case.
  bare?: boolean;
}) {
  const items =
    (order.items as { name: string; box_size_kg?: number; variant_label?: string; qty: number; unit_price: number }[]) ??
    [];
  const delivery = order.delivery as {
    full_name: string;
    phone: string;
    address: string;
    city: string;
    province?: string;
  };
  const isTerminal = order.status === "cancelled" || order.status === "refunded";
  const currentStepIndex = STATUS_STEPS.indexOf(order.status as (typeof STATUS_STEPS)[number]);

  return (
    <div className={bare ? "" : "border border-border-subtle rounded-2xl p-6 shadow-brand-sm"}>
      {!bare && (
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="text-xs text-ink-light">Order</div>
            <div className="font-bold text-lg tabular-nums">{order.order_number}</div>
          </div>
          <div className="text-right">
            <div className="text-xs text-ink-light">Placed</div>
            <div className="text-sm font-medium">
              {new Date(order.created_at).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            </div>
          </div>
        </div>
      )}
      {!bare && whatsappNumber && (
        <a
          href={orderTrackingWhatsAppLink(whatsappNumber, order.order_number, STATUS_LABELS[order.status])}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#25D366] mb-6 -mt-3"
        >
          <WhatsAppIcon className="w-3.5 h-3.5" />
          Ask about this order on WhatsApp
        </a>
      )}

      {isTerminal ? (
        <div className="bg-error/10 text-error font-semibold rounded-xl p-4 mb-6 text-center">
          {STATUS_LABELS[order.status]}
        </div>
      ) : (
        <div className="flex items-center justify-between mb-8">
          {STATUS_STEPS.map((step, i) => (
            // min-w-0 overrides flexbox's default min-width:auto -- without
            // it, a step whose label text is wider than its 1/5 share (e.g.
            // "Order Placed" on a 375px screen) forced the whole row wider
            // than the viewport instead of letting the label wrap, causing
            // horizontal overflow/scroll on mobile (real bug, found via
            // review).
            <div key={step} className="flex-1 min-w-0 flex flex-col items-center relative">
              {i > 0 && (
                <div
                  className={`absolute top-3 right-1/2 w-full h-0.5 transition-colors ${
                    i <= currentStepIndex ? "bg-mango-orange" : "bg-border-subtle"
                  }`}
                />
              )}
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold z-10 transition-colors ${
                  i <= currentStepIndex
                    ? "bg-mango-orange text-white shadow-[0_0_0_4px_rgba(255,107,0,0.15)]"
                    : "bg-border-subtle text-ink-light"
                }`}
              >
                {i <= currentStepIndex ? "✓" : i + 1}
              </div>
              <div className={`text-xs text-center mt-2 ${i === currentStepIndex ? "text-ink font-semibold" : "text-ink-light"}`}>
                {STATUS_LABELS[step]}
              </div>
            </div>
          ))}
        </div>
      )}

      {MANUAL_PAYMENT_METHODS.includes(order.payment_method ?? "") && (
        <PaymentProofPanel
          orderNumber={order.order_number}
          paymentMethod={order.payment_method!}
          paymentStatus={order.payment_status}
          paymentAccountId={order.payment_account_id}
          rejectionReason={order.payment_rejection_reason}
          total={Number(order.total)}
          whatsappNumber={whatsappNumber}
          vendorId={order.vendor_id}
        />
      )}

      {order.tracking_number && (
        <div className="text-sm mb-4 bg-cream-warm rounded-xl p-3.5">
          <span className="text-ink-light">Tracking Number: </span>
          <span className="font-semibold tabular-nums">{order.tracking_number}</span>
          {order.courier_name && <span className="text-ink-light"> via {order.courier_name}</span>}
        </div>
      )}

      <div className="mb-6">
        <h3 className="font-semibold text-sm mb-2">Delivering To</h3>
        <p className="text-sm text-ink-light">
          {delivery.full_name} · {delivery.phone}
          <br />
          {delivery.address}, {delivery.city}
          {delivery.province ? `, ${delivery.province}` : ""}
        </p>
        <a
          href={googleMapsUrl(delivery.address, delivery.city, delivery.province)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-xs font-semibold text-mango-orange mt-1.5"
        >
          View on Google Maps ↗
        </a>
      </div>

      <div className="mb-4">
        <h3 className="font-semibold text-sm mb-2">Items</h3>
        <div className="flex flex-col gap-2">
          {items.map((item, i) => (
            <div key={i} className="flex justify-between gap-3 text-sm">
              <span className="min-w-0">
                {item.name} ({getOrderItemVariantLabel(item)}) × {item.qty}
              </span>
              <span className="shrink-0 tabular-nums">{formatPKR(item.unit_price * item.qty)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="border-t border-border-subtle pt-3 flex justify-between font-bold tabular-nums">
        <span>Total</span>
        <span className="text-mango-orange">{formatPKR(order.total)}</span>
      </div>
    </div>
  );
}
