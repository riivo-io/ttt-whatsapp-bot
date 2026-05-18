# Request lifecycle & WhatsApp comms threading

How every client/lead question should be tracked as a `riivo_request` record in Dynamics, how all WhatsApp comms should hang off that record, and the fields we need to add so resolution state is visible in CRM (not just Supabase).

---

## 1. Current state (what's wrong)

| Flow | Entity | `regardingobjectid` | Created for leads? | Resolution visible in CRM? |
|---|---|---|---|---|
| Inbound message log | `riivo_whatsappcommunicationses` | → Contact or Lead | Yes | n/a |
| Outbound message log | `riivo_whatsappcommunicationses` | → Contact or Lead | Yes | n/a |
| Question tracking | `riivo_requests` | *(not set)* | **No — clients only** | **No — lives in Supabase only** |

**Three concrete problems:**

1. **A question from a lead creates zero `riivo_request` records.** [webhook.controller.ts:248](../src/controllers/webhook.controller.ts#L248) gates case creation on `crmEntity.type === 'client'`. Lead questions are answered by the bot but never tracked.
2. **Comms aren't threaded under the request.** Every inbound/outbound message logs a `riivo_whatsappcommunicationses` with `regardingobjectid` pointing at the Contact/Lead, not at the request it belongs to. So in CRM you can't open a request and see the conversation that produced it.
3. **Resolution state is invisible in CRM.** Supabase's `whatsapp_cases` tracks `status`, `resolved_at`, `feedback_received`, `level_topic`, etc. — none of that is mirrored onto the `riivo_request` record. Staff opening a request in Dynamics can't tell whether it was auto-resolved, escalated, or timed out.

---

## 2. What we must build

### 2.1 Create a request for **every** qualifying question (client OR lead)

- Drop the `type === 'client'` gate at [webhook.controller.ts:248](../src/controllers/webhook.controller.ts#L248).
- Widen `caseService.createCase` so the `contactType` passed to `dynamicsService.createRequest` can be `'client' | 'lead'`. The Dynamics side already supports both bindings (`riivo_Client@odata.bind` and `riivo_Lead@odata.bind`) at [dynamics.service.ts:1122-1168](../src/services/dynamics.service.ts#L1122).
- Keep the existing `qualifyMessage` filter at [case.service.ts:62](../src/services/case.service.ts#L62) (short / emoji-only / noise words still skip). That rule is orthogonal to entity type.

### 2.2 Thread WhatsApp comms under the request via `regardingobjectid`

The polymorphic `regardingobjectid` on `riivo_whatsappcommunicationses` should point at the **request** whenever one exists, not at the contact/lead. Add a lookup binding:

```
payload['regardingobjectid_riivo_request@odata.bind'] = `/riivo_requests(${requestId})`;
```

(The exact schema name for the relationship from `riivo_whatsappcommunicationses` → `riivo_request` needs to be confirmed in Dynamics — probably `regardingobjectid_riivo_request` but verify before coding.)

**Two threading problems to solve:**

**(a) Ordering — the inbound log runs before the request is created.**
Today [webhook.controller.ts:198-201](../src/controllers/webhook.controller.ts#L198-L201) calls `logMessage` *before* the case pipeline kicks off at line 248. To bind to the request, we need to create the request first, then log with the request id. Two options:

- **Option A (preferred):** Synchronously create the `riivo_request` before the parallel AI/log fan-out. Small latency cost (one extra Dynamics POST before the AI call starts), but the data model stays clean.
- **Option B:** Log the comms with no `regardingobjectid`, then PATCH the record after the request is created. Two writes per message, harder to reason about, worth avoiding unless Option A's latency is measurably bad.

**(b) Continuation messages — follow-ups that don't qualify as new questions.**
A client's first message ("How does CGT work?") creates request R1. Their follow-up ("Thanks!") fails `qualifyMessage` so no new request is created — but the "thanks" is still part of the R1 conversation and should thread under it.

Fix: at `logMessage` time, if `qualifyMessage` fails but there's an open request for this phone in the last N hours (e.g. 12h — same window as `FEEDBACK_TIMEOUT_HOURS`), look it up and use its id as `regardingobjectid`. Otherwise fall back to contact/lead.

This means adding `supabaseService.findOpenRequestForPhone(phone)` that returns the most recent `whatsapp_cases` row with `status NOT IN ('resolved_by_bot', 'resolved_by_bot_timeout', 'escalated')`.

### 2.3 Make resolution visible in CRM

Mirror Supabase's `whatsapp_cases` state onto the `riivo_request` record whenever it changes. Every state transition in [case.service.ts](../src/services/case.service.ts) that touches `whatsapp_cases` should also PATCH the corresponding `riivo_request`.

---

## 3. New fields on `riivo_requests` (Dynamics schema changes)

These are the additions needed so a staff member opening the request in Dynamics can tell exactly what happened, without bouncing to a dashboard or Supabase.

### Status & resolution

Use Dynamics' built-in `statecode` (state) and `statuscode` (status reason) rather than a custom option set — it plugs straight into Advanced Find, views, dashboards, and BPF stages without extra work. Status reasons in Dynamics are scoped to a state, so every transition updates both fields together.

**State → Status reason mapping:**

| `statecode` | `statuscode` (status reason) | When it applies | Mirrors Supabase `whatsapp_cases.status` |
|---|---|---|---|
| **Active (0)** | `New` | Request just created, classifier hasn't run yet | `created` |
| **Active (0)** | `Classified` | Classifier done; bot hasn't answered yet | `classified` |
| **Active (0)** | `Bot Answered` | Bot sent its reply | `bot_responded` (pre-feedback) |
| **Active (0)** | `Awaiting Feedback` | Yes/No buttons sent, waiting on user | `bot_responded` (with `pending_case_id` set) |
| **Active (0)** | `Escalated` | Needs a human — bot classified as escalation OR client rejected the bot answer. Still active because a consultant must work it. | `escalated` |
| **Inactive (1)** | `Resolved by Bot` | Client tapped "Yes, thanks" | `resolved_by_bot` |
| **Inactive (1)** | `Resolved (Timeout)` | 12h elapsed with no feedback — assumed resolved | `resolved_by_bot_timeout` |
| **Inactive (1)** | `Resolved by Staff` | Consultant answered and marked complete in CRM | *(staff-only — no Supabase equivalent)* |
| **Inactive (1)** | `Closed` | Terminal non-resolution: cancelled, duplicate, spam, won't-fix | *(staff-only)* |

Two calls worth explaining:

- **Escalated stays Active.** It's tempting to flip to Inactive at hand-off, but the request is still open work for the consultant. Moving it to Inactive would remove it from active-work views and risk it getting forgotten. It becomes Inactive only when the consultant transitions it to `Resolved by Staff` or `Closed`.
- **"Resolved (Timeout)" is distinct from "Resolved by Bot".** Same state, different status reasons — so dashboards can tell the difference between "client confirmed the answer worked" and "client went silent, we assumed it worked". Low-confidence bucket for audit sampling.

### Additional resolution fields

| Field (suggested schema name) | Type | Purpose |
|---|---|---|
| `riivo_resolutionmethod` | Option Set | How it was resolved: `Auto (direct answer)`, `Auto (tool call)`, `Feedback confirmed`, `Timeout — assumed resolved`, `Staff resolved`, `Not resolved (escalated)`. Adds detail beyond the statuscode — e.g. distinguishes a tool-call resolution from a direct-knowledge answer. |
| `riivo_resolvedon` | Date/Time | When the request transitioned to any Inactive statuscode. |
| `riivo_resolvedby` | Lookup → `systemuser` | Populated for `Resolved by Staff` and `Closed`; `null` for bot/timeout resolutions. |

### Classification & feedback

| Field | Type | Purpose |
|---|---|---|
| `riivo_classificationtopic` | Option Set or Single Line of Text | Mirror of Supabase `level_topic` (`tax_season_dates`, `case_status`, `invoice_query`, `general_tax_question`, etc.). Useful for reporting. |
| `riivo_classificationlevel` | Option Set | `L1` (bot-handleable) vs. `Escalation` (needs human). Mirrors Supabase `level`. |
| `riivo_clientfeedback` | Option Set | `Confirmed`, `Rejected`, `No response (timeout)`, `Not asked`. |
| `riivo_botanswer` | Multiline Text | The answer the bot actually sent. Helpful for staff reviewing accuracy or handling a rejected-feedback follow-up. |

### Escalation & assignment

| Field | Type | Purpose |
|---|---|---|
| `riivo_escalatedto` | Lookup → `systemuser` | Consultant assigned when a request escalates. Populated by Power Automate flow (existing) or a future routing tool. |
| `riivo_escalatedon` | Date/Time | Timestamp of escalation. |
| `riivo_escalationreason` | Option Set | `Bot classified as escalation`, `Client rejected bot answer`, `Staff manually escalated`, `Contains sensitive topic`. Helps tune the classifier over time. |

### Optional (nice to have, not blocking)

| Field | Type | Purpose |
|---|---|---|
| `riivo_aiconfidence` | Decimal (0–1) | Classifier confidence score. Useful for spotting low-confidence auto-resolutions to audit. |
| `riivo_responsetimeseconds` | Whole Number | Time from inbound to bot reply. SLA dashboard input. |
| `riivo_resolutiontimehours` | Decimal | Time from `New` → terminal status. |

---

## 4. State transitions — where each field gets written

| Event | Supabase update | Dynamics `riivo_request` update (`statecode` / `statuscode` + fields) |
|---|---|---|
| Question arrives, qualifies | `status = 'created'` | Create record: `statecode = Active`, `statuscode = New` |
| Classifier runs | `status = 'classified'`, `level`, `level_topic` | `statuscode = Classified`, `riivo_classificationlevel`, `riivo_classificationtopic` |
| Bot sends answer | `status = 'bot_responded'`, `resolution_method` | `statuscode = Bot Answered`, `riivo_botanswer`, `riivo_resolutionmethod = Auto (direct answer)` |
| Feedback buttons sent | `status = 'bot_responded'` (unchanged) | `statuscode = Awaiting Feedback` |
| Client taps "Yes, thanks" | `status = 'resolved_by_bot'`, `feedback_received = 'confirmed'`, `resolved_at` | `statecode = Inactive`, `statuscode = Resolved by Bot`, `riivo_clientfeedback = Confirmed`, `riivo_resolvedon`, `riivo_resolutionmethod = Feedback confirmed` |
| Client taps "No, I still need help" | `status = 'escalated'` | `statuscode = Escalated` (stays Active), `riivo_escalationreason = Client rejected bot answer`, `riivo_escalatedon` |
| 12h elapsed, no feedback (cron) | `status = 'resolved_by_bot_timeout'`, `feedback_received = 'timeout'`, `resolved_at` | `statecode = Inactive`, `statuscode = Resolved (Timeout)`, `riivo_clientfeedback = No response (timeout)`, `riivo_resolvedon`, `riivo_resolutionmethod = Timeout — assumed resolved` |
| Classifier says escalation | `status = 'escalated'` | `statuscode = Escalated` (stays Active), `riivo_escalationreason = Bot classified as escalation`, `riivo_escalatedon` |
| Staff manually resolves in Dynamics | *(no Supabase update — Dynamics is authoritative here)* | `statecode = Inactive`, `statuscode = Resolved by Staff`, `riivo_resolvedby`, `riivo_resolvedon`, `riivo_resolutionmethod = Staff resolved` |
| Staff cancels / dedupes in Dynamics | *(no Supabase update)* | `statecode = Inactive`, `statuscode = Closed`, `riivo_resolvedby`, `riivo_resolvedon` |

One wrinkle worth flagging: **Supabase and Dynamics can diverge** if staff edit the request directly in Dynamics. Decide up-front: either (a) Dynamics is authoritative for terminal states and Supabase is a write-cache, or (b) Supabase is the source of truth and CRM edits get overwritten. Option (a) is more pragmatic for reporting workflows.

---

## 5. Implementation plan

Pragmatic order — each step is independently deployable:

1. **Schema changes in Dynamics** (Solution author, not code).
   - Add the fields in §3 to `riivo_requests`.
   - Confirm the lookup relationship name from `riivo_whatsappcommunicationses` → `riivo_request` for the `regardingobjectid` binding.

2. **Code: widen request creation to leads.**
   - Drop the `type === 'client'` gate at [webhook.controller.ts:248](../src/controllers/webhook.controller.ts#L248).
   - Pass `contactType: crmEntity.type` through `caseService.createCase` → `dynamicsService.createRequest`.

3. **Code: reorder so the request exists before comms log.**
   - Move the request creation ahead of the inbound `logMessage` call.
   - `logMessage` gains an optional `requestId` parameter; when present, binds `regardingobjectid_riivo_request@odata.bind` instead of the contact/lead binding.

4. **Code: thread continuation messages.**
   - Add `supabaseService.findOpenRequestForPhone(phone, windowHours = 12)`.
   - In `logMessage` callers, if no new request was created this turn, look up the open one and pass its id.

5. **Code: mirror state transitions to Dynamics.**
   - In each `caseService` state-change method (`recordBotResponse`, feedback handlers, timeout sweep), add a `dynamicsService.updateRequest(requestId, patch)` call after the Supabase update. Best-effort — Dynamics failure should not block the Supabase update.

6. **Backfill (optional).**
   - One-off script: walk existing Supabase `whatsapp_cases` rows with a `crm_case_id` and PATCH the corresponding `riivo_requests` record with status/resolution fields so the CRM reflects history.

---

## 6. Open decisions for the team

- **Authoritative source for terminal state:** Dynamics or Supabase? (See note in §4.)
- **Escalation routing:** is the existing Power Automate flow going to write `riivo_escalatedto`, or should the bot nominate a consultant (e.g. the client's owning consultant) and let the flow confirm?
- **Timeout window:** currently 12h. Keep at 12h for the Dynamics mirror, or separate SLA?
- **Lead requests in reporting:** will lead-sourced requests skew client-support metrics? May want a `riivo_sourcetype` (`Client`, `Lead`) filter field for dashboards.
