# Convex campaign sender — `/webhook/outbound-notify` setup

How to wire the Next.js + Convex campaign sender so every WhatsApp template
it fires at a TTT client is recorded in Tina's conversation history.

The bot side is described in
[outbound-notify-integration.md](./outbound-notify-integration.md). The
sibling PA spec lives in
[power-automate-outbound-notify-setup.md](./power-automate-outbound-notify-setup.md).
This doc is the Convex-implementation companion.

---

## 1. Context

### 1.1 What the bot does now

Tina (the WhatsApp bot at `ttt-prod-bot`) replies to inbound WhatsApp messages.
For every inbound it loads conversation history from Supabase
(`messages` table, keyed by `session_id`) and passes it to Claude so the reply
is in-context.

When a *different* system (the Convex campaign sender, Power Automate flows)
fires a WhatsApp template at a client, Tina has no record that it happened.
The session row may not even exist. The client's reply to that template lands
on the bot with no context — Tina answers "how can I help?" when the client
is replying to "want to refer a friend?".

### 1.2 What changes

The bot exposes `POST /webhook/outbound-notify` (HMAC-signed). After the
campaign sender successfully POSTs a template to Meta, it fires one extra
HTTP call to this endpoint with the template name, the variables it
substituted, and Meta's returned `wamid`. The bot:

1. Looks the template up in Meta's Business Management API (cached locally).
2. Composes the seeded body text (header + body + footer, with substitutions).
3. Inserts an `assistant`-role row into `messages` for that phone, keyed by
   the `wamid` so PA-style retries are idempotent.

The contract for the bot side is documented in
[outbound-notify-integration.md](./outbound-notify-integration.md). This doc
is the Convex-side companion.

### 1.3 Why fire-and-forget

Two principles:

1. **The campaign send is the load-bearing action.** If the notify call fails,
   the WhatsApp message still went out; the client still sees the template.
   Losing context-seeding for one send is acceptable. The bot's reply on the
   next inbound will be slightly less in-context — fine.

2. **Don't slow the campaign.** Notify is a best-effort side effect, not a
   blocking step. If a batch sends 200 templates, the notify calls run in
   parallel with the next send, not in series with the loop.

---

## 2. Prerequisites

### 2.1 Convex environment variables

Set on every Convex deployment (prod and dev):

```bash
npx convex env set BOT_HOST https://ttt-prod-bot-fpbwezdygqbdh8a7.southafricanorth-01.azurewebsites.net
npx convex env set OUTBOUND_NOTIFY_SECRET <hex-string>
```

The secret must match the value set on the bot's `ttt-prod-bot` App Service
(`OUTBOUND_NOTIFY_SECRET`). The current value is in 1Password / wherever
shared secrets live for TTT.

### 2.2 Approved template names

The bot looks up templates by exact name from Meta's
`/{WABA}/message_templates` endpoint. Names must match what's approved in
Meta Business Manager — if the campaign sends `referral_invite_v3` but Meta
only has `referral_invite_v2` approved, the notify call gets `404
template_not_found`.

Confirm the names the campaign sender uses against the approved list before
rolling out. Once a name matches, no further coordination is needed when
template wording changes — the bot re-fetches from Meta.

### 2.3 Node runtime in Convex

The helper uses `node:crypto` for HMAC. Convex actions run in a Node runtime
by default, so this works out of the box. If any Convex function the helper
is called from is annotated with `"use node"`, that's fine — actually
required for `crypto`.

---

## 3. Integration

### 3.1 The helper module

Drop this in `convex/lib/notifyTina.ts` (or wherever helpers live in the
campaign repo):

