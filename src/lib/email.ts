import "server-only";
import { formatPKR } from "@/lib/format";
import { SITE_URL, ADMIN_URL } from "@/lib/site-url";
import { getSiteContent } from "@/lib/queries/site-content";
import { getOrderItemVariantLabel } from "@/lib/order-item";

// Sends through the business owner's own Gmail account via SMTP (an App
// Password, not the regular login password -- Gmail has required this for
// third-party SMTP since it retired "less secure apps") rather than a
// transactional email API/service. Deliberately no-ops with a console
// warning when the env vars aren't set, same graceful-degradation pattern as
// GROQ_API_KEY in api/chat/route.ts -- placing an order must never fail just
// because email isn't configured yet.
const PLATFORM_MAILER_URL = process.env.NASHEMANN_MAILER_URL ?? "https://superadmin.nashemann.store/api/notifications/send";

// Configure ADMIN_ALERT_EMAIL separately if the platform operator needs order alerts.
export const ADMIN_ALERT_EMAIL = process.env.ADMIN_ALERT_EMAIL ?? null;

// A crude but effective HTML->text derivation -- an HTML-only email (no
// text/plain part) is one of the strongest signals spam filters use against
// automated mail, and every email this module sends was missing one
// entirely until now. Good enough for these short, simple templates; not
// meant to handle arbitrary HTML.
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li)>/gi, "\n\n")
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&(lt|gt|quot|#39);/g, (m) => ({ "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[m] ?? m)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Every call site treats email as best-effort -- a delivery failure here
// must never fail the order/upload it's reporting on, since that real
// side-effect already succeeded. Errors are logged, not thrown.
async function sendMail(to: string, subject: string, html: string, _businessName: string): Promise<boolean> {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    console.error(`[email] Skipped "${subject}" to ${to} -- SUPABASE_SERVICE_ROLE_KEY is not configured.`);
    return false;
  }
  try {
    const response = await fetch(PLATFORM_MAILER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ to, subject, html, category: "notifications" }),
    });
    if (!response.ok) {
      console.error(`[email] Internal mailer rejected "${subject}" to ${to}: HTTP ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(`[email] Failed to send "${subject}" to ${to} through the internal mailer:`, error);
    return false;
  }
}

// Every exported function below calls this once to get the current
// admin-editable brand copy (site_content.emailBrand/brand) -- kept as one
// small helper rather than threading getSiteContent() through every call
// site's own params.
async function getEmailBrand() {
  const { brand, brandColors, emailBrand } = await getSiteContent();
  return {
    businessName: brand.logoText,
    accentEmoji: brand.accentEmoji,
    headerText: emailBrand.headerText,
    footerText: emailBrand.footerText,
    primaryColor: brandColors.primary,
    secondaryColor: brandColors.secondary,
  };
}

function wrapEmail(bodyHtml: string, headerText: string, footerText: string, primaryColor: string): string {
  return `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;">
      <div style="background:${primaryColor};padding:20px 24px;border-radius:12px 12px 0 0;">
        <span style="color:#fff;font-size:20px;font-weight:700;">${headerText}</span>
      </div>
      <div style="background:#fff;border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;padding:24px;color:#2D2D2D;">
        ${bodyHtml}
      </div>
      <p style="text-align:center;color:#999;font-size:12px;margin-top:16px;">
        ${footerText}
      </p>
    </div>
  `;
}

type OrderItemForEmail = {
  name: string;
  box_size_kg?: number;
  variant_label?: string;
  qty: number;
  unit_price: number;
};

function itemsTable(items: OrderItemForEmail[]): string {
  const rows = items
    .map(
      (i) => `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #f0f0f0;">${i.name} (${getOrderItemVariantLabel(i)}) × ${i.qty}</td>
        <td style="padding:8px 0;border-bottom:1px solid #f0f0f0;text-align:right;">${formatPKR(i.unit_price * i.qty)}</td>
      </tr>`
    )
    .join("");
  return `<table style="width:100%;border-collapse:collapse;margin:16px 0;">${rows}</table>`;
}

export async function sendCustomerWelcomeEmail(params: { to: string; name: string }): Promise<boolean> {
  const { businessName, accentEmoji, headerText, footerText, primaryColor } = await getEmailBrand();
  const safeName = params.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const html = wrapEmail(
    `
      <h2 style="margin-top:0;">Welcome to ${businessName}, ${safeName}! ${accentEmoji}</h2>
      <p>Your account is ready. You can browse the store, save your favourites, track orders, and manage your delivery details from your account.</p>
      <a href="${SITE_URL}/account" style="display:inline-block;margin-top:16px;background:${primaryColor};color:#fff;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:600;">Open your account</a>
    `,
    headerText,
    footerText,
    primaryColor
  );
  return sendMail(params.to, `Welcome to ${businessName}!`, html, businessName);
}

export async function sendOrderConfirmationEmail(params: {
  to: string;
  orderNumber: string;
  items: OrderItemForEmail[];
  subtotal: number;
  shippingFee: number;
  discountAmount: number;
  total: number;
  fullName: string;
  address: string;
  city: string;
  paymentMethod: string;
}): Promise<void> {
  const { businessName, accentEmoji, headerText, footerText, primaryColor, secondaryColor } = await getEmailBrand();
  const trackUrl = `${SITE_URL}/track?order=${params.orderNumber}`;
  const html = wrapEmail(
    `
    <h2 style="margin-top:0;">Thanks, ${params.fullName.split(" ")[0]}! ${accentEmoji}</h2>
    <p>Your order <strong>${params.orderNumber}</strong> is confirmed and headed to our packing table.</p>
    ${itemsTable(params.items)}
    <p style="text-align:right;margin:4px 0;">Subtotal: ${formatPKR(params.subtotal)}</p>
    <p style="text-align:right;margin:4px 0;">Shipping: ${formatPKR(params.shippingFee)}</p>
    ${params.discountAmount > 0 ? `<p style="text-align:right;margin:4px 0;color:${secondaryColor};">Discount: -${formatPKR(params.discountAmount)}</p>` : ""}
    <p style="text-align:right;font-weight:700;font-size:18px;margin:8px 0;">Total: ${formatPKR(params.total)}</p>
    <p style="margin-top:20px;"><strong>Delivering to:</strong><br/>${params.address}, ${params.city}</p>
    <p><strong>Payment:</strong> ${
      params.paymentMethod === "cod" ? "Cash on Delivery" : "Manual transfer — awaiting your payment proof"
    }</p>
    <a href="${trackUrl}" style="display:inline-block;margin-top:16px;background:${primaryColor};color:#fff;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:600;">Track Your Order</a>
  `,
    headerText,
    footerText,
    primaryColor
  );
  await sendMail(params.to, `Order Confirmed — ${params.orderNumber}`, html, businessName);
}

export async function sendAdminNewOrderAlert(params: {
  to: string;
  orderNumber: string;
  total: number;
  customerName: string;
  itemsSummary: string;
}): Promise<void> {
  const { businessName, accentEmoji, headerText, footerText, primaryColor, secondaryColor } = await getEmailBrand();
  const html = wrapEmail(
    `
    <h2 style="margin-top:0;">${accentEmoji} New Order — ${params.orderNumber}</h2>
    <p><strong>${params.customerName}</strong> just ordered ${formatPKR(params.total)}.</p>
    <p>${params.itemsSummary}</p>
    <a href="${ADMIN_URL}/admin/orders" style="display:inline-block;margin-top:12px;background:${secondaryColor};color:#fff;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:600;">Open Admin Dashboard</a>
  `,
    headerText,
    footerText,
    primaryColor
  );
  await sendMail(params.to, `New Order — ${params.orderNumber} (${formatPKR(params.total)})`, html, businessName);
}

export async function sendAdminPaymentProofAlert(params: {
  to: string;
  orderNumber: string;
  total: number;
}): Promise<void> {
  const { businessName, headerText, footerText, primaryColor, secondaryColor } = await getEmailBrand();
  const html = wrapEmail(
    `
    <h2 style="margin-top:0;">💰 Payment Proof Uploaded — ${params.orderNumber}</h2>
    <p>A customer just uploaded payment proof for their ${formatPKR(params.total)} order. Please verify it in the admin dashboard.</p>
    <a href="${ADMIN_URL}/admin/orders" style="display:inline-block;margin-top:12px;background:${secondaryColor};color:#fff;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:600;">Verify Payment</a>
  `,
    headerText,
    footerText,
    primaryColor
  );
  await sendMail(params.to, `Payment Proof Uploaded — ${params.orderNumber}`, html, businessName);
}

export async function sendVendorNewOrderEmail(params: {
  to: string;
  orderNumber: string;
  total: number;
  customerName: string;
  customerPhone: string;
  address: string;
  city: string;
  itemsSummary: string;
}): Promise<void> {
  const { businessName, headerText, footerText, primaryColor, secondaryColor } = await getEmailBrand();
  const safe = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const html = wrapEmail(
    `
      <h2 style="margin-top:0;">🛍️ New order — ${safe(params.orderNumber)}</h2>
      <p><strong>${safe(params.customerName)}</strong> placed an order for <strong>${formatPKR(params.total)}</strong>.</p>
      <p><strong>Items:</strong> ${safe(params.itemsSummary)}</p>
      <p><strong>Phone:</strong> ${safe(params.customerPhone)}<br/><strong>Deliver to:</strong> ${safe(params.address)}, ${safe(params.city)}</p>
      <a href="${ADMIN_URL}/admin/orders" style="display:inline-block;margin-top:12px;background:${secondaryColor};color:#fff;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:600;">Open Orders</a>
    `,
    headerText,
    footerText,
    primaryColor
  );
  await sendMail(params.to, `New order — ${params.orderNumber}`, html, businessName);
}

export async function sendVendorPaymentProofAlert(params: {
  to: string;
  orderNumber: string;
  total: number;
  customerEmail: string;
}): Promise<void> {
  const { businessName, headerText, footerText, primaryColor, secondaryColor } = await getEmailBrand();
  const safe = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const html = wrapEmail(
    `
      <h2 style="margin-top:0;">💳 Payment proof uploaded — ${safe(params.orderNumber)}</h2>
      <p>A customer uploaded payment proof for an order worth <strong>${formatPKR(params.total)}</strong>.</p>
      <p><strong>Customer email:</strong> ${safe(params.customerEmail)}</p>
      <p>Please review the proof and update the order's payment status.</p>
      <a href="${ADMIN_URL}/admin/orders" style="display:inline-block;margin-top:12px;background:${secondaryColor};color:#fff;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:600;">Review payment proof</a>
    `,
    headerText,
    footerText,
    primaryColor
  );
  await sendMail(params.to, `Payment proof uploaded — ${params.orderNumber}`, html, businessName);
}

export async function sendStreakReminderEmail(params: {
  to: string;
  name: string;
  streak: number;
}): Promise<void> {
  const [{ businessName, accentEmoji, headerText, footerText, primaryColor }, { loyaltyProgram }] = await Promise.all([
    getEmailBrand(),
    getSiteContent(),
  ]);
  const rewardsUrl = `${SITE_URL}/account/rewards`;
  const html = wrapEmail(
    `
    <h2 style="margin-top:0;">Don't lose your streak, ${params.name}! 🔥${accentEmoji}</h2>
    <p>You're on a <strong>${params.streak}-day</strong> ${loyaltyProgram.currencySingular} check-in streak — check in today or it resets back to day one.</p>
    <a href="${rewardsUrl}" style="display:inline-block;margin-top:16px;background:${primaryColor};color:#fff;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:600;">Check In Now</a>
  `,
    headerText,
    footerText,
    primaryColor
  );
  await sendMail(params.to, `🔥 Your ${params.streak}-day streak is about to reset`, html, businessName);
}

export async function sendAdminBugReportAlert(params: {
  to: string;
  title: string;
  reporterName: string;
}): Promise<void> {
  const [{ businessName, headerText, footerText, primaryColor, secondaryColor }, { loyaltyProgram }] = await Promise.all([
    getEmailBrand(),
    getSiteContent(),
  ]);
  const html = wrapEmail(
    `
    <h2 style="margin-top:0;">🐞 New Bug Report — ${params.title}</h2>
    <p><strong>${params.reporterName}</strong> just reported a bug. Review it and confirm to grant their ${loyaltyProgram.currencySingular}.</p>
    <a href="${ADMIN_URL}/admin/bugs" style="display:inline-block;margin-top:12px;background:${secondaryColor};color:#fff;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:600;">Review Bug Reports</a>
  `,
    headerText,
    footerText,
    primaryColor
  );
  await sendMail(params.to, `New Bug Report — ${params.title}`, html, businessName);
}
