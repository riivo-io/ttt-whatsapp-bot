# PRD — Tax Forms (Fillable Templates)

**Owner:** Luc
**Status:** Approved for implementation
**Target file paths:** `src/services/taxForms.service.ts` (new), `src/services/claude.service.ts`, `src/services/sharepoint.service.ts`, `src/services/requiredDocuments.service.ts`, `src/workers/whatsappProcessor.ts`
**Feature flag:** none (new tools are additive and gated by existing role-based tool filtering)

---

## 1. Problem Statement

Clients regularly ask Tina for blank tax form templates they need to fill in to start their tax return. Examples: the SARS travel allowance log (3701), a commission earner expenses list. Today, Tina has no way to surface or deliver these — clients are told to email the office or wait for their consultant. This adds friction at the worst time (the client is gathering paperwork and ready to act), and the consultant ends up handling a request the bot could complete in one round-trip.

The existing [`get_required_documents`](../src/services/requiredDocuments.service.ts) tool tells clients which docs they **already have** to provide (IRP5, bank statements, IT3b). It does not surface **fillable templates** (vehicle log, commission expenses sheet), which are a distinct category.

**Who experiences it:** every TTT client whose tax return involves a travel allowance, reimbursive travel, commission travel, or commission earnings.

**Why now:** the catalog of forms is small and stable (3 PDFs today), SharePoint integration already exists for client doc storage, and the `send_invoice_pdf` tool already proves the WhatsApp-doc-delivery pattern works at scale.

---

## 2. Success Metrics

**Primary:** Increase share of "what do I need to start my return?" conversations that end with the client in possession of every blank form they need, without a consultant touchpoint.

- **Metric:** `(conversations where send_tax_form fired) / (conversations where get_required_documents fired AND personalized form trigger matched)` within a 30-day rolling window.
- **Baseline (pre-launch):** 0% (feature does not exist).
- **Target:** ≥ 60% within 30 days post-launch.

**Guardrail (non-numeric):** No increase in consultant-side requests for "can you send the vehicle form to client X" tickets after launch.

**Engineering health checks (must hold from day 1):**

- `send_tax_form` fetch from SharePoint succeeds ≥ 99% of attempts (file not found, auth failure, transient Graph error).
- Zero `send_tax_form` calls deliver a PDF mismatched to the requested `form_key` (filename prefix mismatch is a hard failure, not a soft fall-through).

---

## 3. Solution & File Plan

### 3.1 New service — `taxForms.service.ts`

New file: `src/services/taxForms.service.ts`. Holds the hardcoded catalog and the resolver that maps `form_key` to the latest SharePoint file.

**Catalog shape:**

```ts
interface TaxFormSpec {
  key: 'vehicle_detail' | 'vehicle_detail_multijob' | 'commission_expenses';
  filenamePrefix: string;
  label: string;
  whatItCaptures: string;
  whoShouldFill: string;
  triggers: {
    sourceCodes?: string[];
    multiEmployer?: boolean;
  };
}

export const TAX_FORMS: TaxFormSpec[] = [
  {
    key: 'vehicle_detail',
    filenamePrefix: '3701 Vehicle Detail Sheet',
    label: 'Vehicle Detail Sheet',
    whatItCaptures: 'Vehicle info, distance from home to office, six business travel reasons, six areas you travel to, service record, and your leave period for the year.',
    whoShouldFill: 'For anyone with a travel allowance (3701), reimbursive travel (3702), or commission-related travel (4015) on your IRP5.',
    triggers: { sourceCodes: ['3701', '3702', '4015'] },
  },
  {
    key: 'vehicle_detail_multijob',
    filenamePrefix: '3802 Vehicle Details Sheet',
    label: 'Universal Vehicle Details Form',
    whatItCaptures: 'Same idea as the standard vehicle form but split across two jobs - reasons, areas, distance and mileage for each employer separately.',
    whoShouldFill: 'Use this instead of the standard vehicle form if you claim travel at two different jobs.',
    triggers: { sourceCodes: ['3701', '3702', '4015'], multiEmployer: true },
  },
  {
    key: 'commission_expenses',
    filenamePrefix: 'TTT Commission Expenses Sheet',
    label: 'Commission Earner Expenses List',
    whatItCaptures: 'Annual business expenses (client entertainment, fuel, internet, cellphone, banking fees, etc.) plus home office costs if you work from home.',
    whoShouldFill: 'Fill this in if your commission is 50% or more of your gross income - SARS only allows the expense claim above that threshold.',
    triggers: { sourceCodes: ['3606'] },
  },
];
```