```ts
'use node';

import { createHmac } from 'node:crypto';

export interface NotifyTinaParams {
    /** Recipient phone in any SA format — bot normalises. */
    phone: string;
    /** Meta-approved template name. */
    templateName: string;
    /** Defaults to "en". */
    templateLanguage?: string;
    /**
     * Variables substituted into {{1}}, {{2}}, … in the body, in order.
     * Pass the literal strings the client saw — these become the seeded
     * history that Tina reads on the next inbound.
     */
    templateVariables?: string[];
    /** Only relevant when the template's header is text with a {{1}} variable. */
    templateHeaderVariable?: string;
    /** Meta's wamid from the send response. Required for dedup on bot side. */
    senderMessageId: string;
    /** ISO 8601 timestamp; defaults to now. */
    sentAt?: string;
    /** Free-text tag for bot logs — e.g. "campaign_referral", "campaign_winback". */
    sender?: string;
}

/**
 * Fire-and-forget POST to the bot's /webhook/outbound-notify so Tina records
 * the outbound template in conversation history. Failures are logged but
 * never thrown — the WhatsApp send has already happened, and the bot dedups
 * by sender_message_id so retries (manual or automatic) are safe.
 */
export async function notifyTinaOfOutboundTemplate(params: NotifyTinaParams): Promise<void> {
    const host = process.env.BOT_HOST;
    const secret = process.env.OUTBOUND_NOTIFY_SECRET;
    if (!host || !secret) {
        console.warn('[notifyTina] BOT_HOST or OUTBOUND_NOTIFY_SECRET not set — skipping');
        return;
    }

    const body = JSON.stringify({
        phone: params.phone,
        template_name: params.templateName,
        template_language: params.templateLanguage ?? 'en',
        template_variables: params.templateVariables ?? [],
        template_header_variable: params.templateHeaderVariable,
        sender_message_id: params.senderMessageId,
        sent_at: params.sentAt ?? new Date().toISOString(),
        sender: params.sender ?? 'campaign_app',
    });

    const signature = createHmac('sha256', secret).update(body).digest('hex');

    try {
        const res = await fetch(`${host}/webhook/outbound-notify`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Outbound-Signature': signature,
            },
            body,
        });
        if (!res.ok) {
            console.warn(
                `[notifyTina] ${res.status} for ${params.templateName} → ${params.phone}: ${await res.text()}`,
            );
        }
    } catch (e: any) {
        console.warn(
            `[notifyTina] fetch failed for ${params.templateName} → ${params.phone}: ${e?.message || e}`,
        );
    }
}
```

Notes on the implementation:

- **Stringify once.** The body is signed and POSTed as the same `body`
  variable. Re-serialising would break the HMAC.
- **No throw.** All paths catch and log. The caller never needs to wrap this
  in try/catch.
- **No retry.** The bot dedups; if a transient failure drops a single notify,
  that's acceptable (history loses one entry for one send). Don't add an
  in-Convex retry loop — it only multiplies log noise.

### 3.2 Calling it from the send action

Find every Convex action that sends a WhatsApp template (POSTs to
`graph.facebook.com/.../messages` with `type: 'template'`). Each one needs
roughly this shape:

```ts
'use node';

import { action } from './_generated/server';
import { v } from 'convex/values';
import { notifyTinaOfOutboundTemplate } from './lib/notifyTina';

export const sendReferralInvite = action({
    args: { phone: v.string(), firstName: v.string() },
    handler: async (ctx, { phone, firstName }) => {
        const token = process.env.META_WHATSAPP_TOKEN!;
        const phoneNumberId = process.env.META_PHONE_NUMBER_ID!;

        // 1. Send the template via Meta.
        const metaRes = await fetch(
            `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    messaging_product: 'whatsapp',
                    to: phone,
                    type: 'template',
                    template: {
                        name: 'ttt_referral_welcome',
                        language: { code: 'en' },
                        components: [
                            {
                                type: 'body',
                                parameters: [{ type: 'text', text: firstName }],
                            },
                        ],
                    },
                }),
            },
        );

        const sendResult = await metaRes.json();
        if (!metaRes.ok) {
            console.error(`[referral] Meta send failed for ${phone}:`, sendResult);
            return { sent: false, error: sendResult?.error?.message };
        }

        const wamid: string | undefined = sendResult?.messages?.[0]?.id;
        if (!wamid) {
            console.warn(`[referral] Meta returned no wamid for ${phone}`);
            return { sent: true, notified: false };
        }

        // 2. Notify Tina of the outbound. Fire-and-forget — don't await in
        // a way that holds up downstream work, but DO await so Convex doesn't
        // tear the action down before fetch resolves. The helper resolves
        // fast (one HTTP round-trip) and never throws.
        await notifyTinaOfOutboundTemplate({
            phone,
            templateName: 'ttt_referral_welcome',
            templateVariables: [firstName],
            senderMessageId: wamid,
            sender: 'campaign_referral',
        });

        return { sent: true, notified: true, wamid };
    },
});
```

### 3.3 Mapping each existing send

For every existing Convex template-send action, the change is mechanical:

1. Capture the wamid (`sendResult.messages[0].id`) — most actions already do
   this for logging; if not, add it.
2. After a successful Meta send, call `notifyTinaOfOutboundTemplate` with:
   - `phone`, `templateName` — what you sent.
   - `templateVariables` — same array/order you passed to Meta, expanded to
     the substituted strings. If you computed `firstName = "John"`,
     pass `['John']`; do **not** pass the placeholder `{{1}}`.
   - `senderMessageId` — the wamid.
   - `sender` — a stable tag per action: `'campaign_referral'`,
     `'campaign_winback'`, `'campaign_promo_july'`, etc. These show up in
     bot logs as `[OutboundNotify] sender=X` and let you debug which sender
     is using a stale template name.
3. Don't gate on the notify result. The action's success/failure is determined
   by the Meta send.

### 3.4 Edge cases

- **Send to a number that isn't on WhatsApp**: Meta returns an error and no
  wamid. Skip the notify (the `if (!wamid)` guard above).
- **Meta returns 5xx**: same — no wamid, skip the notify.
- **Template has no body variables**: pass `templateVariables: []` (or omit).
- **Template with a media header (image/video/doc)**: the bot prepends a
  `[image]` / `[video]` / `[document]` marker to the seeded history. Nothing
  for the campaign sender to do.
- **Template with a text header that has a `{{1}}` variable**: Meta caps text-
  header variables at 1. Pass the substituted value as `templateHeaderVariable`,
  not in `templateVariables`. Meta API call structure mirrors this — the
  header variable is in `components[].type === 'header'`, the body variables
  are in `components[].type === 'body'`.

---

## 4. Testing

### 4.1 Local smoke against the deployed bot

From a Convex dev deployment (or anywhere with the env vars set), call the
helper directly:

```ts
import { notifyTinaOfOutboundTemplate } from './lib/notifyTina';

