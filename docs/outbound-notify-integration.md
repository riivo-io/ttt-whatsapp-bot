# Outbound-notify integration

Senders that fire WhatsApp templates at TTT clients outside the bot (campaign
app, Power Automate flows) must notify Tina afterwards so she records the
outbound in session history and her next reply has context.

The contract is one POST per template send. See
[PRD-external-template-continuity.md](./PRD-external-template-continuity.md)
for the full design.

---

## Endpoint

```
POST https://<bot-host>/webhook/outbound-notify
Content-Type: application/json
X-Outbound-Signature: <HMAC-SHA256 of raw body, hex-encoded>
```

## Body

```json
{
  "phone": "+27821234567",
  "template_name": "referral_invite_v2",
  "template_language": "en",
  "template_variables": ["John"],
  "template_header_variable": "Q1 2026",
  "sender_message_id": "wamid.HBgLMjc4MjEyMzQ1NjcVAg...",
  "sent_at": "2026-06-01T10:00:00Z",
  "sender": "campaign_app"
}
```

| Field | Required | Notes |
|---|---|---|
| `phone` | yes | Any SA format; the bot normalises. |
| `template_name` | yes | Must match a Meta-approved template name. |
| `template_language` | no | Defaults to `"en"`. |
| `template_variables` | no | Ordered array, maps to `{{1}}`, `{{2}}`, … in the body. |
| `template_header_variable` | no | Only used for templates with a text header that contains `{{1}}`. Ignored for media headers. |
| `sender_message_id` | yes | Idempotency key. Pass Meta's `wamid` from the send response if you have it, otherwise any UUID. Retries MUST reuse the same value. |
| `sent_at` | yes | ISO 8601 timestamp. Stored on the seeded `messages` row. |
| `sender` | no | Free-text tag for logging. |

## Responses

| Status | Body | Meaning |
|---|---|---|
| 200 | `{ "ok": true, "seeded": true }` | Session upserted, history row inserted. |
| 200 | `{ "ok": true, "seeded": false, "reason": "duplicate" }` | `sender_message_id` already seen — no-op. |
| 400 | `{ "error": "missing_field", "field": "<name>" }` | Required field absent. |
| 401 | `{ "error": "bad_signature" }` | HMAC mismatch. |
| 404 | `{ "error": "template_not_found", "template_name": "..." }` | Template not approved in Meta or name typo. |
| 503 | `{ "error": "meta_unavailable" }` | Cache empty and Meta API failed — retry. |

---

## HMAC signing

Algorithm: HMAC-SHA256 over the **raw request body bytes** (not the parsed JSON
object), keyed with `OUTBOUND_NOTIFY_SECRET`, hex-encoded.

### TypeScript / Node (campaign sender, Convex actions)

```ts
import crypto from 'node:crypto';

const secret = process.env.OUTBOUND_NOTIFY_SECRET!;
const body = JSON.stringify({
    phone,
    template_name,
    template_language: 'en',
    template_variables: [firstName],
    sender_message_id: wamid,
    sent_at: new Date().toISOString(),
    sender: 'campaign_app',
});

const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');

await fetch('https://<bot-host>/webhook/outbound-notify', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'X-Outbound-Signature': signature,
    },
    body,
});
```

Fire-and-forget: log non-2xx but do NOT block the send loop. The next inbound
from that phone will simply lose context for that one template.

### Power Automate

Add an HTTP action after the "Send WhatsApp template" step. You'll need:

1. **Compose** — build the JSON body. Set the Inputs to the body object using
   PA expressions for the variables, e.g.:
   ```json
   {
     "phone": "@{triggerOutputs()?['body/mobilephone']}",
     "template_name": "invoice_pdf_v1",
     "template_language": "en",
     "template_variables": ["@{variables('firstName')}", "@{variables('invoicePeriod')}"],
     "sender_message_id": "@{body('Send_WhatsApp_template')?['messages'][0]['id']}",
     "sent_at": "@{utcNow()}",
     "sender": "power_automate"
   }
   ```

2. **Compose HMAC** — use the V3 connector's `binary()` + a JavaScript inline
   action (Premium) OR call a small Azure Function that takes `{body, secret}`
   and returns the hex signature. The standard PA expression library doesn't
   include HMAC; lifting the function from any other signed-webhook flow on
   the tenant is the fastest path.

3. **HTTP** — POST the body to the bot:
   - Method: `POST`
   - URI: `https://<bot-host>/webhook/outbound-notify`
   - Headers:
     - `Content-Type: application/json`
     - `X-Outbound-Signature: @{outputs('Compose_HMAC')}`
   - Body: `@{outputs('Compose')}`

PA's built-in retry policy reuses the same `sender_message_id` so duplicate
deliveries collapse to a `200 seeded: false` on the bot side.

---

## Operational notes

- The bot caches template wording from Meta with a 1-hour TTL. If a template's
  copy changes in Business Manager, hit `POST /admin/templates/refresh`
  (Bearer `CRON_SECRET`) for an instant flush, or just wait the hour.
- Sending to a phone that has no record in Dynamics is fine — the session row
  gets created with null CRM fields, same as today's cold inbound.
- Rotating `OUTBOUND_NOTIFY_SECRET` requires updating it on every sender in
  the same window. Old signatures stop validating immediately.
