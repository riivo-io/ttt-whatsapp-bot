# Leads & Contacts — Current State

_Last audited against the codebase: 2026-04-17._

Two distinct CRM entities are in play. The bot treats them as separate throughout — different Dynamics tables, different lookup paths, different tool scoping, different session types. This doc summarises what's live for each and where the gaps are.

| Entity | Dynamics table | What it is | Session `crm_type` |
|---|---|---|---|
| **Contact** | `contacts` | A confirmed client (signed up / converted) | `client` |
| **Lead** | `new_leads` | A prospect in the onboarding pipeline | `lead` |

Status legend: ✅ live · 🟡 partial · ❌ not implemented

---

## 1. Sender resolution (inbound webhook)

Every inbound WhatsApp message passes through `resolveSender` in [webhook.controller.ts:22](../src/controllers/webhook.controller.ts#L22).

| Step | Status | Notes |
|---|---|---|
| Staff phone → Supabase staff table | ✅ | `supabaseService.findStaffByPhone` |
| Previously-seen phone → Supabase session cache (`crm_id` + `crm_type`) | ✅ | [webhook.controller.ts:36-47](../src/controllers/webhook.controller.ts#L36-L47) |
| Fresh Dynamics lookup: phone → `contacts` / `new_leads` / `systemusers` in parallel | ✅ | [dynamicsService.getContactByPhone — dynamics.service.ts:322](../src/services/dynamics.service.ts#L322). Priority: staff > client > lead. Warns on duplicates. |
| Force-type lookup (test mode) | ✅ | `getContactByPhoneAndType` at [dynamics.service.ts:386](../src/services/dynamics.service.ts#L386) |
| **Unknown phone → auto-create lead** | ❌ | Falls through to the sign-up link — no lead row is created automatically. See [webhook.controller.ts:157-161](../src/controllers/webhook.controller.ts#L157-L161). |

---

## 2. Contact operations  ✅ (read-heavy, mostly complete)

All on `dynamicsService` in [dynamics.service.ts](../src/services/dynamics.service.ts).

| Method | Line | Purpose |
|---|---|---|
| `getContactByPhone` | [322](../src/services/dynamics.service.ts#L322) | Phone → contactid resolution |
| `getContactDetails` | [466](../src/services/dynamics.service.ts#L466) | Full contact profile by id |
| `searchContactByName` | [474](../src/services/dynamics.service.ts#L474) | Name search (optional owner filter) |
| `searchContactByIdNumber` | [781](../src/services/dynamics.service.ts#L781) | Lookup by `riivo_idnumber` |
| `getContactTaxNumber` | [607](../src/services/dynamics.service.ts#L607) | `riivo_taxnumber` read |
| `getContactOwnerId` | [421](../src/services/dynamics.service.ts#L421) | Used when attributing referrals / leads |
| `getMyClients` | [228](../src/services/dynamics.service.ts#L228) | All active contacts owned by a staff user |
| `getClientInvoices` | [255](../src/services/dynamics.service.ts#L255) | Invoices linked via `_ttt_customer_value` |
| `getClientCases` | [306](../src/services/dynamics.service.ts#L306) | Cases linked via `_icon_accountid_value` |
| `getOpenInvoiceTotal` | ~597 | Unpaid invoice sum |
| `createContact` | [670](../src/services/dynamics.service.ts#L670) | Insert — requires `firstName`, `lastName`, `entityType`, `industryId`, `ownerSystemUserId`, `primaryRepSystemUserId`. Logged to `crm_audit_log`. |
| `updateWhatsAppOptIn` | [1137](../src/services/dynamics.service.ts#L1137) | `riivo_whatsappoptinout` PATCH |
| `createRequest` (WhatsApp case) | [1089](../src/services/dynamics.service.ts#L1089) | Binds to contact via `riivo_Client@odata.bind` |

**Gaps**
- ❌ No `updateContact` method for generic field patches (only opt-in today).
- ❌ No automated contact-side LOE attachment path — LOE flow is lead-only.

---

## 3. Lead operations  🟡

| Method | Line | Purpose | Status |
|---|---|---|---|
| `getContactByPhone` (lead branch) | [322](../src/services/dynamics.service.ts#L322) | Phone → lead via `ttt_mobilephone` | ✅ |
| `getMyLeads` | [241](../src/services/dynamics.service.ts#L241) | Leads owned by a staff user | ✅ |
| `searchLeadByName` | [1300](../src/services/dynamics.service.ts#L1300) | Scoped to caller's leads. Token-AND on firstname/lastname. | ✅ |
| `createLead` | [616](../src/services/dynamics.service.ts#L616) | Insert — requires firstName, lastName; optional phone/email/notes. Staff flow: `clientType`, `leadType`, `industryId`, `ownerSystemUserId`. Logged. | ✅ |
| `uploadSignedLoe` | [884](../src/services/dynamics.service.ts#L884) | Signed LOE PDF → `riivo_signedletterofengagement` + annotation | ✅ |
| `updateLeadFieldsFromLoe` | [981](../src/services/dynamics.service.ts#L981) | PATCH extracted LOE fields (banking, signing, client details) onto lead | ✅ |
| `createTask` (lead branch) | [1268](../src/services/dynamics.service.ts#L1268) | Uses `regardingobjectid_new_lead_task@odata.bind` | ✅ |
| `createRequest` (WhatsApp case — lead branch) | [1089](../src/services/dynamics.service.ts#L1089) | Binds via `riivo_Lead@odata.bind`. Currently only triggered for clients in the case lifecycle — see gap below. | 🟡 |
| **`convertLeadToContact`** | — | Auto-conversion once onboarding checklist complete (TTTFG-3191) | ❌ not implemented |

**Gaps**
- ❌ Lead → Contact auto-conversion (TTTFG-3191) — the case-service comment explicitly flags this as future work.
- ❌ Unknown-number → auto-create lead (currently the bot only sends the sign-up link).
- 🟡 Case lifecycle (`caseService.createCase`) only mirrors for **clients** — [case.service.ts:94-112](../src/services/case.service.ts#L94-L112). Leads that message don't currently get a `riivo_request` mirrored. Easy fix: detect `crm_type === 'lead'` and call `createRequest({ contactType: 'lead', leadId })`.

---

## 4. Tool scoping in the LLM layer

In [claude.service.ts](../src/services/claude.service.ts). Role-based filtering gates which tools each role can actually invoke — [claude.service.ts:738-763](../src/services/claude.service.ts#L738-L763).

### Client-facing tools (the person messaging is a contact)
- `get_my_details`
- `get_client_invoices`
- `get_client_cases`
- `get_invoice_pdf`
- `get_tax_number`
- `get_outstanding_balance`
- `request_consultant_callback`
- `opt_out_whatsapp`
- `refer_friend`
- `save_document`

These assume `crmEntity.id` is a **contact** GUID and `crmEntity.type === 'client'`. There is no symmetric client-facing tool set for leads — leads cannot self-serve.

### Staff-facing tools that touch contacts / leads
| Tool | Handler line | Targets |
|---|---|---|
| `get_my_clients` | ~228 | contacts owned by the staff user |
| `get_my_leads` | ~267 | leads owned by the staff user |
| `search_contact_by_name` | ~ | contacts |
| `search_lead_by_name` | ~464 | leads (scoped to caller) |
| `get_client_details` | ~296 | contacts (with an in-tool warning: do NOT use for leads) |
| `create_contact` | ~517 (handler 886) | contacts |
| `create_lead` | ~347 (handler 847) | leads |
| `create_task` | ~414 | both — dispatcher resolves entity via search tools first |

---

## 5. Supabase session shape

Sessions are keyed on `(phone_number, crm_id, crm_type)`. `crm_type` ∈ `'client' | 'lead' | 'user'`.

- `findPreviousSession` ([supabase.service.ts:119](../src/services/supabase.service.ts#L119)) returns the most recent session so the webhook skips the Dynamics round-trip on repeat messages.
- Role-aware session — `role_id` and `permitted_tools` populated for staff only; both null for clients and leads.

---

## 6. Type definitions

[src/types/crm.types.ts](../src/types/crm.types.ts):

```ts
type CrmEntity = {
    id: string;
    type: 'client' | 'lead' | 'user';
    fullname: string;
    optIn?: boolean;
};
```

Used everywhere — webhook, claude.service, case.service, dynamics.service — as the canonical representation of the sender after resolution.

---

## 7. LOE (Letter of Engagement) flow  ✅ leads-only

Current implementation is **lead-only**. A lead uploads a signed LOE via WhatsApp; OCR extracts banking / signing fields; the lead record is patched; the PDF is attached.

| Step | File / line |
|---|---|
| Lead uploads PDF | [webhook.controller.ts:134](../src/controllers/webhook.controller.ts#L134) + [metaWhatsAppService.downloadMedia](../src/services/meta.service.ts#L180) |
| OCR extraction | [src/services/mistral.service.ts](../src/services/mistral.service.ts) + [loe-extractor.service.ts](../src/services/loe-extractor.service.ts) |
| Staged review | `pending_loe_data` table ([migration](../supabase/migrations/20260414100000_pending_loe_data.sql)) |
| Patch lead fields | [dynamicsService.updateLeadFieldsFromLoe — dynamics.service.ts:981](../src/services/dynamics.service.ts#L981) |
| Attach PDF + annotation | [uploadSignedLoe — dynamics.service.ts:884](../src/services/dynamics.service.ts#L884) |

**Not implemented**
- ❌ Contact-side LOE attachments (only leads have this path today).
- ❌ LOE completion does **not** trigger lead → contact conversion.

---

## 8. Unknown-number / sign-up path

| Behaviour | Status | Evidence |
|---|---|---|
| Bot sends `SIGN_UP_GREETING` + sign-up link to any phone not in contacts/leads/staff | ✅ | [webhook.controller.ts:157-161](../src/controllers/webhook.controller.ts#L157-L161) |
| Lead auto-created in Dynamics for unknown phone | ❌ | No code path does this |
| Signup URL | `https://www.taxtechnicianstoday.co.za/sign-up` | [webhook.controller.ts:14](../src/controllers/webhook.controller.ts#L14) |

---

## 9. Dynamics schema notes

Calls still reference a few option-set values marked `TODO: verify`:
- Case type map ([dynamics.service.ts:509-516](../src/services/dynamics.service.ts#L509-L516)) — legacy `new_cases` path only; `riivo_requests` uses different enums
- Tax year ([dynamics.service.ts:545](../src/services/dynamics.service.ts#L545)) — hardcoded `100000005`

Flag to Luc before any production-affecting change to verify option sets.

---

## Priority gaps for Phase B / C

Ordered by impact:

1. **Lead → Contact auto-conversion (`convertLeadToContact`)** — unblocks the full onboarding loop. Dynamics-side conversion action required; gate on checklist completion.
2. **Case lifecycle mirror for leads** — one-line extension in `caseService.createCase` to call `createRequest({ contactType: 'lead' })` when the sender is a lead.
3. **Auto-create lead on unknown inbound** (product decision pending — currently the sign-up URL is the funnel).
4. **Lead onboarding checklist table + `get_onboarding_status` tool** — Phase B scope.
5. **Per-department welcome variants** — leveraging `riivo_requestedservice` which is already read from Dynamics.
