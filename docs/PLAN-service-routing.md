# Plan: Tina for TTT Financial Group (rename + tax/insurance routing)

Branch `feature/tina-service-routing` (worktree `worktrees/tina-service-routing`, cut from main `26df914`, 13 Nov 2026).

## Decisions (13 Nov 2026)

- **Intro:** one intro for everyone: "Tina from TTT Financial Group".
- **A.** An insurance-only client's message that isn't a claim goes to their broker as a request. Tina does not answer insurance questions herself.
- **B.** A tax-only client who mentions an insurance claim is offered a hand-over to the Insurance and Advice team. There's no claim walkthrough.
- **Bar:** no message is ever routed to the wrong side on a guess. When Tina is not sure, she asks with buttons, never with free text.

## Facts this plan rests on (PROD, read-only, 13 Nov 2026)

| | Contacts |
|---|---|
| Active contacts | 21,954 |
| Client Type has Tax | 20,066 |
| Client Type has Short Term Insurance / Long Term Insurance | 689 / 98 |
| Insurance and no Tax | 682 |
| Tax **and** Short Term Insurance | 80 |
| Accounting only (no Tax, no insurance) | 759 |
| Client Type empty | 447 (none has a policy or a tax consultant) |
| Contacts with a policy | 677; only 1 isn't typed as insurance |
| Insurance-typed contacts with no policy | 98 |
| Phones shared by an insurance contact and a non-insurance contact | **29** |

- Policy holder is always a contact. Policy status values: 463630000 Active, 463630001 Cancelled.
- `riivo_request` has no Notes in DEV or PROD, so a file can't be attached to a request.
- PROD bot (`ttt-prod-bot`, `ttt-prod-bot-worker`): `CLAIMS_ENABLED` is **not set**, so real claims are off. `ROADSIDE_ENABLED=true` does nothing without it. `CLAIMS_GUIDED_FORM=on`.
- Main deploys to PROD on every push, so everything new goes behind a switch.
- Sessions time out after 30 minutes idle (`SESSION_TIMEOUT_MINUTES`).

## How Tina routes today (what changes)

`processMessage` in `src/workers/whatsappProcessor.ts`:
- Line 1030: every client text goes to `handleClientClaimMessage`. Claim words, then a Haiku yes/no, then the claim walkthrough. A tax-only client lands on "no active policy, passed to insurance team".
- Everything else, including every message from an insurance-only client, goes through the tax path: the tax welcome menu, the tax document filing, and Claude with the tax prompt.
- `getContactByPhone` returns the **first** contact for a phone. On the 29 shared phones, whether Tina sees the tax contact or the insurance one is chance.

## Design

### 1. What the client is (`serviceLines`)

A new CRM read, per client message:
- All active contacts on the phone (same `phoneOrFilter` as `getContactByPhone`), with `riivo_clienttypenew`.
- Their **active** policies (`riivo_policy_status eq 463630000`).

From those:
- **insurance** = any contact whose Client Type has 2 or 3, or who has an active policy.
- **tax** = any contact whose Client Type has 0 or 1. Accounting rides on the tax side, as it does today.
- **neither** (Client Type empty) = treated as **both**, so Tina asks when unsure.
- `insuranceContactId`:
  - the resolved contact if it is an insurance contact;
  - otherwise the single other insurance contact on the phone;
  - otherwise **ambiguous** (more than one). In that case Tina never guesses, and the message goes to the Insurance and Advice team.
- **CRM read fails** = treated as **both** (ask when unsure). It never falls back to "tax only".

### 2. The decision: one pure function (`src/domain/serviceRoute.ts`)

`decideServiceRoute(input) → verdict`. It has no I/O, like `decideCaseRouting`, and is tested as a table. The inputs are:
- lines;
- the session's sticky side;
- a pending ask;
- the tap id;
- whether the message is a document;
- whether the message is a greeting on a fresh session;
- whether a claim or roadside walkthrough is in progress;
- the word-check result;
- the model's verdict (for a second pass).

Verdicts: `claims-walkthrough` · `tax` · `insurance` · `ask` · `offer-insurance` · `needs-model`.

Rules, in order:
1. **A claim or roadside walkthrough in progress keeps the message.** This is unchanged and comes first.
2. **A tap on an "Insurance" / "Tax" ask button.** It sets the sticky side for the session and replays the stored message on that side.
3. **A tap on the B offer.**
   - "Yes, contact me": a hand-over to the Insurance and Advice team.
   - "No, it's about tax": sets sticky tax and replays the stored message on the tax path.