**Exported functions:**

- `getPersonalizedForms(sourceCodes: string[]): TaxFormSpec[]` — returns forms whose `triggers.sourceCodes` overlaps `sourceCodes`. Excludes `multiEmployer: true` forms from auto-personalization (see §4).
- `getAllForms(): TaxFormSpec[]` — returns the full catalog.
- `getFormByKey(key: string): TaxFormSpec | null` — catalog lookup.
- `formatCatalogMessage(forms: TaxFormSpec[], mode: 'personalized' | 'all', omittedForms: TaxFormSpec[]): string` — renders the WhatsApp-formatted message body per copy locked in §5.6.
- `resolveLatestFormFile(form: TaxFormSpec): Promise<{ buffer: Buffer; filename: string; year: number } | null>` — calls SharePoint, lists files in the forms folder, filters by `filenamePrefix`, picks the highest year suffix, downloads, returns. Logs `[TaxForms] resolved key=... filename=... year=...`.

### 3.2 SharePoint additions

Extend [`src/services/sharepoint.service.ts`](../src/services/sharepoint.service.ts):

- New env var: `SHAREPOINT_FORMS_FOLDER` (default `Vehicle Tax Calculator/TTT Forms`). Resolved relative to the existing `SHAREPOINT_KB_FOLDER`'s site (`/sites/TaxNavigator`).
- New method `listFormFiles(): Promise<Array<{ name: string; id: string; downloadUrl: string }>>` — lists files in the forms folder (no recursion). Mirrors `listKbFiles()` but scoped to one folder.
- Reuse `downloadFile(itemId)` for the actual byte fetch.

### 3.3 New tools in `claude.service.ts`

Two new tools added to the `TOOLS` array (after `get_required_documents`):

**`list_tax_forms`**

```ts
{
  name: 'list_tax_forms',
  description: 'List the blank tax forms the client can fill in. Use mode="personalized" by default (filters to forms relevant to the client\'s SARS source codes). Use mode="all" when the client explicitly asks for the full catalog or taps the "Tax forms to fill in" menu option. Returns a WhatsApp-formatted message body the assistant should relay verbatim.',
  input_schema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['personalized', 'all'], default: 'personalized' },
    },
    required: [],
  },
}
```

**`send_tax_form`**

```ts
{
  name: 'send_tax_form',
  description: 'Deliver a blank tax form PDF to the requesting client via WhatsApp. Use this after the client has chosen which form they want. Always sends the latest year available in SharePoint.',
  input_schema: {
    type: 'object',
    properties: {
      form_key: {
        type: 'string',
        enum: ['vehicle_detail', 'vehicle_detail_multijob', 'commission_expenses'],
        description: 'The form to send. Must match one of the keys returned by list_tax_forms.',
      },
    },
    required: ['form_key'],
  },
}
```

