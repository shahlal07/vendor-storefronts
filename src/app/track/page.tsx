import { Suspense } from "react";
import { TrackForm } from "@/components/track-form";
import { getSiteChrome } from "@/lib/queries/site";

export default async function TrackPage() {
  const { vendor, settings } = await getSiteChrome();
  const whatsappNumber = settings?.support_whatsapp ?? vendor?.whatsapp_number ?? null;

  return (
    <div className="px-[5%] py-10 max-w-3xl mx-auto">
      <h1 className="font-serif text-3xl font-bold mb-2">Track Your Order</h1>
      <p className="text-ink-light mb-8">
        Enter your order number below to see its current status.
      </p>
      <Suspense>
        <TrackForm whatsappNumber={whatsappNumber} />
      </Suspense>
    </div>
  );
}
