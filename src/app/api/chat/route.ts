import { NextResponse } from "next/server";
import { getSiteChrome } from "@/lib/queries/site";
import { getSiteContent } from "@/lib/queries/site-content";
import { getPublishedProducts, type ProductWithBoxSizes } from "@/lib/queries/products";
import { getOrderByNumber, getOrdersForCurrentUser } from "@/lib/queries/orders";
import { createClient } from "@/lib/supabase/server";
import { formatPKR } from "@/lib/format";
import { getOrderItemVariantLabel } from "@/lib/order-item";
import { checkRateLimit, getRequestIp } from "@/lib/rate-limit";
import type { SiteContent } from "@/lib/site-content-defaults";

export const runtime = "nodejs";

// Groq's free tier (console.groq.com) -- no credit card ever attachable to
// the account, so unlike a pay-as-you-go cloud API there's no way for this
// to silently run up a bill. If this model is ever retired, swap the name
// here; the request/response shape below is the standard OpenAI-compatible
// chat-completions format Groq (and most other free-tier providers) speaks.
// llama-3.3-70b-versatile was retired from Groq's catalog (verified via
// GET /openai/v1/models) -- gpt-oss-120b is its replacement. It's a
// reasoning model: without reasoning_effort:"low" it can burn the whole
// max_tokens budget on hidden chain-of-thought and return an EMPTY
// message.content (the actual answer only ever lands in message.reasoning,
// which this route never reads) -- confirmed by testing directly against
// the Groq API before swapping this in.
const MODEL = "openai/gpt-oss-120b";
const MAX_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 1000;

type ChatMessage = { role: "user" | "assistant"; content: string };

// ORD- is the current prefix for every vendor (order_number_seq's default
// used to hardcode TAG-, a TheAamGhar leftover from before multi-tenancy --
// TAG- orders placed before that fix still need to match here too).
const ORDER_NUMBER_PATTERN = /\b(?:TAG|ORD)-\d{4,}\b/i;
const TRACKING_INTENT_PATTERN =
  /\btrack(ing)?\b|\bwhere('s| is)? my (order|package|parcel)\b|order status|my orders?\b|ongoing order/i;

// Renders the live catalog (name, per-size price, live stock) into the
// system prompt so the model answers pricing/availability questions from
// real data instead of guessing -- also carries sweetness/fiber so it can
// match a customer's stated mood to an actual variety.
function buildProductCatalogBlock(products: ProductWithBoxSizes[]): string {
  if (products.length === 0) return "";
  const lines = products.map((p) => {
    const sizes = p.boxSizes.length
      ? p.boxSizes
          .map(
            (b) =>
              `${b.box_size_kg}kg ${formatPKR(b.selling_price)} (${
                b.stock_qty > 0 ? `${b.stock_qty} in stock` : "out of stock"
              })`
          )
          .join(", ")
      : p.variants.length
        ? p.variants
            .map(
              (v) =>
                `${v.label ?? Object.values(v.attributes).join("/") ?? "Standard"} ${formatPKR(v.selling_price)} (${
                  v.stock_qty > 0 ? `${v.stock_qty} in stock` : "out of stock"
                })`
            )
            .join(", ")
        : "currently no sizes listed / unavailable";
    const traits = [p.sweetness, p.fiber].filter(Boolean).join(", ");
    return `- ${p.name}${p.origin ? ` (${p.origin})` : ""}: ${sizes}${
      traits ? ` | taste profile: ${traits}` : ""
    }${p.tagline ? ` | ${p.tagline}` : ""}`;
  });
  return `\n\nLive product catalog -- always use this for prices, stock, and variety suggestions, never invent a price or claim something's in stock without checking here:\n${lines.join(
    "\n"
  )}`;
}

type OrderRow = {
  order_number: string;
  status: string;
  created_at: string;
  items: unknown;
};

function summarizeOrder(o: OrderRow): string {
  const items = Array.isArray(o.items)
    ? (o.items as { name: string; box_size_kg?: number; variant_label?: string; qty: number }[])
        .map((i) => `${i.qty}x ${i.name} (${getOrderItemVariantLabel(i)})`)
        .join(", ")
    : "";
  const placed = new Date(o.created_at).toLocaleDateString("en-PK", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${o.order_number} -- status: ${o.status}, placed ${placed}${items ? `, items: ${items}` : ""}`;
}

// Looks for an explicit order number, or a general "track my order" intent,
// in the latest user message and resolves it against the real orders table
// (RLS-scoped to the signed-in customer, same as the /track page) so the
// model states real status instead of guessing. Returns "" when neither
// applies, leaving the base prompt's existing tracking guidance untouched.
async function buildOrderTrackingBlock(latestUserMessage: string): Promise<string> {
  const numberMatch = latestUserMessage.match(ORDER_NUMBER_PATTERN);

  if (numberMatch) {
    const order = await getOrderByNumber(numberMatch[0].toUpperCase());
    if (order) {
      return `\n\nThe customer just asked about order ${numberMatch[0].toUpperCase()}. Here is its real, current status -- state it plainly, don't hedge:\n${summarizeOrder(order as OrderRow)}`;
    }
    return `\n\nThe customer asked about order ${numberMatch[0].toUpperCase()}, but no such order was found on their signed-in account (either it doesn't exist, belongs to someone else, or they're not signed in as its owner). Tell them honestly you can't find it on their account and to double-check the order number or sign in with the account that placed it.`;
  }

  if (TRACKING_INTENT_PATTERN.test(latestUserMessage)) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return `\n\nThe customer wants to track an order but isn't signed in. Tell them to sign in at /login (or give you a specific order number like ORD-100001, which also requires being signed in as its owner) to see real status.`;
    }

    const orders = (await getOrdersForCurrentUser()) as OrderRow[];
    if (orders.length === 0) {
      return `\n\nThe customer wants to track their orders. They're signed in but have no orders on their account -- tell them that honestly.`;
    }
    return `\n\nThe customer wants to track their order(s). Here are their real, current orders (most recent first) -- state statuses plainly from this list, don't guess:\n${orders
      .slice(0, 5)
      .map(summarizeOrder)
      .join("\n")}`;
  }

  return "";
}

