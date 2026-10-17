"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { generateBugReportAiReply } from "@/lib/bug-report-ai";
import { sendAdminBugReportAlert, ADMIN_ALERT_EMAIL } from "@/lib/email";
import { getSiteContent } from "@/lib/queries/site-content";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCurrentVendor } from "@/lib/tenant";

export type SubmitBugReportState =
  | { error: string }
  | { success: true; aiReply: string }
  | undefined;

const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

export async function submitBugReport(
  _prev: SubmitBugReportState,
  formData: FormData
): Promise<SubmitBugReportState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Please sign in to report a bug." };

  const { allowed } = await checkRateLimit("bug_report", user.id, {
    maxAttempts: 5,
    windowMinutes: 60,
    lockMinutes: 60,
  });
  if (!allowed) {
    return { error: "You've submitted several reports recently. Please try again in a bit." };
  }

  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();

  if (!title || title.length > 150) {
    return { error: "Please give the bug a short title (under 150 characters)." };
  }
  if (!description || description.length > 3000) {
    return { error: "Please describe the bug (up to 3000 characters)." };
  }

  let screenshotPath: string | null = null;
  const screenshot = formData.get("screenshot");
  if (screenshot instanceof File && screenshot.size > 0) {
    if (screenshot.size > MAX_SCREENSHOT_BYTES) {
      return { error: "That screenshot is too large — please keep it under 5MB." };
    }
    if (!ALLOWED_TYPES.includes(screenshot.type)) {
      return { error: "Screenshot must be a JPG, PNG or WebP image." };
    }
    const ext = screenshot.name.split(".").pop()?.toLowerCase() ?? "jpg";
    // Folder-per-user path -- same convention as payment-proofs/review-images,
    // and what the storage RLS policy keys off of.
    const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from("bug-report-screenshots")
      .upload(path, screenshot, { contentType: screenshot.type });
    if (uploadError) return { error: "Couldn't upload that screenshot. Please try again." };
    screenshotPath = path;
  }

  const { brand, loyaltyProgram } = await getSiteContent();
  const fallbackReply = `Thanks for reporting this! Our team will review it, and you'll earn 1 ${loyaltyProgram.currencySingular} once it's confirmed as a genuine bug.`;
  const aiReply =
    (await generateBugReportAiReply(title, description, brand.logoText, loyaltyProgram.currencySingular)) ??
    fallbackReply;

  const vendor = await getCurrentVendor();
  const { error: insertError } = await supabase.from("bug_reports").insert({
    profile_id: user.id,
    vendor_id: vendor.id,
    title,
    description,
    screenshot_path: screenshotPath,
    ai_reply: aiReply,
  });

  if (insertError) return { error: "Couldn't submit your report. Please try again." };

  if (ADMIN_ALERT_EMAIL) {
    const to = ADMIN_ALERT_EMAIL;
    const { data: profile } = await supabase
      .from("profiles")
      .select("name")
      .eq("id", user.id)
      .maybeSingle();

    const reporterName = profile?.name ?? user.email ?? "A customer";
    after(() => sendAdminBugReportAlert({ to, title, reporterName }));
  }

  revalidatePath("/report-bug");
  return { success: true, aiReply };
}
