# Owner Workspace Boundary

The owner/co-founder workspace is implemented in `nashemann-admin`, not in public vendor storefronts. A storefront tenant is resolved from the request hostname by `src/lib/tenant.ts`; business-setting reads are filtered by the resolved `vendor.id`. Owner membership must never bypass tenant resolution or vendor row-level security.

Rules:
- Do not add owner dashboard, finance, governance, decision, or approval routes to storefronts.
- Never use an owner membership or capability as a substitute for a vendor/customer identity.
- Keep every vendor-scoped query tied to the resolved tenant and retain database RLS.
- Do not expose platform-wide GMV, revenue, vendor settlement, or internal governance data in storefront responses.

This is an explicit boundary for future cross-repository changes; no storefront runtime behavior is changed by this document.
