# CRM spec — Tax-Season FAQ bot

Changes the Dynamics admin needs to apply before the WhatsApp bot can answer:
**What's my refund? / Have you submitted me? / What docs do you need? / Have you received my docs? / Audit status.**

Scope: existing tax clients only, real-time reads, source of truth = Dynamics.

---

## 1. Field audit — already present, no work needed

The bot will read these as-is.

| Entity | Field | Used for |
|---|---|---|
| `new_case` | `icon_casestage` | Case stage answers (refund / submission context). NOT used for audit detection — no stage value in this environment is "On Audit" |
| `new_case` | `ttt_caseonaudit` | Audit detection. OptionSet: 958140001 = Yes, 958140000 = No, 100000001 = To be determined. Only an explicit Yes counts as on audit |
| `new_case` | `ttt_taxyear` | Per-year filtering / display |
| `new_case` | `riivo_potentialrefund` | Refund amount answer |
| `new_case` | `riivo_dateplacedonaudit` | Audit duration calculation |
| `new_case` | `_ttt_clientname_value` | Case-to-contact link |
| `new_case` | `statecode`, `createdon`, `_ownerid_value` | Active-only filtering + nudge-email routing |
| `riivo_preseasondocumentation` | `_riivo_customer_value`, `riivo_taxyear` | Per-client × year lookup |
| `riivo_preseasondocumentation` | `statuscode` (1 = Awaiting Documents, 100000001 = Ready for Submission) | Bot reads "ready for submission" directly from the existing status reason — no new Bool needed |
| `riivo_preseasondocumentation` | `riivo_irp5`, `riivo_irp5status`, `riivo_irp5documentation_name` (+ same triplet for 12 other types) | Outstanding + received doc answers |
| `riivo_taxsubmissionsdocuments` | `_riivo_case_value`, `_riivo_client_value`, `_riivo_documenttype_value`, `riivo_taxyear`, `riivo_filereference` | Per-case received doc answers |

## 2. New fields — admin must create

### 2.1 On `new_case`
None. Everything the bot needs for Q1/Q2/Q5 is already there.

### 2.2 On `riivo_preseasondocumentation`

None. The entity already has a `statuscode` ("Status Reason") OptionSet with the two values the bot needs:

- `1` — Awaiting Documents
- `100000001` — Ready for Submission

The bot reads `statuscode` directly to tell pre-submission clients whether they're good to go. (The original plan called for a new `riivo_readytosubmit` Bool — dropped after the existing status reason was confirmed sufficient.)

### 2.3 On `riivo_taxsubmissionsdocuments`

| Field | Type | Purpose |
|---|---|---|
| `_riivo_preseasondoc_value` | Lookup → `riivo_preseasondocumentation` | Parent link from individual uploaded doc back to its preseason record. Decided in Grill 6: explicit lookup beats join-by-(client+year). Populated by the email Power Automate flow at row creation (and by the WhatsApp bot in v2). |

## 3. New Power Automate flow — "Preseason status-reason recalc"

**Trigger:** create or update on `riivo_taxsubmissionsdocuments` where `_riivo_preseasondoc_value` is not null.

**Action:**
1. Fetch the parent `riivo_preseasondocumentation` row.
2. For each per-type triplet on the preseason record where the applicability bool is true (`riivo_irp5`, `riivo_logbook`, `riivo_medicalaid`, etc.), check whether at least one child `riivo_taxsubmissionsdocuments` row exists with the matching `_riivo_documenttype_value`.
3. If every applicable type has at least one matching child row, set `statuscode = 100000001` (Ready for Submission). Otherwise leave it at `statuscode = 1` (Awaiting Documents).

The mapping from per-type bools on `riivo_preseasondocumentation` to `riivo_documenttype` lookup values needs to be hand-curated once in the flow — there are ~13 doc types.

## 4. Lifecycle hand-off

Decided in Grill 6 (option c): when `new_case` is created from a "ready" preseason record, `riivo_taxsubmissionsdocuments` rows get a **second lookup** to the case. Specifically `_riivo_case_value` (already on the entity) gets populated by whoever creates the case (manual or automated). Preseason lookup stays for history.

No re-parenting. No mirroring. Bot reads child rows by either lookup depending on which entity it's answering from.

## 5. Bot behaviours that don't need CRM changes but you should know about

- **Refund nudge email** — when a client asks about their refund and `riivo_potentialrefund` is null or 0, the bot replies "we're not sure yet" AND fires an email to `_ownerid_value` (the case owner) via tina-bot's shared mailbox. Subject: "Client X asking about refund — please confirm potential amount." No CRM change required, but consultants should expect these.
- **Audit duration math** — 21 working days standard, up to 60 working days in special circumstances. Working-day calc is Mon-Fri only in v1 (no ZA public holiday calendar yet). If a case has been on audit > 60 working days, the bot escalates to "your consultant will follow up" rather than guessing.

## 6. Acceptance — how to know it's working

1. Pick a real tax client with an active 2025 case and confirmed refund. Ask the bot "what's my refund?" — should return the rand value, the year, and the stage.
2. Pick a real client with `riivo_potentialrefund` null. Ask the same question. Case owner should receive a tina-bot email within seconds.
3. Pick a real client whose preseason record has only `riivo_irp5_status = received`. Ask "what docs do you need?" — should list every other applicable type as outstanding.
4. Manually create a `riivo_taxsubmissionsdocuments` row with the new preseason lookup populated. Ask "have you received my docs?" — should list it.
5. Place a real case on audit — set `ttt_caseonaudit` to **Yes** — and set `riivo_dateplacedonaudit` to 10 working days ago. Ask "audit status?" — should say standard 21-day window, X days in. Setting the stage alone does nothing; the bot reads `ttt_caseonaudit`.
