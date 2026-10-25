# WhatsApp order notifications — Phase 1

## Scope
This branch adds an optional WhatsApp Cloud API adapter to the storefront checkout and vendor order-management flows. Existing checkout, status changes, tracking updates, and email notifications remain authoritative.

## Configuration (Vercel Production and Preview as appropriate)
- `WHATSAPP_PHONE_NUMBER_ID`: Meta WhatsApp Business phone-number ID (not the display phone number).
- `WHATSAPP_ACCESS_TOKEN`: server-only access token with permission to send WhatsApp messages.
- `WHATSAPP_ORDER_TEMPLATE_NAME`: approved WhatsApp message-template name.
- `WHATSAPP_TEMPLATE_LANGUAGE`: optional language code; defaults to `en`.

Never use a `NEXT_PUBLIC_` prefix for these secrets. The approved template must have exactly five BODY variables in this order: order number, status, courier, tracking number, store name. Ensure the template is approved and recipients have opted in according to Meta's policies before enabling production sends.

## Current behavior
- A successful checkout schedules a best-effort “Order received” template notification.
- A real order status transition schedules a best-effort status notification.
- Courier/tracking number changes schedule a best-effort tracking notification.
- Missing configuration or invalid phone numbers are skipped safely; provider/network errors are logged server-side and never roll back the order.

## Limitations / follow-up
- This phase does not persist a notification outbox, provider message IDs, delivery webhooks, or retry state. Logs are not a durable delivery ledger.
- Validate the configured template and phone-number normalization with Meta test recipients before production.
- Meta account setup, template approval, opt-in, messaging charges/allowances, and business verification are outside the code branch.
- Do not describe a message as delivered solely because the API request was accepted.
