# Email Relay Consent — `client_email_relay_consent`

When a TTT consultant forwards a client's email to **`tina-bot@ttt-group.co.za`**, the bot reaches out to that client over WhatsApp and asks if they'd prefer to handle the question there instead. This document describes the end-to-end flow, confirms what's wired up, and gives the exact Meta template to submit.

---

## 1. End-to-end flow

```
Client → email → Consultant
                    │
                    └── Forward ──▶ tina-bot@ttt-group.co.za
                                             │
                                             ▼
                              Microsoft Graph push notification
                                             │
                                             ▼
                              POST /webhook/email  (Express)
                                             │
                                             ▼
                          parseForwarded() extracts:
                            - original sender's email
                            - original body
                            - forwarder identity
                                             │
                                             ▼
                          dynamicsService.getEntityByEmail()
                                             │
                          ┌──────────────────┴───────────────────┐
                          ▼                                      ▼
                  match + has mobile                    no match / no mobile
                          │                                      │
                          ▼                                      ▼
              Send template                          Email forwarder back:
              client_email_relay_consent             "I couldn't find a number
              (Yes / No quick replies)               for them, please reply
                          │                          with their mobile."
                          ▼
            Persist row in email_relay_pending
            (status='awaiting_consent', expires in 48h)
                          │
            ┌─────────────┼──────────────┐
            ▼             ▼              ▼
       client taps   client taps    48h elapse
         "Yes"         "No"             │
            │             │              │
            ▼             ▼              ▼
       AI answers    "No problem,    Forwarder gets
       the email     a consultant    "no response in
       over WA;      will be in      48h" email; row
       forwarder     touch shortly"  flips to 'expired'
       gets         + forwarder gets via cron sweep
       "accepted"   "declined" email
       email
```

---

## 2. Wiring — what's already implemented

All components below exist on `main` and are functional:

| Piece | File | Status |
|---|---|---|
| Inbound webhook route | [src/routes/email.route.ts](../src/routes/email.route.ts) | ✅ Registered at `/webhook/email` in [src/server.ts:29](../src/server.ts#L29) |
| Graph validation handshake | [src/routes/email.route.ts:38-46](../src/routes/email.route.ts#L38-L46) | ✅ Echoes `validationToken` |
| Graph subscription bootstrap | [src/scripts/create-graph-subscription.ts](../src/scripts/create-graph-subscription.ts) | ✅ Standalone script |
| Graph subscription renewal | [src/routes/cron.route.ts:66-95](../src/routes/cron.route.ts#L66-L95) | ✅ `/cron/graph-renew-subscription` daily |
| Forwarded-email parser | [src/services/forwardedEmail.service.ts](../src/services/forwardedEmail.service.ts) | ✅ Handles Outlook / Gmail / Apple Mail / Office 365 markers in EN/FR/NL/DE/ES |
| Dynamics email lookup | [src/services/dynamics.service.ts](../src/services/dynamics.service.ts) — `getEntityByEmail` | ✅ Resolves to contact / lead / user |
| Template send | [src/services/meta.service.ts:94-152](../src/services/meta.service.ts#L94-L152) — `sendTemplate` | ✅ Supports body vars + per-button payloads |
| Consent state persistence | `email_relay_pending` table — [supabase/migrations/20260507120000_email_relay_pending.sql](../supabase/migrations/20260507120000_email_relay_pending.sql) | ✅ Partial unique index enforces one active relay per phone |
| Yes/No button handling | [src/controllers/webhook.controller.ts:373-389](../src/controllers/webhook.controller.ts#L373-L389) | ✅ Routes `relay_yes` / `relay_no` payloads |
| Forwarder notifications | [src/controllers/emailRelay.controller.ts:46-125](../src/controllers/emailRelay.controller.ts#L46-L125) | ✅ Threads via Graph `/reply` endpoint |
| 48-hour expiry sweep | [src/controllers/emailRelay.controller.ts:301-309](../src/controllers/emailRelay.controller.ts#L301-L309) | ✅ Runs alongside subscription renewal |
| Idempotency on redelivery | [src/routes/email.route.ts:17-28](../src/routes/email.route.ts#L17-L28) + Supabase unique constraint on `graph_message_id` | ✅ |

**Template-name source of truth:**
- Code default: `client_email_relay_consent`
  ([src/controllers/emailRelay.controller.ts:9](../src/controllers/emailRelay.controller.ts#L9))
- Overridable via `WHATSAPP_RELAY_TEMPLATE_NAME` in `.env`
  ([.env.example:30](../.env.example#L30))
- Quick-reply payloads are hard-coded as `relay_yes` and `relay_no` — these **must** match what's configured in Meta.

---

## 3. Environment variables (must be set)

```env
GRAPH_TENANT_ID=...
GRAPH_CLIENT_ID=...
GRAPH_CLIENT_SECRET=...
GRAPH_SHARED_MAILBOX=tina-bot@ttt-group.co.za
GRAPH_WEBHOOK_BASE_URL=https://<public-https-domain>
GRAPH_WEBHOOK_CLIENT_STATE=<openssl rand -hex 32>

WHATSAPP_RELAY_TEMPLATE_NAME=client_email_relay_consent
WHATSAPP_RELAY_TEMPLATE_LANG=en
```

The Graph app reg is **separate** from the Dynamics one. `Mail.Read` + `Mail.Send` are granted via **Exchange RBAC for Applications scoped to the shared mailbox only** — no tenant-wide Graph permission in Entra. See [tarabot_mailbox memory](../../.claude/projects/-Users-lucduval-Documents-GitHub-ttt-whatsapp-bot/memory/tarabot_mailbox.md) for the RBAC commands.

---

## 4. The Meta template to submit

Submit in **Meta Business Manager → WhatsApp Manager → Message Templates → Create template**.

### Identity

| Field | Value |
|---|---|
| **Name** | `client_email_relay_consent` |
| **Category** | `UTILITY` |
| **Language** | `English` (`en`) |
| **Allow category change** | ✅ (let Meta downgrade if they disagree — we'd rather it ship as `MARKETING` than be rejected) |

### Components

**Header:** _none_

**Body:**
```
Hi {{customer_name}} 👋, I'm Tina,
TTT's 24/7 tax assistant.

We just received your email and I'd love to help you right here on WhatsApp. You can ask me anything tax-related, any time of day. Want me to assist over WhatsApp?
```

**Body variables:**

| Variable | Sample value | Source in code |
|---|---|---|
| `{{customer_name}}` | `John` | `firstName(entity.fullname, parsed.originalSenderEmail)` — first whitespace-delimited token of the Dynamics contact's `fullname`, falling back to the local part of their email |

> ⚠️ **Named vs. positional parameters:** This template uses a **named** variable (`{{customer_name}}`), not positional (`{{1}}`). The send-side code at [src/controllers/emailRelay.controller.ts](../src/controllers/emailRelay.controller.ts) passes `bodyNamedVariables: { customer_name: fname }`, and `sendTemplate()` in [src/services/meta.service.ts](../src/services/meta.service.ts) emits `parameter_name: 'customer_name'` on the body parameter. If you ever rename the template variable, update both the Meta template *and* the dictionary key in `emailRelay.controller.ts` together, or Meta will reject the send with a parameter-mismatch error.

> The body wording above is what `renderTemplateBody()` writes into Supabase conversation history when the template goes out. If you tweak the wording in Meta, **keep both copies in sync** — the WhatsApp view is what the client actually sees, but Supabase history seeds the next AI turn's context. The render lives at [src/controllers/emailRelay.controller.ts:23-25](../src/controllers/emailRelay.controller.ts#L23-L25).

**Footer:** _none_

**Buttons:** Two **Quick reply** buttons, both Type `Custom` (NOT call-to-action).

| # | Button text shown to client | Runtime payload |
|---|---|---|
| 0 | `Yes` | `relay_yes` |
| 1 | `No` | `relay_no` |

> The button **text** is purely cosmetic — "Yes" / "No" is fine, or replace with longer labels like `Yes, use WhatsApp` if you prefer (Meta caps text at 25 chars).
>
> The **payload** that the bot actually receives when the client taps is set per-message at send time by [src/controllers/emailRelay.controller.ts:227-231](../src/controllers/emailRelay.controller.ts#L227-L231) — `relay_yes` for index 0, `relay_no` for index 1. This overrides whatever Meta's template-builder would default to. Just keep the button **order** correct (Yes first, No second), because the index is positional.

### Sample preview rendered by Meta

```
┌────────────────────────────────────────────┐
│  Hi John 👋, I'm Tina,                    │
│  TTT's 24/7 tax assistant.                 │
│                                            │
│  We just received your email and I'd love │
│  to help you right here on WhatsApp. You  │
│  can ask me anything tax-related, any     │
│  time of day. Want me to assist over      │
│  WhatsApp?                                 │
│                                            │
│  ┌──────────────────────────────────────┐  │
│  │  Yes                                 │  │
│  ├──────────────────────────────────────┤  │
│  │  No                                  │  │
│  └──────────────────────────────────────┘  │
└────────────────────────────────────────────┘
```

---

## 5. Submission JSON (Cloud API equivalent)

If you submit via the Graph/Cloud API instead of the UI, here's the equivalent payload — useful for review and for diffing against what's live:

```json
{
  "name": "client_email_relay_consent",
  "language": "en",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "Hi {{customer_name}} 👋, I'm Tina,\nTTT's 24/7 tax assistant.\n\nWe just received your email and I'd love to help you right here on WhatsApp. You can ask me anything tax-related, any time of day. Want me to assist over WhatsApp?",
      "example": {
        "body_text_named_params": [
          { "param_name": "customer_name", "example": "John" }
        ]
      }
    },
    {
      "type": "BUTTONS",
      "buttons": [
        { "type": "QUICK_REPLY", "text": "Yes" },
        { "type": "QUICK_REPLY", "text": "No" }
      ]
    }
  ]
}
```

---

## 6. End-to-end test plan

Once the template is approved (status `🟢` in [meta-templates.md](./meta-templates.md)):

1. **Bootstrap the Graph subscription** (one-time, or after rotating `GRAPH_WEBHOOK_CLIENT_STATE`):
   ```bash
   npx tsx src/scripts/create-graph-subscription.ts
   ```
   Confirm: `listSubscriptions` returns one row pointing at `users/tina-bot@.../mailFolders('Inbox')/messages`.

2. **From a Gmail/Outlook account** that's recorded as a client contact in Dynamics with a valid `mobilephone`, send an email to a consultant.

3. **Consultant forwards** that email to `tina-bot@ttt-group.co.za`.

4. **Within ~30 seconds**, the client's WhatsApp should receive the `client_email_relay_consent` template with their first name interpolated.

5. **Check Supabase**:
   ```sql
   select id, status, original_sender_email, forwarder_email, expires_at
   from email_relay_pending
   order by created_at desc limit 5;
   ```
   Latest row should be `status='awaiting_consent'`.

6. **Tap "Yes"** on the client's phone. Expect:
   - Client sees: `Looking at your email about <subject>,\n\n<AI answer>`.
   - Consultant gets a reply email threaded under the original forward: `<client> accepted the WhatsApp relay — I'm answering their question over WhatsApp now.`
   - Supabase row flips to `status='accepted'`, `responded_at` populated.

7. **Repeat with "No"** on a fresh forward. Expect:
   - Client sees: `No problem, we'll keep things over email. A consultant will be in touch shortly.`
   - Consultant gets threaded reply: `<client> declined the WhatsApp relay — they'd prefer to keep things over email.`
   - Supabase row flips to `status='declined'`.

8. **Negative case — unknown sender:** forward an email from an address that's NOT in Dynamics. Expect:
   - No WhatsApp template fires.
   - Consultant gets threaded reply: `I couldn't find a WhatsApp number on record for them in Dynamics. If you'd like me to message them, please reply with their mobile number…`
   - Supabase row is `status='no_match'`.

9. **48h expiry:** forward an email, do not tap either button. Trigger the sweep manually:
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" \
        https://<your-domain>/cron/graph-renew-subscription
   ```
   After the 48h `expires_at` has passed, the next sweep run will:
   - Flip the row to `status='expired'`.
   - Email the consultant: `<client> didn't respond to my WhatsApp prompt within 48 hours.`

---

## 7. Known edge cases (handled, but worth knowing)

- **Forward has no parseable `From:` line.** Parser returns `null`; consultant is emailed back asking them to reply with the client's email + mobile manually. See [forwardedEmail.service.ts:114-124](../src/services/forwardedEmail.service.ts#L114-L124).
- **Graph redelivers the same notification.** The in-memory dedup map ([email.route.ts:17-28](../src/routes/email.route.ts#L17-L28)) catches it within 5 minutes; Supabase's `unique(graph_message_id)` is the durable backstop across cold starts.
- **A second forward arrives while a prior consent is still pending.** `supersedeActiveRelaysForPhone()` flips the old row to `superseded` before insert, so the partial unique index `email_relay_pending_one_active_per_phone_idx` stays satisfied and a stale Yes/No tap can't bind to the wrong forward.
- **Tina's own reply emails re-trigger the webhook.** The handler filters on `from === GRAPH_SHARED_MAILBOX` and returns early ([emailRelay.controller.ts:140-145](../src/controllers/emailRelay.controller.ts#L140-L145)).
- **Template send fails** (client not on WhatsApp, Meta cred issue). The pending row is marked `expired` immediately and the forwarder is emailed the Meta error.
