"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function VerifyEmailBanner({
  email,
  discountPercent,
}: {
  email: string;
  discountPercent: number;
}) {
  const router = useRouter();
  const [step, setStep] = useState<"prompt" | "code" | "done">("prompt");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [grantedPercent, setGrantedPercent] = useState<number | null>(null);

  async function handleSendCode() {
    setPending(true);
    setError(null);
    const supabase = createClient();
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    });
    setPending(false);

    if (otpError) {
      setError("Something went wrong sending the code. Please try again.");
      return;
    }
    setStep("code");
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const supabase = createClient();

    const { error: verifyError } = await supabase.auth.verifyOtp({
      email,
      token: code,
      type: "email",
    });
    if (verifyError) {
      setPending(false);
      setError("That code didn't work — check it and try again.");
      return;
    }

    const { data: grantData, error: grantError } = await supabase.rpc("grant_welcome_discount").single();
    const data = grantData as { discount_percent?: number | null } | null;
    setPending(false);

    if (grantError) {
      setError("Verified, but something went wrong granting your discount. Please refresh.");
      return;
    }
    setGrantedPercent(data?.discount_percent ?? null);
    setStep("done");
    router.refresh();
  }

  if (step === "done") {
    return (
      <div className="flex items-center gap-3 bg-orchard-green/10 border border-orchard-green/30 rounded-brand p-4">
        <span className="text-2xl" aria-hidden="true">
          🎉
        </span>
        <p className="text-sm text-ink">
          Email verified! {grantedPercent ? `You've earned ${grantedPercent}% off your next order — it'll show up at checkout.` : ""}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-gradient-to-r from-mango-orange to-mango-deep text-white rounded-brand p-5 shadow-brand-md">
      <div className="flex items-center gap-2 mb-1">
        <span aria-hidden="true">✉️</span>
        <h2 className="font-serif font-bold">Verify your email, get {discountPercent}% off</h2>
      </div>
      <p className="text-sm text-white/85 mb-3">
        Confirm {email} is really you and we&apos;ll add a one-time {discountPercent}% discount to
        your account.
      </p>

      {step === "prompt" ? (
        <button
          type="button"
          onClick={handleSendCode}
          disabled={pending}
          className="bg-white text-mango-deep font-semibold text-sm px-5 py-2 rounded-full disabled:opacity-60"
        >
          {pending ? "Sending…" : "Send Verification Code"}
        </button>
      ) : (
        <form onSubmit={handleVerify} className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="123456"
            className="border border-white/40 bg-white/10 placeholder-white/60 rounded-full px-4 py-2 text-sm text-white tracking-widest text-center w-32 focus:outline-none focus:border-white"
          />
          <button
            type="submit"
            disabled={pending || code.length < 4}
            className="bg-white text-mango-deep font-semibold text-sm px-5 py-2 rounded-full disabled:opacity-60"
          >
            {pending ? "Verifying…" : "Verify"}
          </button>
          <button
            type="button"
            onClick={handleSendCode}
            disabled={pending}
            className="text-xs font-semibold text-white/85 underline"
          >
            Resend code
          </button>
        </form>
      )}

      {error && <p className="text-xs text-white mt-2">{error}</p>}
    </div>
  );
}
