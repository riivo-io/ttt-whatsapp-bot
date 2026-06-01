# Power Automate — `/webhook/outbound-notify` setup

How to wire every Dynamics-triggered Power Automate flow that sends a WhatsApp
template (invoice PDFs, case-status updates, LoE-stage prompts, etc.) so Tina
records the send in conversation history.

The bot side is described in
[outbound-notify-integration.md](./outbound-notify-integration.md). This doc
is the PA-implementation companion.

---

## 1. Architecture

```
Dynamics trigger
   │
   ▼
Existing PA flow ─── send WhatsApp template (Meta Graph API call)
   │                    │
   │                    └── returns { messages: [{ id: "wamid.…" }] }
   │
   ▼
Call child flow: "Notify Tina of outbound template"
   │
   ├── Inputs: phone, template_name, template_variables[], header_var?, wamid, sent_at, sender
   │
   ├── Compute HMAC-SHA256 over the JSON body (via Azure Function)
   │
   └── HTTP POST to /webhook/outbound-notify with X-Outbound-Signature header
```

Every parent flow's job stays the same: send the template, then invoke one
shared child flow with the relevant fields. The HMAC + HTTP plumbing lives in
the child, so adding a new sender flow takes minutes.

---

## 2. Prerequisites

### 2.1 Bot side (already done)
- `WHATSAPP_BUSINESS_ACCOUNT_ID` and `OUTBOUND_NOTIFY_SECRET` set on the
  `ttt-prod-bot` App Service.
- Bot deployed with the outbound-notify route live.
- Bot reachable at `https://ttt-prod-bot-fpbwezdygqbdh8a7.southafricanorth-01.azurewebsites.net`.

### 2.2 Azure Function for HMAC
PA's standard expression library has no HMAC-SHA256 primitive, so we offload
the signature step to a tiny HTTP-triggered Azure Function. One-time deploy,
reused by every flow.

**Why a Function and not inline JavaScript or a Logic Apps action**:
- Inline JS in PA requires Premium licensing per flow.
- A Function lives once, is testable in isolation, and keeps the secret out
  of every flow's definition (the secret lives in the Function App's
  Configuration, not in PA variables).

### 2.3 Permissions
The PA service account needs:
- "Send WhatsApp template" action (already in use).
- HTTP connector enabled (standard, no premium required).
- Ability to call the Azure Function URL.

---

## 3. Set up the HMAC Azure Function

### 3.1 Create the Function App

In the Azure portal:
1. Create a new Function App in the same resource group as `ttt-prod-bot`
   (or wherever you keep shared infra). Region: South Africa North to match.
2. Runtime stack: **Node.js 20 LTS**.
3. Plan: **Consumption** is fine — usage is a few calls per minute peak.
4. Name: `ttt-hmac-signer` (or whatever your naming convention dictates).

### 3.2 Function code

Add one HTTP-trigger function. Path: `POST /api/sign`. Authentication level:
**Function** (so PA must pass a function key — this prevents anyone with the
URL from minting valid signatures).

```javascript
// /api/sign — HMAC-SHA256(body) → hex
const crypto = require('crypto');

module.exports = async function (context, req) {
    const secret = process.env.OUTBOUND_NOTIFY_SECRET;
    if (!secret) {
        context.res = { status: 500, body: { error: 'secret_not_configured' } };
        return;
    }

    const body = req.body?.payload;
    if (typeof body !== 'string') {
        context.res = { status: 400, body: { error: 'payload_must_be_string' } };
        return;
    }

    const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
    context.res = { status: 200, body: { signature } };
};
```

The Function takes `{ "payload": "<the exact JSON string we'll POST to the
bot>" }` and returns `{ "signature": "<hex>" }`. We pass `payload` as a
pre-stringified value so PA controls exact byte ordering — the HMAC is over
those exact bytes, so we must avoid PA re-serialising the JSON.

### 3.3 Function App configuration

In the Function App's Configuration → Application settings, add:

| Name | Value |
|---|---|
| `OUTBOUND_NOTIFY_SECRET` | `7a8d5e25ed2ee2dfea808ceb98867822a3a9fe5fec42a5d335aedf8f839a9f8c` (must match the bot's value) |

Save and restart the Function App.

### 3.4 Test the Function

Grab the function URL (Function App → Functions → sign → Get function URL).
It looks like:
```
https://ttt-hmac-signer.azurewebsites.net/api/sign?code=<function-key>
```

Test from your laptop:
```bash
curl -X POST 'https://ttt-hmac-signer.azurewebsites.net/api/sign?code=<function-key>' \
  -H 'Content-Type: application/json' \
  -d '{"payload":"{\"hello\":\"world\"}"}'
```
Expect: `{ "signature": "<64-hex-char-string>" }`.

Verify with `openssl` on your laptop using the same secret — both should
produce the same hex.

---

## 4. Build the child flow: "Notify Tina of outbound template"

Power Automate → Solutions → your TTT solution → New → Cloud flow → Manually
triggered, or "When an HTTP request is received" (instant), or a child flow
called from parent flows. Use **child flow** so parents can invoke it cleanly.

### 4.1 Inputs

The child flow takes:

| Input | Type | Notes |
|---|---|---|
| `phone` | string | E.g. `+27821234567`. |
| `template_name` | string | Meta-approved template name. |
| `template_language` | string | Usually `"en"`. |
| `template_variables` | string | JSON-encoded array, e.g. `["John","May 2026"]`. PA child-flow inputs don't support arrays cleanly, so pass as string and let the child parse / interpolate. |
| `template_header_variable` | string | Optional. Empty string if not used. |
| `sender_message_id` | string | The wamid from Meta's response. |
| `sent_at` | string | ISO 8601, e.g. `utcNow()` from the parent. |
| `sender` | string | `"power_automate_invoice"`, `"power_automate_status"`, etc — useful in logs. |

### 4.2 Step 1 — Compose the JSON body

Add a "Compose" action named `Compose body`. Inputs (raw JSON):

```json
{
  "phone": "@{triggerBody()?['phone']}",
  "template_name": "@{triggerBody()?['template_name']}",
  "template_language": "@{coalesce(triggerBody()?['template_language'], 'en')}",
  "template_variables": @{if(empty(triggerBody()?['template_variables']), json('[]'), json(triggerBody()?['template_variables']))},
  "template_header_variable": "@{triggerBody()?['template_header_variable']}",
  "sender_message_id": "@{triggerBody()?['sender_message_id']}",
  "sent_at": "@{triggerBody()?['sent_at']}",
  "sender": "@{triggerBody()?['sender']}"
}
```

Critical: the **string** you sign and the **string** you POST must be byte-
identical. PA's Compose action gives you that — both subsequent steps
reference `outputs('Compose_body')`.

### 4.3 Step 2 — Stringify for signing

Add another Compose action named `Compose stringified`. Inputs:
```
@{string(outputs('Compose_body'))}
```

This produces the JSON-as-a-string that the HMAC will sign and the HTTP body
will send.

### 4.4 Step 3 — Call the HMAC Function

Add an HTTP action named `Compute HMAC`. Configure:

- Method: `POST`
- URI: `https://ttt-hmac-signer.azurewebsites.net/api/sign?code=@{parameters('HmacFunctionKey')}`
- Headers: `Content-Type: application/json`
- Body:
  ```json
  { "payload": "@{outputs('Compose_stringified')}" }
  ```

Store the function key as a **Solution environment variable** named
`HmacFunctionKey` so it isn't hard-coded into flow JSON. Solution → Environment
variables → New → secret type → paste the function key.

### 4.5 Step 4 — Parse the signature

Add a Parse JSON action named `Parse HMAC response`. Schema:
```json
{
  "type": "object",
  "properties": {
    "signature": { "type": "string" }
  }
}
```
Content: `@{body('Compute_HMAC')}`.

### 4.6 Step 5 — POST to the bot

Add an HTTP action named `Notify Tina`:
- Method: `POST`
- URI: `https://ttt-prod-bot-fpbwezdygqbdh8a7.southafricanorth-01.azurewebsites.net/webhook/outbound-notify`
- Headers:
  - `Content-Type`: `application/json`
  - `X-Outbound-Signature`: `@{body('Parse_HMAC_response')?['signature']}`
- Body: `@{outputs('Compose_stringified')}`

  *Important*: use `outputs('Compose_stringified')`, **not**
  `outputs('Compose_body')`. The HTTP body sent must be the exact same string
  the HMAC was computed over, byte for byte. If you reference the object form,
  PA re-serialises it and you get a 401 bad_signature on the bot side.

### 4.7 Step 6 — Handle response

After `Notify Tina`, add a Condition:
- If `outputs('Notify_Tina')['statusCode']` is `200` → done.
- Else → log to a SharePoint list / Azure Storage / wherever you collect PA
  errors. Don't fail the parent flow; the original WhatsApp template already
  went through — losing context-seeding for one send is acceptable.

PA's default retry policy on the HTTP action handles transient failures. The
bot dedups by `sender_message_id`, so retries are safe.

---

## 5. Wire each parent flow to the child

For each existing flow that sends a WhatsApp template (invoices, status
updates, LoE-stage prompts, etc.):

1. Locate the "Send WhatsApp template" action (probably an HTTP call to
   `graph.facebook.com/v22.0/{phone_number_id}/messages`).
2. After it succeeds, add a **Parse JSON** action on the response. Schema
   includes `messages[0].id` → that's the wamid.
3. Add a **Run a Child Flow** action invoking "Notify Tina of outbound
   template". Pass:
   - `phone`: the recipient's phone from the trigger.
   - `template_name`: the literal template name your flow uses.
   - `template_language`: `"en"` (or whatever you sent).
   - `template_variables`: JSON-encoded array of the variables you passed
     to Meta, in the same order. E.g.
     `concat('["', variables('firstName'), '","', variables('invoicePeriod'), '"]')`.
   - `template_header_variable`: leave empty unless the template has a text
     header with `{{1}}`.
   - `sender_message_id`: `body('Parse_send_response')?['messages']?[0]?['id']`.
   - `sent_at`: `utcNow()`.
   - `sender`: a flow-identifying string like `"power_automate_invoice"`.

That's it. The child flow handles signing and posting.

---

## 6. Templates to wire (initial scope)

| Flow | Template name (placeholder) | Owner |
|---|---|---|
| Invoice PDF / billing | `invoice_pdf_v1` | (assign) |
| Case status update | `case_status_update_v1` | (assign) |
| Document received confirmation | `doc_received_v1` | (assign) |
| LoE-stage prompts (post-LoE follow-up) | `loe_stage_followup_v1` | (assign) |

Names are placeholders — replace with the actual approved names you'll find
in Meta Business Manager. The bot's template registry will tell you if a name
is wrong — you'll get `404 template_not_found` in the PA HTTP response.

---

## 7. Rollout sequence

Lowest-risk first so HMAC plumbing is validated before high-volume flows ride
on it:

1. **Pick one low-volume flow** (likely case status update).
2. Wire it to the child flow.
3. Trigger a real send to your own number.
4. Verify in Supabase: `select * from messages where external_id like 'wamid.%' order by timestamp desc limit 5;` — the new row should be there.
5. Reply to the template on your phone — confirm Tina's response references
   the template content sensibly.
6. **Then** wire the next flow. Repeat.
7. Monitor for one week:
   - PA HTTP-action failure rate (any non-200 from the bot).
   - Bot logs: `[OutboundNotify] template_not_found` (sender used wrong name)
     or `[OutboundNotify] bad_signature` (HMAC plumbing broken in a flow).

---

## 8. Testing without spamming clients

Build a separate test flow that:
1. Sends a template to your own WhatsApp number using Meta's API directly
   (or via an existing send action with a hard-coded phone).
2. Invokes the child flow.
3. Verifies the 200 response.

Run it after every change to the child flow. Keep it out of the production
solution.

---

## 9. Operational notes

- **Secret rotation**: when `OUTBOUND_NOTIFY_SECRET` rotates, update both the
  bot's App Service config AND the Function App's config in the same window.
  No flow changes needed — the child flow reads from the Function, which
  reads from its own env. Rotate the function key (`HmacFunctionKey`)
  independently if anyone outside the team gets the function URL.

- **Idempotency**: PA's default retry on the bot HTTP action reuses the same
  `sender_message_id` (it's in the bound payload), so duplicate calls collapse
  to a `200 { seeded: false, reason: "duplicate" }` on the bot side. No
  history pollution.

- **Failed sends**: if the WhatsApp send itself failed (no wamid returned),
  don't call the child flow. There's nothing to seed.

- **Templates without body variables**: pass `"[]"` for `template_variables`.

- **Templates with text-header variables**: pass the header substitution in
  `template_header_variable` and a single-element array `["..."]` if there's
  also one body variable. Meta caps text-header variables at 1.