function buildSystemInstruction(
  settings: {
    business_name: string | null;
    support_whatsapp: string | null;
    support_phone: string | null;
    support_email: string | null;
    business_address: string | null;
    google_maps_url: string | null;
    default_shipping_cost: number | null;
    free_shipping_threshold: number | null;
    facebook_url: string | null;
    instagram_url: string | null;
    tiktok_url: string | null;
    youtube_url: string | null;
    twitter_url: string | null;
  } | null,
  aiContent: SiteContent["aiAssistant"],
  storyContent: SiteContent["story"],
  loyaltyProgram: SiteContent["loyaltyProgram"],
  accentEmoji: string,
  paymentMethod: string,
  context?: "search",
  language?: "ur",
  productCatalogBlock?: string,
  orderTrackingBlock?: string
) {
  const businessName = settings?.business_name ?? "TheAamGhar";
  const whatsapp = settings?.support_whatsapp ?? "our WhatsApp number on the Contact page";
  const whatsappLink = settings?.support_whatsapp ? `https://wa.me/${settings.support_whatsapp}` : null;
  const shippingCost = settings?.default_shipping_cost;
  const freeShippingAt = settings?.free_shipping_threshold;
  const { categoryDescription, productSingular, productPlural, damagedItemNote } = aiContent;

  const socialLines = [
    settings?.instagram_url ? `Instagram: ${settings.instagram_url}` : null,
    settings?.facebook_url ? `Facebook: ${settings.facebook_url}` : null,
    settings?.tiktok_url ? `TikTok: ${settings.tiktok_url}` : null,
    settings?.youtube_url ? `YouTube: ${settings.youtube_url}` : null,
    settings?.twitter_url ? `X/Twitter: ${settings.twitter_url}` : null,
  ].filter(Boolean);

  const storyBlock =
    storyContent.paragraph1 || storyContent.paragraph2
      ? `\n\nOur story (share this, in your own warm words, only if the customer asks about the store, who's behind it, or how it started -- don't volunteer it unprompted):\n${[storyContent.paragraph1, storyContent.paragraph2].filter(Boolean).join("\n")}`
      : "";

  const languageInstruction =
    language === "ur"
      ? "\n\nThe customer has switched this chat to Urdu. Reply only in Urdu, written in Urdu (Nastaliq/Arabic) script -- not Roman Urdu, not English -- for every message in this conversation, no matter what script the customer types in."
      : "";

  const base = `You are the customer support assistant for ${businessName}, an online store selling ${categoryDescription}, delivered fresh across Pakistan.${languageInstruction}

Facts you can rely on:
- Payment: ${paymentMethod}.
- Delivery: usually next-day, same-day if ordered before 3pm, across Pakistan.
${shippingCost != null ? `- Standard shipping cost: Rs ${shippingCost} (varies a little by province/city).` : ""}
${freeShippingAt != null ? `- Free shipping on orders over Rs ${freeShippingAt}.` : ""}
- New customers get a one-time welcome discount after verifying their email in their account (see Account page). Don't invent a specific percentage or code beyond what's stated here -- only what the customer's real account shows applies to them.
- ${loyaltyProgram.name}: customers earn ${loyaltyProgram.currencyPlural} (shown as "${loyaltyProgram.currencyTitleCase}" in their account) for activity like check-ins and reviews -- point them to the Rewards page in their account for their real balance, never guess a number.
- Orders can be tracked at /track using the order number, or right here in chat — a customer can paste an order number (like ORD-100001) or just ask "track my order" and you'll be given their real order data below when that happens.
- Reviews can be left on a product's page once it's delivered, via the account's Orders page.
- ${damagedItemNote} (${whatsapp}) with their order number — support will make it right.
- Signing in is available via email/password, Google, or phone number (OTP).
${settings?.business_address ? `- Location: ${settings.business_address}${settings.google_maps_url ? ` — map link: ${settings.google_maps_url}` : ""}` : ""}
${whatsappLink ? `- WhatsApp: ${whatsapp} (${whatsappLink}) -- share this link directly whenever a customer wants to message, order, or reach a real person.` : ""}
${socialLines.length > 0 ? `- Social media: ${socialLines.join(" | ")}` : ""}
- When a customer describes a mood or craving (e.g. "something sweet", "not too messy to eat", "want it tangy") instead of naming a variety, recommend a specific ${productSingular} from the live catalog below based on its taste profile — don't just describe ${productPlural} generically.

Rules:
- Be warm, concise, and helpful — a few sentences, not an essay.
- Plain conversational text only — no markdown (no **bold**, no tables, no bullet-point lists, no headings). Replies render as plain text in a narrow chat bubble on a phone screen, so a markdown table (e.g. "Variant | Price | Stock") shows up as raw pipe characters wrapping awkwardly across lines instead of an actual table -- when comparing variants/prices, just say them as a short sentence or a few short lines instead (e.g. "Upper Only is Rs 3,500, Full Tracksuit is Rs 5,800, both in S–XXL").
- Only answer questions about ${businessName}, its products, orders, delivery, payments, returns, location, socials, or account features.
- Always quote real prices and stock from the live product catalog below when asked — never invent a number.
- Order status/tracking info is only ever real when supplied to you below — if no order context was supplied for this message, don't guess a status; ask for the order number or tell them to sign in at /track.
- Never invent a coupon/discount code — only mention the welcome discount and loyalty program facts stated above, and never state a specific rewards balance since you don't have access to it.
- If asked something you don't actually know and wasn't given to you as data below, say so honestly and point them to WhatsApp (${whatsapp}) or the Contact page rather than guessing.
- Never invent policies, prices, or order information.
- If the user asks something totally unrelated to the store, politely redirect them back to how you can help with their order.${storyBlock}${productCatalogBlock ?? ""}${orderTrackingBlock ?? ""}`;

  if (context !== "search") return base;

  return `${base}

Special context: what follows is not a chat conversation -- it's whatever the customer just typed into the product SEARCH BAR, and it matched zero products in the catalog. Reply in 2-3 short sentences:
- If it's genuinely about ${productPlural}/orders/the store, answer briefly, or suggest a way to search differently.
- If it's unrelated to the store (weather, general chit-chat, other topics), gently and warmly say something like "we don't have that service here (yet!)" -- don't pretend to be a general assistant.
- Always end with a short, light question about how they're feeling today or what mood they're in, to help suggest a ${productSingular} variety (e.g. "Feeling refreshed or craving something sweet? That'll help me point you the right way ${accentEmoji}").`;
}

