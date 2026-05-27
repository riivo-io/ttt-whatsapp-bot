# Power Automate: Clickatell → Meta WhatsApp Cloud API migration

Reference for converting every `HTTP | Send WhatsApp` action in our Power Automate flows away from Clickatell and onto the same Meta WhatsApp Cloud API that Tina uses.

Use this as a checklist per flow. The mechanics are identical regardless of which template you're sending — only the `template.name`, the `parameters` array, and the buttons change.

---

## 1. One-time prerequisites (do these before touching any flow)

- **Recreate every Clickatell template inside Meta Business Manager** → WhatsApp Manager → Message templates. The template `name`, language, body variable count/order, and button configuration must match what the flow expects. Templates must be **approved by Meta** before they're callable from the API.
- **Add two new Power Automate environment variables** mirroring Tina's env:
  - `varMetaPhoneNumberId` — value of `META_PHONE_NUMBER_ID` (the sender phone number id)
  - `varMetaAccessToken` — value of `META_WHATSAPP_TOKEN` (permanent system-user token from the Meta App that powers Tina)
- **Phone number normalization.** Meta requires **digits only, E.164 without the leading `+`** (e.g. `27821234567`). If Dynamics stores `mobilephone` with `+`, spaces, or dashes, add a `Compose` step before the HTTP node that strips non-digits.

---

## 2. Node configuration — what changes on every HTTP action

| Field | Old (Clickatell) | New (Meta) |
|---|---|---|
| URI | `https://platform.clickatell.com/v1/message` | `https://graph.facebook.com/v22.0/@{parameters('varMetaPhoneNumberId')}/messages` |
| Method | `POST` | `POST` (unchanged) |
| `Authorization` header | `@parameters('varWhatsAppApiKey...')` | `Bearer @{parameters('varMetaAccessToken')}` |
| `Content-Type` header | `application/json` | `application/json` (unchanged) |
| `Accept` header | `application/json` | drop it (Meta ignores it) |

---

## 3. Request body — generic Meta blueprint

Replace the entire Clickatell body with this shape. Fill in the template-specific bits in the placeholders.

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "@{body('Get_a_row_by_ID_|_Contact')?['mobilephone']}",
  "type": "template",
  "template": {
    "name": "<TEMPLATE_NAME>",
    "language": { "code": "<LANG_CODE>" },
    "components": [
      {
        "type": "body",
        "parameters": [
          { "type": "text", "text": "<value for {{1}}>" },
          { "type": "text", "text": "<value for {{2}}>" }
        ]
      },
      {
        "type": "button",
        "sub_type": "url",
        "index": "0",
        "parameters": [
          { "type": "text", "text": "<dynamic URL suffix for button 0>" }
        ]
      }
    ]
  }
}
```

### Rules for filling in the blueprint

- **`<TEMPLATE_NAME>`** — exact name as approved in Meta (case-sensitive). Usually the same name we used in Clickatell.
- **`<LANG_CODE>`** — exact language code the template was approved under, commonly `en` or `en_US`. Pick the one that matches Meta and use it consistently.
- **Body parameters are positional.** The `parameters` array order maps to `{{1}}`, `{{2}}`, `{{3}}` in the template body. If a template was approved with **named** variables (`{{customer_name}}`) instead, each parameter object also needs `"parameter_name": "customer_name"` — see [src/services/meta.service.ts:114-122](src/services/meta.service.ts#L114-L122).
- **Drop the body component entirely** if the template body has no variables.
- **Button index is 0-based** (Meta), not 1-based (Clickatell's `listPosition`). The first button is `"index": "0"`.
- **URL button parameter is only the dynamic suffix**, not the full URL. The base URL is baked into the approved template; the API supplies only the variable tail.
- **Quick-reply buttons** use `"sub_type": "quick_reply"` and `parameters: [{ "type": "payload", "payload": "<payload string>" }]`.
- **No `messages: [...]` wrapper.** Meta sends one message per HTTP request.

---

## 4. Worked example — `referral_program_engagement2`

This is the exact translation of the existing Clickatell action for the "Referrer added to New Lead" flow.

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "@{body('Get_a_row_by_ID_|_Contact')?['mobilephone']}",
  "type": "template",
  "template": {
    "name": "referral_program_engagement2",
    "language": { "code": "en" },
    "components": [
      {
        "type": "body",
        "parameters": [
          { "type": "text", "text": "@{outputs('Get_a_row_by_ID_|_Contact')?['body/firstname']}" },
          { "type": "text", "text": "@{triggerOutputs()?['body/ttt_firstname']} @{triggerOutputs()?['body/ttt_lastname']}" },
          { "type": "text", "text": "@{body('Get_a_row_by_ID_|_Contact')?['riivo_referralcode']}" },
          { "type": "text", "text": "R@{string(outputs('Compose_|_Referral_Amount')[0])}" },
          { "type": "text", "text": "@{string(outputs('Compose_|_Referral_end_date')[0])}" }
        ]
      },
      {
        "type": "button",
        "sub_type": "url",
        "index": "0",
        "parameters": [
          { "type": "text", "text": "@{parameters('varwhatsappBubbleENV (riivo_varwhatsappBubbleENV)')}index" }
        ]
      }
    ]
  }
}
```

---

## 5. Reading the response

Successful Meta response shape:

```json
{
  "messaging_product": "whatsapp",
  "contacts": [{ "input": "...", "wa_id": "..." }],
  "messages": [{ "id": "wamid.HBgL..." }]
}
```

If a downstream step stored the Clickatell message id, switch it to:

```
@{body('HTTP_|_Send_WhatsApp')?['messages'][0]['id']}
```

Errors return non-2xx status with:

```json
{ "error": { "message": "...", "code": 123, "error_subcode": 456, "fbtrace_id": "..." } }
```

Existing `Configure run after` failure branches still fire correctly on non-2xx.

---

## 6. Per-flow checklist

For each HTTP action being migrated:

- [ ] Template exists and is approved in Meta Business Manager with the same name + matching variable count
- [ ] Confirm language code on the approved template (`en` vs `en_US` etc.)
- [ ] Confirm whether template uses positional `{{1}}` or named `{{name}}` variables
- [ ] URI updated to `https://graph.facebook.com/v22.0/@{parameters('varMetaPhoneNumberId')}/messages`
- [ ] `Authorization` header set to `Bearer @{parameters('varMetaAccessToken')}`
- [ ] `Accept` header removed
- [ ] Body replaced with the Meta blueprint (no `messages[]` wrapper, no `channel: "whatsapp"`)
- [ ] `to` value sanitized to digits-only E.164 (no leading `+`, no spaces)
- [ ] Body parameters listed in the right order (positional) or with `parameter_name` (named)
- [ ] Button `index` values are 0-based
- [ ] URL button parameter is the dynamic suffix only, not the full URL
- [ ] Test send to a known-good number, confirm message lands on WhatsApp
- [ ] Any downstream step that read the Clickatell response id updated to read `messages[0].id`

---

## 7. Roll-out order

1. Approve every required template inside Meta first — nothing can send until approval lands.
2. Clone one flow, migrate it, run a test send to an internal number, confirm receipt.
3. Migrate the remaining flows once the first one is proven.
4. Once every flow is on Meta, retire `varWhatsAppApiKey` so no live Clickatell credential is left behind.