await notifyTinaOfOutboundTemplate({
    phone: '+27XXXXXXXXX',         // your own number
    templateName: 'ttt_referral_welcome',
    templateVariables: ['Luc'],
    senderMessageId: `test-${Date.now()}`,
    sender: 'manual_test',
});
```

Then in Supabase:

```sql
select id, role, content, external_id, timestamp
from messages
where external_id like 'test-%'
order by timestamp desc
limit 5;
```

Expect a fresh row with `role='assistant'`, `content` containing the
substituted template body, `external_id` matching what you passed.

Re-run with the same `senderMessageId` → no new row (dedup works).

### 4.2 End-to-end with a real send

Pick one real referral / promo send. Trigger it for your own phone. Check:

1. WhatsApp delivers the template.
2. Supabase has the corresponding `messages` row with `external_id` = the
   wamid.
3. Reply to the template on your phone. Tina's first response should
   reference the template content (e.g. acknowledge the referral context)
   rather than asking "how can I help?".

### 4.3 What "broken" looks like

| Symptom | Likely cause |
|---|---|
| `401 bad_signature` | `OUTBOUND_NOTIFY_SECRET` mismatch between Convex and the bot. |
| `404 template_not_found` | `templateName` doesn't match an APPROVED template in Meta for this WABA. Typo, or template not yet promoted from "In review". |
| `400 missing_field` | One of `phone`, `template_name`, `sender_message_id`, `sent_at` is absent. The helper guards this — check Convex logs for fetch-side errors. |
| `503 meta_unavailable` | Bot couldn't reach Meta's `message_templates` API. Transient. Single notify lost; non-blocking. |
| Notify succeeds but Tina still has no context on reply | Phone normalisation issue. Confirm the same number format flows from Convex → Meta → reply → Supabase session. The bot's `phoneVariants` should handle `+27` / `27` / `0` prefixes. |

---

## 5. Rollout

1. **Wire one low-volume campaign first** (e.g. a referral flow targeting
   internal testers).
2. Deploy to Convex prod with `BOT_HOST` and `OUTBOUND_NOTIFY_SECRET` set.
3. Fire 5–10 sends. Confirm via Supabase + a real reply that history seeding
   works.
4. Then wire the higher-volume campaigns one by one.
5. Watch Convex logs for `[notifyTina]` warnings and the bot's
   `[OutboundNotify]` lines for the first week. Single-digit
   `seeded: false, reason: "duplicate"` is expected (occasional retries);
   anything else (`404`, `401`, repeated `5xx`) needs investigation.

---

## 6. Operational notes

- **Secret rotation**: when `OUTBOUND_NOTIFY_SECRET` rotates, update it on
  the bot's App Service config AND in Convex env in the same window. Old
  signatures stop validating immediately on the bot side; campaigns mid-
  flight when you rotate will log `401 bad_signature` for the residual
  notifies — non-blocking, so fine.

- **`BOT_HOST` change**: if the bot moves to a custom domain
  (e.g. `bot.ttt-tax.co.za`), update the Convex env. Old hostname keeps
  working via the Azure default domain until Azure removes it.

- **Template wording changes**: nothing to do in Convex. The bot's template
  registry refetches from Meta every hour. For an instant flush after a
  manual approval, hit `POST /admin/templates/refresh` on the bot.

- **Sending to clients who haven't opened the 24-hour customer-service
  window**: this is the standard Meta-template use case — no change to your
  existing logic. The notify call is purely metadata; it doesn't affect
  message delivery or pricing.

- **Cold phone numbers**: if the recipient has no Supabase session and isn't
  known to Dynamics, the bot creates a session row with null CRM fields,
  same as today's cold-inbound behavior. The seeded message lands on that
  session and is picked up if/when the client replies.