export async function POST(request: Request) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Chat support isn't configured yet. Please reach us on WhatsApp instead." },
      { status: 503 }
    );
  }

  let body: { messages?: ChatMessage[]; context?: "search"; language?: "ur" };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const messages = (body.messages ?? [])
    .filter(
      (m): m is ChatMessage =>
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0
    )
    .slice(-MAX_MESSAGES)
    .map((m) => ({ ...m, content: m.content.slice(0, MAX_MESSAGE_LENGTH) }));

  if (messages.length === 0) {
    return NextResponse.json({ error: "No message provided." }, { status: 400 });
  }

  const ip = getRequestIp(request);
  const { allowed, retryAfter } = await checkRateLimit("chat", ip, {
    maxAttempts: 30,
    windowMinutes: 10,
    lockMinutes: 10,
  });
  if (!allowed) {
    return NextResponse.json(
      {
        error: "You're sending messages too quickly. Please wait a bit and try again.",
        retryAfter,
      },
      { status: 429 }
    );
  }

  const latestUserMessage = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  const [{ settings }, content, products, orderTrackingBlock] = await Promise.all([
    getSiteChrome(),
    getSiteContent(),
    getPublishedProducts(),
    // Order lookups only make sense in a real chat turn, not while typing
    // into the search bar -- skip the extra DB round-trip in that mode.
    body.context === "search" ? Promise.resolve("") : buildOrderTrackingBlock(latestUserMessage),
  ]);
  const productCatalogBlock = buildProductCatalogBlock(products);

  const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "system",
          content: buildSystemInstruction(
            settings,
            content.aiAssistant,
            content.story,
            content.loyaltyProgram,
            content.brand.accentEmoji,
            content.brand.paymentBadgeText ?? "Cash on Delivery (COD) only, paid when the order arrives",
            body.context,
            body.language,
            productCatalogBlock,
            orderTrackingBlock
          ),
        },
        ...messages,
      ],
      max_tokens: 400,
      temperature: 0.6,
      reasoning_effort: "low",
    }),
  });

  if (!groqResponse.ok) {
    // Logged (not leaked to the client) so a future Groq-side change --
    // model retirement, quota, auth -- shows up in Vercel logs instead of
    // requiring a manual curl against the Groq API to diagnose, like this
    // one did (llama-3.3-70b-versatile was silently retired).
    console.error("[chat] Groq API error", groqResponse.status, await groqResponse.text());
    return NextResponse.json(
      { error: "Something went wrong. Please try again or message us on WhatsApp." },
      { status: 502 }
    );
  }

  const data = await groqResponse.json();
  const reply: string | undefined = data?.choices?.[0]?.message?.content;

  if (!reply) {
    console.error("[chat] Groq response had no message.content", JSON.stringify(data).slice(0, 500));
    return NextResponse.json(
      { error: "Something went wrong. Please try again or message us on WhatsApp." },
      { status: 502 }
    );
  }

  return NextResponse.json({ reply });
}