Both tools added to the client tool set (`isClient` branch around [`claude.service.ts:962`](../src/services/claude.service.ts#L962)). Not added to lead, staff, or unknown tool sets in v1.

**Handlers** added to the tool-dispatch block (around `claude.service.ts:1208+`):

- `list_tax_forms`: reads `riivo_currenttaxsubmission` source codes from the Contact (same source as `requiredDocuments.service`), calls `getPersonalizedForms` or `getAllForms` per `mode`, computes `omittedForms` (forms in the catalog not in the returned list), calls `formatCatalogMessage`, returns the text as tool output. No outbound message sent from the handler — Claude relays the text.
- `send_tax_form`: calls `resolveLatestFormFile`, then `metaWhatsAppService.sendDocument(phoneNumber, buffer, filename, caption)` where `caption` follows §5.6. On success, posts a Dynamics timeline entry (see §5.5). On SharePoint miss (no file matching prefix), returns an error string Claude relays to the client and emits `[TaxForms] resolve_failed key=...`.

### 3.4 Proactive trailing line in `get_required_documents`

Extend [`requiredDocuments.service.ts`](../src/services/requiredDocuments.service.ts):

- After the existing required-docs message is composed, call `getPersonalizedForms(sourceCodes)`. If ≥1 form returned, append:

  > By the way, based on your {trigger summary}, we also have {form labels joined} you can fill in - ask anytime.

  Where `{trigger summary}` is generated from the matched source codes (e.g., `travel allowance` for 3701/3702/4015, `commission earnings` for 3606), and `{form labels joined}` is `*Form A*` for one, `*Form A* and *Form B*` for two.

- This is a single trailing line, not a full catalog. The full catalog only renders when Claude explicitly calls `list_tax_forms`.

### 3.5 New menu row

In [`whatsappProcessor.ts:44`](../src/workers/whatsappProcessor.ts#L44):

- Add `FORMS: 'menu:client:forms'` to `CLIENT_MENU_IDS`.
- Add `[CLIENT_MENU_IDS.FORMS]: 'What tax forms do you have for me?'` to `CLIENT_MENU_CANONICAL_TEXT`.
- Add row in `sendClientWelcomeMenu`'s list payload: `{ id: CLIENT_MENU_IDS.FORMS, title: '📋 Tax forms to fill in', description: 'Blank templates for travel, commission, etc.' }`.
- Position: insert after `📎 Upload tax docs`, before the "Get help" section divider. Total menu rows stays under the WhatsApp 10-row cap.

The canonical text routes through the normal Claude path. The system prompt (§3.6) instructs Claude to call `list_tax_forms({mode: "all"})` when it sees that phrase.

### 3.6 System prompt additions

In the client role context block ([`claude.service.ts:792`](../src/services/claude.service.ts#L792) onward), append:

> **Tax forms (fillable templates):**
> - If the client asks about forms they need to fill in (vehicle log, commission expenses, etc.), call `list_tax_forms`. Default `mode` to `personalized`. Use `mode="all"` only when the client asks for the full list or sends the canonical text "What tax forms do you have for me?".
> - When the client picks a specific form ("send me the vehicle one", "yes please"), call `send_tax_form` with the matching `form_key`. If ambiguous (multiple recommended forms surfaced and the client said "yes"), ask which one.
> - Relay the catalog message from `list_tax_forms` verbatim. Don't rephrase or summarize it.
> - After a form is sent, the client may upload the filled PDF back. Treat this as a normal doc upload; the system tags returned forms automatically.

### 3.7 Return-flow tagging

Extend the inbound document handling in [`whatsappProcessor.ts`](../src/workers/whatsappProcessor.ts) (existing client doc upload path):

- After the file lands but before upload to SharePoint, check the filename against `TAX_FORMS[*].filenamePrefix`. On match:
  - Rename to a stable form: `{ClientFullName}_{label-kebab}_{year}.pdf` (year extracted from the matched form's SharePoint source, not the inbound filename).
  - Upload to `Contact/{FullName}_{GUID}/{tax_year}/`.
  - Post Dynamics timeline entry: `Tina received completed {form label} from client`.
  - Log `[TaxForms] return_tagged key=... clientId=...`.

- On no filename match but `send_tax_form` was called for this `crm_contact_id` within the last 48h (query the existing `messages` or `bot_actions` table), AND the inbound filename doesn't match any other known doc type (IRP5, bank statement, IT3b, RA cert, medical aid cert) → apply the same tagging using the most recently sent form's `form_key`. Log `[TaxForms] return_tagged_via_context key=... clientId=...`.

- On no match anywhere → existing generic upload path. No timeline entry. Log `[TaxForms] return_untagged filename=...`.

The 48h context window is read from a new helper `getRecentTaxFormSendForClient(contactGuid, withinHours)` in `taxForms.service.ts` that queries Supabase for recent `send_tax_form` calls. If no such audit table exists, this falls back to filename-only matching and the no-match-via-context branch is a no-op.

---

## 4. Out of Scope

The following are explicitly **not** part of this change:

- **No staff-side `send_tax_form_to_client` variant.** Consultants asking Tina to push a form to a specific client is not supported in v1. They send forms via email today; that flow continues.
- **No lead access.** Forms presuppose a tax return is in progress. The lead-side State B policy (`Hold onto this for now and send it once your consultant has set up your eFiling`) explicitly defers doc collection until conversion. Adding form delivery for leads would contradict that policy.
- **No multi-employer auto-detection.** `vehicle_detail_multijob` (the 3802 form) is excluded from `personalized` mode. It surfaces only in `all` mode or when the client explicitly mentions multiple jobs. Detecting multi-employer status from Dynamics would require schema lookups we don't have today.
- **No commission-percentage gate.** `commission_expenses` surfaces whenever source code 3606 is on the IRP5, regardless of whether commission is ≥ 50% of gross. The form's own instructions handle the threshold check.
- **No tax-year selection.** Always sends the latest year available in SharePoint. Year-specific delivery is deferred until consultants flag a real client need.
- **No ops-editable descriptions.** Descriptions and `whoShouldFill` copy live in TypeScript. Lifting to env vars or a CMS is deferred.
- **No multi-form bulk send API.** `send_tax_form` accepts a single `form_key`. If a client asks for multiple forms, Claude calls `send_tax_form` multiple times in the same turn (parallel tool calls).
- **No consultant email notification on form return.** Tagging + Dynamics timeline entry is the only signal. Consultants already monitor Dynamics for client activity.
- **No SharePoint-driven catalog.** SharePoint stores the binaries; code is the source of truth for what forms exist, when to offer them, and what to say about them.
- **No retroactive tagging of previously uploaded forms.** Pre-launch client uploads are not re-scanned.
- **No filename-matching for photos or scans.** A client photographing the printed form and sending it as an image will fall through to the untagged path. Acceptable: the doc still lands in the right SharePoint folder.

---

## 5. AI / Engineering Contracts

### 5.1 Tool: `list_tax_forms`

**Input:**

```ts
interface ListTaxFormsInput {
  mode?: 'personalized' | 'all';  // default 'personalized'
}
```

**Behavior:**

1. Resolve `sourceCodes` from the requesting client's `riivo_currenttaxsubmission` (same lookup as `get_required_documents`).
2. If `mode === 'personalized'`, call `getPersonalizedForms(sourceCodes)`; else `getAllForms()`.
3. Compute `omittedForms = TAX_FORMS - returnedForms`.
4. Return `formatCatalogMessage(returnedForms, mode, omittedForms)` as tool output text.

**Errors:**

- No source codes on file AND `mode === 'personalized'` → return text: `I don't have your IRP5 details on file yet, so I can't recommend a specific form. We have three forms in total - say "show me all forms" if you want to see the full list.` Do not call SharePoint.
- Empty personalized result (codes present but none match triggers) → return text: `Based on your profile, you don't need any of our blank forms - your IRP5 details cover your situation. If you've got a new income source we don't know about, say "show me all forms" and I'll list everything.`

### 5.2 Tool: `send_tax_form`

**Input:**

```ts
interface SendTaxFormInput {
  form_key: 'vehicle_detail' | 'vehicle_detail_multijob' | 'commission_expenses';
}
```

**Behavior:**

1. `form = getFormByKey(input.form_key)`. If null, return error text and log `[TaxForms] invalid_key key=...`.
2. `file = await resolveLatestFormFile(form)`. If null, return text: `I couldn't find the {form.label} in our forms folder right now. I've flagged it - please ask your consultant directly, or try again later.` Log `[TaxForms] resolve_failed key=...`.
3. `caption = formatSendCaption(form.label, file.year)` (see §5.6).
4. `await metaWhatsAppService.sendDocument(phoneNumber, file.buffer, file.filename, caption)`.
5. Post Dynamics timeline entry on the Contact: `Tina sent {form.label} ({file.year}) to client via WhatsApp`.
6. Log `[TaxForms] sent key=... clientId=... year=...`.
7. Return tool output: `Sent the {form.label} for the {year} tax year.` (Claude can use this confirmation in its follow-up reply if needed, but typically the document caption is enough.)

**Errors:**

- SharePoint not configured (`GRAPH_CLIENT_ID` empty) → return text: `Form delivery isn't available in this environment.` Log `[TaxForms] sharepoint_unconfigured`.
- WhatsApp send fails → return text: `I hit a snag sending the form. Please try again in a moment.` Log `[TaxForms] send_failed key=... error=...`.

### 5.3 Personalization filter — `getPersonalizedForms`

```ts
function getPersonalizedForms(sourceCodes: string[]): TaxFormSpec[] {
  return TAX_FORMS.filter(form => {
    if (form.triggers.multiEmployer) return false;  // excluded from personalization
    const codes = form.triggers.sourceCodes ?? [];
    return codes.some(c => sourceCodes.includes(c));
  });
}
```

### 5.4 SharePoint resolver — `resolveLatestFormFile`

```ts
async function resolveLatestFormFile(form: TaxFormSpec) {
  const files = await sharePointService.listFormFiles();
  const matches = files
    .filter(f => f.name.startsWith(form.filenamePrefix))
    .map(f => ({ ...f, year: extractYearFromFilename(f.name) }))
    .filter(f => f.year !== null)
    .sort((a, b) => b.year - a.year);
  if (!matches.length) return null;
  const latest = matches[0];
  const buffer = await sharePointService.downloadFile(latest.id);
  return { buffer, filename: latest.name, year: latest.year };
}
```

`extractYearFromFilename` regex: `/-\s*(\d{4})\.pdf$/i` → captures `2026` from `3701 Vehicle Detail Sheet - 2026.pdf`.

### 5.5 Dynamics timeline contract

Send and receive events post `riivo_botaction` (or equivalent timeline entity already used by `send_invoice_pdf`) with:

- `subject`: `Tina sent {form.label} ({year}) to client` (send) or `Tina received completed {form.label} from client` (return).
- `regardingobjectid`: client Contact GUID.
- `description`: filename of the PDF.

Match the exact field shape `send_invoice_pdf` writes to keep timeline entries consistent.

### 5.6 Outbound copy contracts

**Catalog message — personalized mode, single recommendation, two omitted:**

```
Based on your profile, here's the form we'd recommend you fill in:

*{label}*
{whoShouldFill} {whatItCaptures}

Want me to send it through?

We also have the *{omitted[0].label}* and the *{omitted[1].label}* - you can request either anytime.
```

**Catalog message — personalized mode, two recommendations, one omitted:**

```
Based on your profile, here are the forms we'd recommend you fill in:

*{labels[0]}*
{whoShouldFill[0]} {whatItCaptures[0]}

*{labels[1]}*
{whoShouldFill[1]} {whatItCaptures[1]}

Want me to send either through?

We also have the *{omitted[0].label}* - you can request it anytime.
```

**Catalog message — all mode (no omitted-line):**

```
Here are the tax forms we have:

*{label[0]}*
{whoShouldFill[0]} {whatItCaptures[0]}

*{label[1]}*
{whoShouldFill[1]} {whatItCaptures[1]}

*{label[2]}*
{whoShouldFill[2]} {whatItCaptures[2]}

Reply with the name of any you'd like and I'll send them through.
```

**Send caption:**

```
Here's the {form.label} for the {year} tax year. Fill it in and send it back here when you're done.
```

**Trailing line appended to `get_required_documents` output (single relevant form):**

```
By the way, based on your travel allowance, we also have a *Vehicle Detail Sheet* you can fill in - ask anytime.
```

**Trailing line (two relevant forms):**

```
By the way, based on your profile, we also have a *Vehicle Detail Sheet* and *Commission Earner Expenses List* you can fill in - ask anytime.
```

All copy obeys Tina's formatting rules: single asterisks for bold, no Unicode bullets, hyphens (not em dashes) for asides, South African English, <150 words per response.

---

## 6. Observability

All counters emitted as structured log lines, prefix `[TaxForms]`. Format: `[TaxForms] <event> key=<form_key> clientId=<id> ...`.

**Events:**

| Event                          | When                                                                       |
|--------------------------------|----------------------------------------------------------------------------|
| `list_personalized`            | `list_tax_forms` ran in personalized mode; include `matched_count`.        |
| `list_all`                     | `list_tax_forms` ran in all mode.                                          |
| `list_empty_no_codes`          | Personalized mode but no source codes on file.                             |
| `list_empty_no_matches`        | Personalized mode, codes present, no trigger match.                        |
| `resolved`                     | SharePoint resolve succeeded; include `filename`, `year`.                  |
| `resolve_failed`               | No file matching `filenamePrefix` in SharePoint.                           |
| `sent`                         | PDF delivered via WhatsApp.                                                |
| `send_failed`                  | WhatsApp send threw or returned non-delivered.                             |
| `return_tagged`                | Inbound PDF matched a known filename prefix.                               |
| `return_tagged_via_context`    | Inbound PDF matched via 48h recent-send window, not filename.              |
| `return_untagged`              | Inbound PDF had no match anywhere; generic upload path.                    |
| `invalid_key`                  | `send_tax_form` called with a `form_key` not in the catalog.               |
| `sharepoint_unconfigured`      | `send_tax_form` called but Graph credentials are empty.                    |

Queryable in Azure App Service logs without additional infra.

---

## 7. Rollout Plan

1. **Land code** with all three tools, the menu row, the system-prompt additions, the trailing-line extension, and the return-tagging logic. No feature flag - new tools are additive and only surface to clients (existing role filtering enforces scope).
2. **Verify in dry-run.** With `GRAPH_*` and Meta credentials in staging, manually drive a conversation as a client with source code 3701: confirm `get_required_documents` appends the trailing line, `list_tax_forms` renders correctly, `send_tax_form` delivers the right PDF, and a filled-form return upload tags correctly.
3. **Deploy to production.** Monitor `[TaxForms]` log lines for the first 48 hours:
   - `resolved / (resolved + resolve_failed)` ≥ 99%.
   - `sent / (sent + send_failed)` ≥ 98%.
   - Any `invalid_key` events → bug, fix before declaring stable.
4. **Soft-announce** via existing client comms channels (no broad marketing). Track inbound volume of "what forms do I need to fill in?" against baseline.
5. **30 days post-launch:** review primary metric (§2). If `send_tax_form` fire rate is below 60% of personalized form triggers, investigate whether Claude is offering the form clearly enough or whether the trailing line is being missed in long messages.

---

## 8. Open Questions

None at design lock. All branches resolved during interview:

- Relationship to `get_required_documents`: linked but separate (Q1).
- Personalization: hybrid - personalized by default, full catalog on explicit ask (Q2).
- Catalog source of truth: hardcoded TypeScript, SharePoint stores binaries only (Q3).
- Tool surface: two tools (`list_tax_forms`, `send_tax_form`) (Q4).
- Audience: clients only - no leads, no staff variant (Q5, Q6).
- Return flow: tagged upload + Dynamics timeline entry, filename-match + 48h context fallback (Q7, Q11).
- Tax year: always send latest available in SharePoint (Q8).
- Menu surface: dedicated `📋 Tax forms to fill in` row (Q9).
- Form descriptions: locked verbatim (Q10).
- Catalog message format: personalized message names un-recommended forms in trailing line (Q12).
- Proactive offer: single trailing line on `get_required_documents`, not a full catalog (Q13).

If any assumption breaks during implementation (e.g., `riivo_currenttaxsubmission` source codes aren't reliably populated for clients eligible for forms, or SharePoint folder permissions don't extend to the app's Graph client), re-open here.
