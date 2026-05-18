# WhatsApp Sign-up Flow

A sign-up-only WhatsApp Flow that replaces the plain sign-up link we currently
send to unknown phone numbers ([webhook.controller.ts:157-164](../src/controllers/webhook.controller.ts#L157-L164)).
The Flow collects the bare-minimum lead info and writes it straight to Dynamics
via [`dynamicsService.createLead`](../src/services/dynamics.service.ts#L762).
The website form at `https://ttt-tax.co.za/client-onboarding` remains available
as an alternative — it's exposed as an `EmbeddedLink` on the sign-up screen.

## Why sign-up only (no sign-in / forgot-password)

The WhatsApp sender's phone number *is* the identity — [`resolveSender`](../src/controllers/webhook.controller.ts#L22)
matches it against Dynamics `contacts` / `new_leads` on every inbound message.
If the phone is already known, the bot routes them to the normal assistant
without ever showing this Flow. The Flow only fires for unknown numbers, so
"sign in" has no meaning here.

## Field → Dynamics mapping

| Flow field            | `createLead` param | Dynamics column           | Notes                                                 |
| --------------------- | -------------------- | ------------------------- | ----------------------------------------------------- |
| `first_name`        | `firstName`        | `ttt_firstname`         | Required                                              |
| `last_name`         | `lastName`         | `ttt_lastname`          | Required                                              |
| `email`             | `email`            | `ttt_email`             | Required (validated as email by Flow)                 |
| `client_type`       | `clientType`       | `riivo_clienttype`      | Choice — see mapping below                           |
| `service_needed`    | `leadType`         | `riivo_leadtype`        | Choice — see mapping below                           |
| `notes`             | `notes`            | `riivo_notes`           | Optional free text ("How can we help?")               |
| `terms_agreement`   | —                   | — (gate only)            | Required OptIn; blocks submit if false                |
| `offers_acceptance` | —                   | marketing opt-in (future) | Optional                                              |
| *(sender phone)*    | `phone`            | `ttt_mobilephone`       | Taken from `from` on the webhook — not in the form |

### Choice mappings (already live in `createLead`)

- `riivo_clienttype`: `0=Individual`, `1=Business`, `2=Private Company`, `3=Closed Corp`, `4=Business Trust`, `5=Sole Prop`
- `riivo_leadtype`: `100000000=Tax`, `100000001=Accounting`, `463630001=Long Term Insurance`, `463630002=Short Term Insurance`

The Flow surfaces these as `Dropdown` components with the option-set integers
as the `id` value, so the webhook can pass them straight through.

## Submit behaviour — no endpoint needed

The Flow's final button uses the `complete` action, which closes the Flow
client-side and posts the collected form data back through the standard
WhatsApp webhook as an `interactive` message of type `nfm_reply`. No separate
encrypted endpoint, no RSA keys, no AES-GCM handshake.

The handler in [`webhook.controller.ts`](../src/controllers/webhook.controller.ts)
detects `nfm_reply`, parses `response_json`, and calls
`dynamicsService.createLead({ firstName, lastName, email, phone, clientType, leadType, notes })`.

- `phone` is the sender's number from the webhook — not in the form.
- `industryId` and `ownerSystemUserId` are left unset for self-service leads;
  a staff member picks these up once the lead lands in Dynamics.
  ([dynamics.service.ts:770-777](../src/services/dynamics.service.ts#L770-L777) —
  these fields are business-required for staff-driven creation but the
  self-service path will default them server-side if Dataverse requires it.)
- The next inbound message from the same phone will resolve cleanly via
  [`dynamicsService.getContactByPhone`](../src/services/dynamics.service.ts#L322),
  so no session seeding is needed on the sign-up itself — we just send a
  plain WhatsApp confirmation ("Thanks, {first_name} — a consultant will be
  in touch shortly.") and return.

Tradeoff: no mid-flow server validation (e.g., "that email is already
registered" error screen). If a bad submit slips through, we respond with a
plain WhatsApp reply after the fact.

## Flow JSON

```json
{
    "version": "7.3",
    "routing_model": {
        "SIGN_UP": ["TERMS_AND_CONDITIONS"],
        "TERMS_AND_CONDITIONS": []
    },
    "screens": [
        {
            "id": "SIGN_UP",
            "title": "Sign up to TTT",
            "terminal": true,
            "success": true,
            "data": {},
            "layout": {
                "type": "SingleColumnLayout",
                "children": [
                    {
                        "type": "TextHeading",
                        "text": "Welcome to TTT Financial Group"
                    },
                    {
                        "type": "TextBody",
                        "text": "Tell us a bit about yourself and a consultant will be in touch."
                    },
                    {
                        "type": "Form",
                        "name": "sign_up_form",
                        "children": [
                            {
                                "type": "TextInput",
                                "required": true,
                                "label": "First name",
                                "name": "first_name",
                                "input-type": "text"
                            },
                            {
                                "type": "TextInput",
                                "required": true,
                                "label": "Last name",
                                "name": "last_name",
                                "input-type": "text"
                            },
                            {
                                "type": "TextInput",
                                "required": true,
                                "label": "Email address",
                                "name": "email",
                                "input-type": "email"
                            },
                            {
                                "type": "Dropdown",
                                "required": true,
                                "label": "I am a…",
                                "name": "client_type",
                                "data-source": [
                                    { "id": "0", "title": "Individual" },
                                    { "id": "1", "title": "Business" },
                                    { "id": "2", "title": "Private Company" },
                                    { "id": "3", "title": "Closed Corporation" },
                                    { "id": "4", "title": "Business Trust" },
                                    { "id": "5", "title": "Sole Proprietor" }
                                ]
                            },
                            {
                                "type": "Dropdown",
                                "required": true,
                                "label": "Service needed",
                                "name": "service_needed",
                                "data-source": [
                                    { "id": "100000000", "title": "Tax" },
                                    { "id": "100000001", "title": "Accounting" },
                                    { "id": "463630001", "title": "Long Term Insurance" },
                                    { "id": "463630002", "title": "Short Term Insurance" }
                                ]
                            },
                            {
                                "type": "TextArea",
                                "required": false,
                                "label": "Anything to add?",
                                "name": "notes",
                                "helper-text": "A short note helps us route you to the right consultant."
                            },
                            {
                                "type": "TextInput",
                                "required": false,
                                "label": "Referral code",
                                "name": "referral_code",
                                "input-type": "text",
                                "helper-text": "Optional — if a TTT client referred you, enter their code here."
                            },
                            {
                                "type": "OptIn",
                                "name": "terms_agreement",
                                "label": "I agree to the terms and privacy policy.",
                                "required": true,
                                "on-click-action": {
                                    "name": "navigate",
                                    "next": {
                                        "type": "screen",
                                        "name": "TERMS_AND_CONDITIONS"
                                    },
                                    "payload": {}
                                }
                            },
                            {
                                "type": "OptIn",
                                "name": "offers_acceptance",
                                "label": "Send me occasional TTT tax & finance tips.",
                                "required": false
                            },
                            {
                                "type": "EmbeddedLink",
                                "text": "Sign up on our website",
                                "on-click-action": {
                                    "name": "open_url",
                                    "url": "https://ttt-tax.co.za/client-onboarding"
                                }
                            },
                            {
                                "type": "Footer",
                                "label": "Sign up",
                                "on-click-action": {
                                    "name": "complete",
                                    "payload": {
                                        "first_name": "${form.first_name}",
                                        "last_name": "${form.last_name}",
                                        "email": "${form.email}",
                                        "client_type": "${form.client_type}",
                                        "service_needed": "${form.service_needed}",
                                        "notes": "${form.notes}",
                                        "referral_code": "${form.referral_code}",
                                        "terms_agreement": "${form.terms_agreement}",
                                        "offers_acceptance": "${form.offers_acceptance}"
                                    }
                                }
                            }
                        ]
                    }
                ]
            }
        },
        {
            "id": "TERMS_AND_CONDITIONS",
            "title": "Terms & Privacy",
            "data": {},
            "layout": {
                "type": "SingleColumnLayout",
                "children": [
                    {
                        "type": "TextHeading",
                        "text": "TTT Financial Group — Terms"
                    },
                    {
                        "type": "TextSubheading",
                        "text": "How we use your data"
                    },
                    {
                        "type": "TextBody",
                        "text": "By signing up you agree that TTT Financial Group may contact you via WhatsApp, email or phone in connection with the services you've requested. We store your details in our client management system (Microsoft Dynamics) under South African POPIA requirements."
                    },
                    {
                        "type": "TextSubheading",
                        "text": "Privacy policy"
                    },
                    {
                        "type": "TextBody",
                        "text": "We never share your information with third parties outside of the professionals engaged on your matter (SARS, auditors, insurers, etc. as required by the service you've asked for). You can opt out of WhatsApp at any time by replying STOP, or email privacy@ttt-tax.co.za to request your data be removed."
                    },
                    {
                        "type": "TextSubheading",
                        "text": "Full terms"
                    },
                    {
                        "type": "TextBody",
                        "text": "The full terms and privacy policy are available at ttt-tax.co.za/terms. Continuing past this screen confirms you've had the opportunity to review them."
                    }
                ]
            }
        }
    ]
}
```

## Triggering the Flow

The current two-message sign-up prompt in
[webhook.controller.ts:157-164](../src/controllers/webhook.controller.ts#L157-L164)
is replaced with a single interactive Flow message via a new
[`metaWhatsAppService.sendFlow`](../src/services/meta.service.ts) method:

```ts
await metaWhatsAppService.sendFlow(from, {
    flowId: process.env.WHATSAPP_SIGNUP_FLOW_ID!,
    flowCta: "Sign up",
    header: "Welcome to TTT",
    body: "You're not in our system yet — tap below to sign up in under a minute.",
    footer: "TTT Financial Group",
    firstScreen: "SIGN_UP",
});
```

Env var to add: `WHATSAPP_SIGNUP_FLOW_ID=<flow id from Meta Flow Manager>`.

If the flow ID isn't configured (e.g., in dev), the webhook falls back to the
legacy sign-up link message so the bot still works.

## Receiving the submission

A completed Flow arrives as:

```json
{
  "type": "interactive",
  "interactive": {
    "type": "nfm_reply",
    "nfm_reply": {
      "name": "flow",
      "body": "Sent",
      "response_json": "{\"first_name\":\"Jane\",\"last_name\":\"Doe\",\"email\":\"jane@example.com\",\"client_type\":\"0\",\"service_needed\":\"100000000\",\"notes\":\"Need help with 2025 filing\",\"terms_agreement\":true,\"offers_acceptance\":false}"
    }
  }
}
```

`extractIncoming` detects `nfm_reply` and surfaces a `flowResponse` on the
message. `processMessage` short-circuits the normal AI path, creates the lead,
and sends a plain confirmation message.
