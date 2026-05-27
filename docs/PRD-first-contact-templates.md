# PRD: First-Contact WhatsApp Templates

**Author:** Luc Duval
**Date:** 2026-05-27
**Status:** Approved, ready for implementation
**Related:** [docs/PRD-referral-tier-update.md](./PRD-referral-tier-update.md), [docs/referral-marketing.md](./referral-marketing.md)

---

## 1. Problem Statement

When an unknown contact messages the bot for the first time, they receive a text-only fallback greeting plus a bare web link. There is no brand surface, no visual identity, and no differentiation between cold prospects and warm referral leads.

Two specific failures today:

1. **Cold inbounds get a flat, low-trust first impression.** The current `SIGN_UP_GREETING` ([src/workers/whatsappProcessor.ts:17](../src/workers/whatsappProcessor.ts#L17)) is plain text plus a hyperlink card. It does not communicate brand, scope of service, or excitement.
2. **Referral leads are invisible.** When a friend clicks Luc's wa.me referral share link, the bot has no way to detect referral intent or capture the referrer's code. The new lead lands in the same generic first-contact path as a cold inbound, and the referrer's identity is lost until the lead manually re-enters the code in the signup Flow form (which they often don't).

Both failures cost qualified leads at the top of the funnel.

---

## 2. Success Metrics

| Metric | Baseline (today) | Target |
|---|---|---|
| First-contact → Flow submission conversion (cold) | TBD — measure on rollout | +20% within 30 days post-launch |
| First-contact → Flow submission conversion (referral) | n/a — no separate path today | ≥40% (warm leads should outperform cold) |
| Referral attribution rate (% of referral inbounds where `referredByContactId` is set on the resulting lead) | TBD — likely <20% today | ≥80% |
| Template send error rate | n/a | <1% (with text fallback firing on errors) |
| Team-notification email delivery on WhatsApp-originated leads | 0% (emails only fire on web signup today) | 100% |

Telemetry is logged via existing `console.log` patterns in `whatsappProcessor.ts`; specific log lines are specified in §6.

---

## 3. Solution Overview

Replace the current first-contact text greeting with **two Meta-approved templates**, each rendered with a branded image header and a Flow button. The bot detects referral intent on inbound and routes accordingly.

```
Inbound from unknown contact
│
├─ Text matches /\(code:\s*([a-zA-Z0-9_-]+)\)/i  ──► Referral template (named referrer)
│                                                    └─ Resolve code → Dynamics contact
│                                                         ├─ Match → {{1}} = first name
│                                                         └─ No match → {{1}} = "A friend"
│
├─ Text matches /referral/i (no code)            ──► Referral template (anonymous: {{1}} = "A friend")
│
└─ Anything else                                 ──► Generic welcome template
```

After the new lead taps "Get started" and submits the Flow form, the bot creates the Dynamics lead (existing path, unchanged) and additionally POSTs to the new `/api/whatsapp-signup` endpoint on the LOE app, which fires the team notification and client thank-you emails.

---

## 4. Template Specs (for Meta Business Manager)

### 4.1 Template: `ttt_welcome_signup`

| Field | Value |
|---|---|
| Name | `ttt_welcome_signup` |
| Category | **UTILITY** |
| Language | `en` |
| Header type | Image |
| Header asset | [docs/assets/whatsapp-templates/Welcome_TTTFinancialGroup.png](./assets/whatsapp-templates/Welcome_TTTFinancialGroup.png) |
| Body | See below |
| Body variables | None |
| Footer | (none) |
| Buttons | 1 × Flow button |
| Button label | `Get started` |
| Flow | Existing TTT signup Flow (same ID as currently linked from `WHATSAPP_SIGNUP_TEMPLATE_NAME`) |

**Body text** (copy-paste verbatim into Meta Business Manager):

```
Welcome to TTT Financial Group 👋

You're one tap from having your tax, accounting and insurance handled right here on WhatsApp.

Sign up in under a minute and we'll take it from there.
```

---

### 4.2 Template: `ttt_referral_welcome`

| Field | Value |
|---|---|
| Name | `ttt_referral_welcome` |
| Category | **MARKETING** |
| Language | `en` |
| Header type | Image |
| Header asset | [docs/assets/whatsapp-templates/referral.png](./assets/whatsapp-templates/referral.png) |
| Body | See below |
| Body variables | `{{1}}` = referrer first name (fallback `"A friend"`) |
| Footer | (none) |
| Buttons | 1 × Flow button |
| Button label | `Get started` |
| Flow | Same Flow as `ttt_welcome_signup`. The bot passes `flow_action_data: { referral_code: "<extracted code>" }` so the Flow form's referral field is pre-filled. |

**Body text** (copy-paste verbatim into Meta Business Manager):

```
Hey 👋 {{1}} thought you should give TTT a go.

We handle tax, accounting and insurance for South Africans, all over WhatsApp. Sign up in under a minute and we'll sort the rest.

Bonus: as a TTT client you join our referral programme too. Send TTT to your friends and earn up to R1000 each.

Tap Get started and we'll load {{1}}'s code for you.
```

**Sample variable values for Meta's approval review** (Meta requires example values):

- `{{1}}` example: `Luc`

---

### 4.3 Image header constraints (Meta)

- Format: JPG or PNG
- Max size: 5 MB
- Recommended aspect ratio: 1.91:1
- Both supplied images are 16:9 (1920×1080). Meta will render at 1.91:1 and crop the top/bottom edges slightly. Preview in Meta's template builder before submitting; re-export to 1.91:1 if the logo or any key text gets clipped.

---

## 5. File Plan

### 5.1 Files to modify

#### [src/workers/whatsappProcessor.ts](../src/workers/whatsappProcessor.ts)

**a) Add new constants near [line 17-21](../src/workers/whatsappProcessor.ts#L17-L21):**

```ts
const REFERRAL_TEMPLATE_NAME = process.env.WHATSAPP_REFERRAL_TEMPLATE_NAME || '';
const REFERRAL_TEMPLATE_LANG = process.env.WHATSAPP_REFERRAL_TEMPLATE_LANG || 'en';

const REFERRAL_CODE_PATTERN = /\(code:\s*([a-zA-Z0-9_-]+)\)/i;
const REFERRAL_KEYWORD_PATTERN = /\breferral\b/i;
```

**b) Refresh fallback constants ([line 17-18](../src/workers/whatsappProcessor.ts#L17-L18))**

Replace `SIGN_UP_GREETING` and `SIGN_UP_LINK` with two new fallback strings (used only when the template send fails):

```ts
const SIGN_UP_GREETING = `Welcome to TTT Financial Group 👋\n\nYou're one tap from having your tax, accounting and insurance handled here on WhatsApp.\n\nRegister in under a minute: https://www.ttt-tax.co.za/client-onboarding`;

function buildReferralFallback(referrerFirstName: string | null, code: string | null): string {
    const name = referrerFirstName || 'A friend';
    const codeSuffix = code ? `/?ref=${encodeURIComponent(code)}` : '';
    return `Hey 👋 ${name} thought you should give TTT a go.\n\nWe handle tax, accounting and insurance for South Africans, all over WhatsApp.\n\nRegister here${code ? ` and add the code \`${code}\`` : ''}: https://www.ttt-tax.co.za/client-onboarding${codeSuffix}`;
}
```

The old `SIGN_UP_LINK` constant is dropped (link is inlined in the new fallback).

**c) Replace the unknown-contact branch ([line 569-586](../src/workers/whatsappProcessor.ts#L569-L586))** with branching logic:

```ts
if (!crmEntity) {
    const codeMatch = effectiveText.match(REFERRAL_CODE_PATTERN);
    const code = codeMatch ? codeMatch[1] : null;
    const isReferralInbound = !!code || REFERRAL_KEYWORD_PATTERN.test(effectiveText);

    if (isReferralInbound) {
        let referrerFirstName: string | null = null;
        if (code) {
            try {
                const referrer = await dynamicsService.getContactByReferralCode(code);
                if (referrer) {
                    referrerFirstName = (referrer.firstname || '').trim() || null;
                    console.log(`[Processor] Referral inbound from ${from} matched code ${code} → ${referrer.fullname}`);
                } else {
                    console.warn(`[Processor] Referral inbound from ${from} had code ${code} but no contact match`);
                }
            } catch (e) {
                console.warn('[Processor] Referral code lookup failed:', (e as Error).message);
            }
        } else {
            console.log(`[Processor] Referral inbound from ${from} with no code in text`);
        }

        if (REFERRAL_TEMPLATE_NAME) {
            const result = await metaWhatsAppService.sendTemplate(from, {
                name: REFERRAL_TEMPLATE_NAME,
                languageCode: REFERRAL_TEMPLATE_LANG,
                bodyNamedVariables: { '1': referrerFirstName || 'A friend' },
                flowButton: {
                    index: 0,
                    ...(code ? { flowActionData: { referral_code: code } } : {}),
                },
            });
            if (result.delivered) {
                console.log(`[Processor] ${from} → referral template "${REFERRAL_TEMPLATE_NAME}" (referrer=${referrerFirstName || 'A friend'}, code=${code || 'none'})`);
                return;
            }
            console.warn(`[Processor] sendTemplate "${REFERRAL_TEMPLATE_NAME}" failed (${result.error}), falling back to text`);
        }

        await metaWhatsAppService.sendMessage(from, buildReferralFallback(referrerFirstName, code));
        return;
    }

    // Generic (cold) first-contact path
    if (SIGNUP_TEMPLATE_NAME) {
        const result = await metaWhatsAppService.sendTemplate(from, {
            name: SIGNUP_TEMPLATE_NAME,
            languageCode: SIGNUP_TEMPLATE_LANG,
            flowButton: { index: 0 },
        });
        if (result.delivered) {
            console.log(`[Processor] ${from} not found — sent sign-up template "${SIGNUP_TEMPLATE_NAME}"`);
            return;
        }
        console.warn(`[Processor] sendTemplate "${SIGNUP_TEMPLATE_NAME}" failed (${result.error}), falling back to text`);
    }
    console.log(`[Processor] ${from} not found — sending sign-up fallback text`);
    await metaWhatsAppService.sendMessage(from, SIGN_UP_GREETING);
    return;
}
```

**d) Wire the email endpoint after `createLead` succeeds (after [line 326](../src/workers/whatsappProcessor.ts#L326))**:

After the `console.log(`[Processor] Sign-up flow created lead ${created.new_leadid} for ${from}`);` line, add a fire-and-await call to the LOE app's endpoint. See §7.2 for the contract.

```ts
await postWhatsAppSignupNotification({
    name: `${firstName} ${lastName}`.trim(),
    email,
    phone: from,
    service: serviceLabelFromLeadType(leadType),   // helper: maps leadType int → 'tax' | 'accounting' | 'insurance' | 'advisory'
    clientType,
    dynamicsId: created.new_leadid,
});
```

`postWhatsAppSignupNotification` is a new helper (see §5.2). Failures are logged and swallowed; the lead is already in Dynamics so we never block the user-visible welcome flow on email delivery.

---

#### [src/services/dynamics.service.ts](../src/services/dynamics.service.ts)

**Extend [`getContactByReferralCode`](../src/services/dynamics.service.ts#L974) to return the `firstname` field.**

Current shape: `Promise<{ id: string; fullname: string } | null>`
New shape: `Promise<{ id: string; fullname: string; firstname: string } | null>`

Change the `searchEntity` projection to include `'firstname'`. Update the one existing caller at [whatsappProcessor.ts:282](../src/workers/whatsappProcessor.ts#L282) — it currently uses `referrer.fullname` only, no break risk; just keep ignoring the new field.

---

### 5.2 Files to create

#### `src/services/whatsappSignupNotifier.ts` (new file)

Small helper module that POSTs to `/api/whatsapp-signup`. Self-contained so the wiring inside `whatsappProcessor.ts` stays clean.

```ts
import axios from 'axios';

const HOST = process.env.WHATSAPP_SIGNUP_HOST || 'https://ttt-tax.co.za';
const TOKEN = process.env.WHATSAPP_SIGNUP_TOKEN || '';

export async function postWhatsAppSignupNotification(payload: {
    name: string;
    email: string;
    phone: string;
    service: 'tax' | 'accounting' | 'insurance' | 'advisory';
    companyName?: string;
    clientType?: number;
    dynamicsId?: string;
    services?: Record<string, boolean>;
}): Promise<void> {
    if (!TOKEN) {
        console.warn('[WhatsAppSignupNotifier] WHATSAPP_SIGNUP_TOKEN not set — skipping email notification');
        return;
    }
    try {
        await axios.post(`${HOST}/api/whatsapp-signup`, payload, {
            headers: {
                'Content-Type': 'application/json',
                'x-whatsapp-signup-token': TOKEN,
            },
            timeout: 10_000,
        });
        console.log(`[WhatsAppSignupNotifier] Notified email API for ${payload.email} (leadId=${payload.dynamicsId})`);
    } catch (e: any) {
        const status = e?.response?.status;
        const body = e?.response?.data;
        console.error(`[WhatsAppSignupNotifier] POST /api/whatsapp-signup failed (status=${status}):`, body || e.message);
    }
}
```

Note that `companyName` and `services` are accepted in the type signature but the caller in `whatsappProcessor.ts` does not pass them today (see §8 Out of Scope, item 2).

---

### 5.3 Helper: `leadType` → service string

The `service` field on the email endpoint expects `'tax' | 'accounting' | 'insurance' | 'advisory'`. The bot stores `leadType` as a Dynamics OptionSet integer ([dynamics.service.ts:1000](../src/services/dynamics.service.ts#L1000)):

```
100000000 = Tax
100000001 = Accounting
463630001 = Long Term Insurance
463630002 = Short Term Insurance
```

Add this mapper inside `whatsappProcessor.ts` (or co-locate with the notifier):

```ts
function serviceLabelFromLeadType(leadType: number | undefined): 'tax' | 'accounting' | 'insurance' | 'advisory' {
    switch (leadType) {
        case 100000001: return 'accounting';
        case 463630001:
        case 463630002: return 'insurance';
        case 100000000:
        default: return 'tax';
    }
}
```

There is no `advisory` value in the current Dynamics OptionSet — included in the union type so the endpoint contract stays accurate if the OptionSet is extended later. Default is `tax` (the dominant service).

---

## 6. Behaviour Matrix

The detection branch fans out as follows. Implementation must match exactly:

| # | Contact state | Inbound text | Action | Log line prefix |
|---|---|---|---|---|
| 1 | Unknown | Matches `(code: X)` and X resolves in Dynamics | Send `ttt_referral_welcome`, `{{1}}` = referrer first name, `flow_action_data.referral_code` = X | `[Processor] {from} → referral template` |
| 2 | Unknown | Matches `(code: X)` but X doesn't resolve | Send `ttt_referral_welcome`, `{{1}}` = "A friend", `flow_action_data.referral_code` = X (Flow will still validate downstream) | `[Processor] Referral inbound from {from} had code {X} but no contact match` |
| 3 | Unknown | Matches `referral` keyword, no code in text | Send `ttt_referral_welcome`, `{{1}}` = "A friend", no `flow_action_data` | `[Processor] Referral inbound from {from} with no code in text` |
| 4 | Unknown | Anything else | Send `ttt_welcome_signup` | `[Processor] {from} not found — sent sign-up template` |
| 5 | **Known** (existing client/lead) | Matches `(code: X)` | **No referral-specific behaviour.** Route through existing known-contact logic. Update `referredByContactId` on the lead record **only** if the contact is an active LEAD (not a paying client) and `referredByContactId` is currently null — to be wired in a follow-up pass, not blocking this PRD. | (existing) |
| 6 | **Known** | Anything else | Existing routing (unchanged) | (existing) |
| 7 | Any | Template send fails (network / Meta error) | Send text fallback per §5.1(b) | `[Processor] sendTemplate "{name}" failed ({error}), falling back to text` |

---

## 7. AI / Engineering Contracts

### 7.1 Inbound parsing contract

Pattern source: the LOE app's referral share-link builder already produces the string:

```js
const tinaPrompt = `I'd like to know more about the referral (code: ${code})`;
```

This is the canonical inbound. The bot regex:

```ts
const REFERRAL_CODE_PATTERN = /\(code:\s*([a-zA-Z0-9_-]+)\)/i;
const REFERRAL_KEYWORD_PATTERN = /\breferral\b/i;
```

The code-extraction regex is the primary trigger. The keyword regex is the fallback for paraphrased inbounds where the user edited the prefilled text.

Code charset: `[a-zA-Z0-9_-]+`. Matches Dynamics' `riivo_referralcode` field which is alphanumeric with optional hyphens/underscores.

### 7.2 `/api/whatsapp-signup` outbound contract

Per the LOE app's endpoint spec (provided by the LOE repo owner):

- **URL:** `POST ${WHATSAPP_SIGNUP_HOST}/api/whatsapp-signup` (default `https://ttt-tax.co.za`)
- **Headers:**
  - `Content-Type: application/json`
  - `x-whatsapp-signup-token: ${WHATSAPP_SIGNUP_TOKEN}` (shared secret, must match LOE app's env)
- **Body:**

```json
{
    "name": "Jane Doe",
    "email": "jane@example.com",
    "phone": "+27821234567",
    "service": "tax",
    "clientType": 0,
    "dynamicsId": "00000000-0000-0000-0000-000000000000"
}
```

- **Responses:**
  - `200 { ok: true }` — emails dispatched
  - `400` — validation error (log, do not retry)
  - `401` — bad token (log loudly, do not retry)
  - `502` — Graph send failure on LOE side (log; consider manual recovery)

- **Failure policy:** failures are logged and swallowed. The lead is already in Dynamics so we never block the user-visible welcome flow.

- **Fields not sent today:** `companyName`, `services` (flags). The Flow does not currently capture either — see §8.

### 7.3 Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `WHATSAPP_SIGNUP_TEMPLATE_NAME` | yes (already exists) | `''` | Meta template name for `ttt_welcome_signup` |
| `WHATSAPP_SIGNUP_TEMPLATE_LANG` | yes (already exists) | `'en'` | Language code for above |
| `WHATSAPP_REFERRAL_TEMPLATE_NAME` | **new** | `''` | Meta template name for `ttt_referral_welcome`. If unset, code falls through to text fallback. |
| `WHATSAPP_REFERRAL_TEMPLATE_LANG` | **new** | `'en'` | Language code for referral template |
| `WHATSAPP_SIGNUP_TOKEN` | **new** | `''` | Shared secret with LOE app for `/api/whatsapp-signup`. If unset, email notification is skipped (logged warning, lead still created). |
| `WHATSAPP_SIGNUP_HOST` | **new** | `'https://ttt-tax.co.za'` | Host of the LOE app exposing `/api/whatsapp-signup`. Override for staging. |

### 7.4 Template variable contract (`ttt_referral_welcome`)

The template body uses **named variable** syntax — `{{1}}` referenced twice in the body but it's a single positional/named slot in Meta's template system.

- When sending, the bot uses `bodyNamedVariables: { '1': '<value>' }` via the existing `sendTemplate` helper at [meta.service.ts:114-122](../src/services/meta.service.ts#L114-L122).
- Value rules:
  - Match in Dynamics → use the contact's `firstname` (Dynamics field). If `firstname` is empty/null on the contact record, fall back to `"A friend"`.
  - No match or no code → use `"A friend"`.
  - The value is rendered twice in the body ("Hey 👋 {{1}} thought..." and "Tap Get started and we'll load {{1}}'s code for you."). Both render from the same `{{1}}` slot — Meta will handle this automatically as long as the template is declared with positional `{{1}}` placeholders in both spots.

### 7.5 Flow pre-fill contract

For the referral template's Flow button, the bot passes:

```ts
flowButton: {
    index: 0,
    flowActionData: { referral_code: '<extracted code>' },
}
```

This relies on `meta.service.ts:139-152`, which already supports `flow_action_data` injection.

**Flow side requirement:** the Flow JSON definition in Meta Business Manager must declare `referral_code` as an input that accepts initial data from `flow_action_data`. Verify in the Flow builder before going live. If the Flow doesn't currently support initial values, we either (a) update the Flow JSON (preferred), or (b) drop the "we'll load {{1}}'s code for you" line from the template body and have the new lead type the code themselves.

---

## 8. Out of Scope

1. **Flow form field extensions.** `companyName` and granular `services` flags are NOT being added to the WhatsApp Flow form in this scope. Use case is mostly tax clients; revisit later if business/multi-service signups become a material share of WhatsApp leads.
2. **Bulk re-engagement of past unknown inbounds.** This PRD covers the going-forward flow only. Anyone who messaged the bot before launch and got the old greeting is not retargeted.
3. **Image asset creation.** Both images are supplied; this PRD does not commission new assets. If Meta's 1.91:1 crop is unacceptable on either image, re-export is a manual task outside this PRD.
4. **Known-contact referral attribution backfill.** Row 5 of the matrix proposes updating an active LEAD's `referredByContactId` when they click a referral link — this is deferred to a follow-up pass and not blocking this PRD's launch.
5. **Analytics dashboards / Looker queries.** Logging is in place via `console.log`; aggregating into a dashboard is a separate workstream.
6. **A/B testing of template copy.** Single-variant launch. Iterate copy after we have 2-4 weeks of conversion data.
7. **Marketing-side share text changes.** The LOE app's `tinaPrompt` builder is the source of truth for the inbound format; this PRD assumes it already produces `(code: X)` and does not touch the LOE repo.

---

## 9. Rollout Plan

1. **Implementer**: branch off `main`, complete changes in §5.
2. **PR**: opens with both template specs (§4) attached as the PR description so reviewers can sanity-check copy.
3. **Pre-merge env setup**:
   - Set `WHATSAPP_SIGNUP_TOKEN` on both this repo's hosting and the LOE app (matching values).
   - Leave `WHATSAPP_REFERRAL_TEMPLATE_NAME` unset until Meta approves the template. Code path tolerates this (referral inbounds fall through to text fallback during the gap).
4. **Meta template submission**: upload both templates via Meta Business Manager using the specs in §4. Approval typically ~3 min per template.
5. **Once approved**: set `WHATSAPP_REFERRAL_TEMPLATE_NAME=ttt_referral_welcome` and (if changing) `WHATSAPP_SIGNUP_TEMPLATE_NAME=ttt_welcome_signup` in production env. Restart the worker so it picks up the new env vars.
6. **Smoke test**:
   - Message the bot from an unknown number with no referral text → expect generic template with image.
   - Message the bot from an unknown number with `"I'd like to know more about the referral (code: <a real referrer's code>)"` → expect referral template with that referrer's first name in the body, and a Flow that pre-fills `referral_code` on open.
   - Repeat with a bogus code → expect referral template with `"A friend"`.
   - Submit the Flow form → confirm Dynamics lead is created AND check that the team notification email arrives at the configured service inbox.
7. **Rollback**: unset the new env vars to revert to the existing single-template path. The text fallback in §5.1(b) is also a safe degraded mode.

---

## 10. Open Questions

- **Flow `flow_action_data` support**: confirmed pending — verify the existing Flow JSON exposes `referral_code` as an initial-value input. If not, either update the Flow JSON or drop the "we'll load {{1}}'s code for you" promise from the template body before submission.
- **Service mapping default**: the helper in §5.3 defaults unknown `leadType` to `'tax'`. Acceptable for first launch; revisit if non-tax leads show up via the WhatsApp Flow with `service_needed` left blank.