4. **Sticky side set this session:** use it. The exception is a dual client whose message says insurance while sticky is tax (or the reverse). That goes back to the model, so a topic change mid-session still gets caught.
5. **Tax only:**
   - no claim words: `tax` (today's path);
   - claim words: `needs-model`. The model says claim → `offer-insurance`, anything else → `tax`.
6. **Insurance only:** `insurance`, always. Documents, greetings and every text.
7. **Both:**
   - a greeting on a fresh session: the combined menu;
   - no insurance words: `tax`;
   - insurance words: `needs-model`. Insurance → `insurance`, tax → `tax`, unsure → `ask`;
   - documents follow the sticky side, else `tax` (today's path).

**Model step (dual clients only, plus the B check).** This is a new Tina-side classifier on Haiku, with a forced tool call, the same pattern as `intent.ts`. It answers `insurance` / `tax` / `unsure`.
- Code accepts only an explicit `insurance` or `tax`.
- A refusal, an error or a malformed answer is `unsure`, so Tina asks.
- A 429 re-enqueues the message, the same as claims do today.
- The shared package's `claimRoute` stays as it is, so this needs no agent PR.

**Words.** This is a separate, wider "insurance words" list for dual clients: the claim words plus policy, cover, covered, premium, excess, insurer, insurance, broker, quote, renewal, vehicle, car, house contents, and so on. Missing a word costs nothing, because the tax prompt line (below) sends the client to the Insurance button.

### 3. What each verdict does

**`tax`.** Today's path, unchanged. The tax prompt gets one new line: insurance questions are not answered, and Tina says "tap Insurance in the menu or just say *insurance* and I'll pass it on".

**`insurance`** (a new `src/domain/insuranceHost.ts`, with its ports wired in `src/services/insurance.service.ts`):
- **Greeting on a fresh session:** the insurance menu.
  - Header: "Hey {name}! 👋 Tina from TTT Financial Group. What can I help with?"
  - Options: **Report a claim** · **Car broken down** (only when roadside is on) · **Something else**.
- **Claims on (`CLAIMS_ENABLED`):** `claimFromClient` on `insuranceContactId`, with the word filter **off** (the demo numbers already run this way). Not a claim, and not handled: a broker hand-over.
- **Claims off (PROD today):** every message, claims included, is a broker hand-over. Nothing is lost while claims stay off.
- **Broker hand-over:**
  - **Request:** a `riivo_request` with category Insurance (1), owned by Tina's app user. Insurance roles can't own requests, as noted in `claims.service.ts`.
  - **Follow-up:** an Agent Action **Follow-up**, Insurance and Advice, assigned to the broker. The broker is:
    1. the contact's `riivo_mainbroker`, if that user is enabled;
    2. else the owner of their active policies, if it's one enabled user;
    3. else the Insurance and Advice team.

    This reuses the package's `createAgentAction` / `claimOwner` / `insuranceTeam`.
  - **Reply:** fixed text "Thanks {name}, I've passed this to {broker first name / our insurance team}, who'll get back to you." It goes through the claims `claimGate`.
  - **Later messages in the same session** are logged on the same request with a short "Added that for {broker}." No new request is opened per message.
- **Documents (outside a claim):** these never go to the tax filing. The file goes into the client's SharePoint contact folder under `Insurance/`, and the Follow-up names the file. Before building, check in DEV that brokers can open that folder. If they can't, use a note on the contact.
- **No** tax case flow: no `caseService` L1/escalation, no feedback prompt, no tax bad-debt text.

**`ask`.** Reply buttons "🛡️ Insurance" / "🧾 Tax". The body reads "Is this about your insurance or your tax?". The message waiting for an answer is stored on the session.
- The next free-text message clears the pending ask and is routed on its own.
- An ask is never sent twice in a row for the same message.

**`offer-insurance`** (decision B):
- Body: "TTT Financial Group also does insurance. I can't see a policy for you with us. Want our insurance team to contact you?"
- Buttons: "Yes, contact me" / "No, it's about tax".
- Yes: an Insurance request plus a Follow-up to the Insurance and Advice team (reason "client asked about insurance"), and a confirmation.
- No: replay the message on the tax path.

**Dual-client welcome menu.** The tax menu plus a **🛡️ Insurance (claims & policies)** row. The tap sets sticky insurance and shows the insurance menu.

### 4. Session state (Supabase migration)

`sessions`: a new nullable `service_side text` ('tax' | 'insurance') and `pending_route jsonb` ({ kind: 'ask' | 'offer', text, wamid, at }). The migration is applied to Supabase **before** merge, the same way as PR #55.

### 5. Rename: "Tina from TTT Financial Group"

| Where | Today | Change |
|---|---|---|
| `claude.service.ts:58` system prompt | "Tina, TTT's (The Tax Team's) WhatsApp tax assistant" | "Tina from TTT Financial Group". TTT does tax, accounting and insurance; in this chat she helps with tax and accounting. Plus the insurance hand-off line |
| `claude.service.ts:492` first-message rule | "TTT's WhatsApp tax assistant" | "Tina from TTT Financial Group" |
| `whatsappProcessor.ts:263` welcome menu | "your TTT tax sidekick" | "Tina from TTT Financial Group" |
| `clientRoleContext.ts:48` | tax-only client text | Check the wording; the tax doc guidance stays |
| `case.service.ts:878` summary prompt | "Tina (an AI assistant at TTT Financial Group)" | Already right |
| `emailRelay.controller.ts:24` | "TTT's 24/7 tax assistant" | **This is a Meta-approved template body.** A new template has to be approved first, then the code copy is swapped. Ship it separately |

Not renamed:
- The IRP5 and LOE extractor prompts, which describe documents, not Tina.
- "Scope: tax services only" in the referral rules, which is still true.

Still to check (needs TTT's Meta Business access): the WhatsApp **display name** and any other approved template that says "tax assistant" (campaign / "Meet Tina"). Changing the display name needs Meta review.

### 6. Switch

- **`SERVICE_ROUTING_ENABLED`** (default off). With it off, Tina behaves exactly as today apart from the rename.
- **`SERVICE_ROUTING_NUMBERS`** (optional list). Routing applies only to those phones, so it can be tried on PROD with our own numbers before everyone gets it.

### 7. Logging

Every client message logs one line:

`[Route] phone=… lines=tax,insurance sticky=… words=… model=… verdict=… why=…`

The verdict is also stamped on the request (`riivo_classificationtopic`: Insurance hand-over / Insurance offer), so the routing can be checked in the CRM afterwards.

## Build order

1. Rename (section 5, everything except the relay template). A small PR that can ship on its own.
2. `serviceLines` CRM read and its tests: shared phones, an empty type, cancelled policies only, a failed read.
3. `decideServiceRoute`, with a full decision table test covering every line combination × sticky × pending × document × greeting × walkthrough.
4. The dual-client classifier and its **eval set**: at least 80 labelled messages, run against Haiku.
   - Tax "claim" phrasing: "claim my medical aid", "claim travel", "can I claim home office".
   - Insurance phrasing: a crash, a burst geyser, "send my policy schedule", "is my laptop covered".
   - Truly ambiguous ones, such as "I need to claim" or "question about my excess payment".
   - **Bar:** no insurance message ever answered `tax`, no tax message ever answered `insurance`. `unsure` is allowed only on the ambiguous set.
5. The insurance host: menu, broker hand-over, documents, and claims on/off.
6. Ask buttons, the B offer, the dual menu row, the session columns and the migration.
7. Wire it into `processMessage`, replacing line 1030, behind the switch. Leads, unknown numbers, staff and the demo numbers stay untouched.
8. DEV walkthrough on real WhatsApp with test contacts:
   - tax-only;
   - insurance-only (claims on, and claims off);
   - dual;
   - empty type;
   - a shared phone (tax contact + insurance contact);
   - an insurance contact with no policy.

   Each one goes through a greeting, a claim, a non-claim insurance question, a tax "claim" question, a document, and ask → tap → replay.
9. PR, which you merge. Then PROD with `SERVICE_ROUTING_NUMBERS` = our phones, then everyone.

## Out of scope

- Leads (lead type insurance) and unknown numbers: they stay as today.
- Tina answering insurance questions herself (option 2 of A).
- The email agent.
- Turning real claims on in PROD (`CLAIMS_ENABLED`). That is its own release decision.

## Build notes (13 Nov 2026)

Built on `feature/tina-service-routing`. Where the build differs from the plan above:

- **Broker never named.** The claims package already has TTT's rule (28 Oct 2026, `CLIENT_BROKER`). The hand-over says "your broker" or "our insurance team", never the person's name.
- **Insurance menu has two buttons:** Report a claim and Something else. There's no "Car broken down" button: roadside help still works from free text when claims and roadside are on.
- **Files:** a note (annotation) on the insurance contact. `riivo_request` has no Notes, and Notes avoid the SharePoint permission question.
- **Tax-only clients:** the model step uses the same insurance/tax/unsure check as dual clients. It is not the claims package's claim yes/no, so "do you do car insurance?" also gets the offer. Unsure stays tax.
- **Typed answers:** "insurance" / "tax" typed after the question, and yes / no typed after the offer, read as the taps. A bare "insurance" at any time opens the insurance menu (or the offer, for a tax client).
- **Thanks / ok** from an insurance client never opens a hand-over.
- **The model step** has its own setting, `SERVICE_ROUTING_MODEL`. The default is `CLAIMS_INTENT_MODEL`, then Haiku 4.5.

Checked:
- Unit tests: routing, insurance side, claims host options and the switch. 290 pass; the one failure is `toolRegistry`, which needs Graph credentials and failed before this work.
- DEV run (`src/scripts/route-dev-check.ts`), using real DEV Dataverse with faked WhatsApp and Supabase: insurance-only, tax-only and both clients, plus the model-failure fallback. Requests, Follow-ups (owned by the main broker or the team, due the next working day) and the file note were checked, then the test rows were deleted.
- The CRM queries also run read-only in PROD.

Before switching on:
1. **Run the eval** (`ANTHROPIC_API_KEY=… npx tsx src/scripts/side-intent-eval.ts 3`). It must report 0 sent to the wrong side. It hasn't been run yet, because there is no Anthropic key on this machine.
2. **Apply the migration** `supabase/migrations/20261113120000_session_service_route.sql` to Supabase. It only adds nullable columns, and nothing reads them while the switch is off.
3. **Set** `SERVICE_ROUTING_ENABLED=true` and `SERVICE_ROUTING_NUMBERS=<our phones>` on `ttt-prod-bot` and `ttt-prod-bot-worker`. Then test on WhatsApp, then clear the number list.
4. **Separately:** a new Meta template for the email-relay intro, and TTT checking the WhatsApp display name.
