# Tina — WhatsApp Bot Capabilities

A spec describing what Tina, TTT Financial Group's WhatsApp assistant, can do. Intended as a prompt for generating an HTML web resource (info / marketing page).

---

## 1. What is Tina?

Tina is TTT Financial Group's WhatsApp assistant. She lives on the public TTT WhatsApp number and helps three audiences:

- **Clients** — existing TTT customers asking about their account, invoices, tax returns, or documents.
- **Leads** — prospects partway through onboarding (signing the Letter of Engagement, completing the SARS eFiling OTP).
- **Staff** — TTT employees doing CRM operations from their phone.

She is powered by Claude (Anthropic) and integrates with Microsoft Dynamics 365, Microsoft Graph (Outlook), SharePoint, Supabase, and the Meta WhatsApp Cloud API. South African English, warm tone, never reveals she's AI, never promises follow-ups — every reply is final.

---

## 2. What clients can do with Tina

Tina answers tax and account questions for existing TTT clients in real time. She can:

**Account & billing**
- Show profile details on file (name, phone, email, ID, tax number)
- List invoices with status (paid, pending, overdue)
- Send any invoice as a PDF
- Show outstanding balance across all invoices
- Tell the client who their assigned consultant is
- Opt the client out of WhatsApp comms

**Tax returns & documents**
- Show open tax returns and where each one stands
- List documents TTT still needs (computed from SARS source codes + the client's industry)
- List documents already received
- Show submission status per tax year
- Show potential refund amount if available
- Show SARS audit status (days elapsed, 21-day vs 60-day window)
- Show the client's income tax number (ITN)
- Upload tax documents via WhatsApp: IRP5, IT3(a), IT3(b), payslips, medical certs, till slips, logbooks, ID, bank statements, tax certificates

**Help & escalation**
- Request a callback from the assigned consultant
- Get a personal referral link with full programme details
- Escalate any question Tina can't answer to `taxcrew@ttt-tax.co.za`

**Tax Q&A**
- General South African tax questions (brackets, deductions, deadlines, what an IRP5 is, provisional tax, VAT, PAYE)
- TTT service and pricing questions
- Person-specific tax matters are answered with general principles, then offered to a consultant for advice

---

## 3. What leads can do during onboarding

New leads sign up via a WhatsApp form (first name, last name, email, service needed: Tax / Accounting / Insurance / Financial Planning). After signup, Tina walks them through onboarding.

**Two gates for Tax leads:**

1. **Letter of Engagement (LoE)** — Tina sends a magic link valid for 72 hours. The client signs on a web form. Once signed, Tina sends a thank-you and notifies the tax crew by email.
2. **SARS eFiling OTP** — Tina walks the client through the exact SARS steps in plain language. Tina does *not* capture the OTP digits — the client completes the step on the SARS website themselves.

**Non-Tax leads:** LoE only (no OTP required).

**While onboarding:**
- Tina answers questions about the TTT process, timelines, what happens next
- Tina answers general tax education questions (what's an IRP5, what does provisional taxpayer mean, etc.)
- Tina refuses person-specific tax advice until both gates are clear (compliance boundary)
- Once the LoE is signed, Tax leads can fast-track an IRP5 upload while waiting for the OTP call (Tina OCRs it, parses the certificate, confirms employer/year, lists remaining docs)

---

## 4. What staff can do with Tina

Staff message Tina from their own WhatsApp to do CRM work without opening Dynamics. Permissions are role-based.

**Look up**
- Find a client or lead by name, phone, or ID number
- Pull up a client's profile, invoices, cases, or tax returns
- Search cases by reference (e.g. "Lloyd Pienaar - 2025")

**Create**
- Add a new lead (with service type and industry)
- Add a new contact (client)
- Create a new case or task against a client
- Create an invoice

**Letter of Engagement upload (two-phase)**
- Send a signed LoE PDF to Tina
- Mistral OCR converts it to markdown; Claude extracts 15 fields
- Staff confirms or corrects the extracted fields by chat
- On confirmation, Tina patches the lead record, attaches the PDF, and flips the "LoE received" flag

**Other**
- Upload documents on behalf of a client
- Send an invoice PDF to a client
- Request a consultant callback for a client
- Escalate to taxcrew

---

## 5. Proactive behaviours

Tina is mostly reactive, but she runs a few automated jobs in the background.

**Triggered by events:**
- When a client signs their LoE on the web form, Tina sends a thank-you message and emails the tax crew
- When a consultant forwards an email to `tina-bot@ttt-group.co.za`, Tina asks the client if they'd prefer to handle it on WhatsApp (Yes/No buttons); on Yes, Tina answers and emails the forwarder; on No, she lets them know the consultant will reply

**Scheduled (cron):**
- Hourly: safety-net sweep for any leads who signed their LoE but didn't get the activation message
- Daily: closes case threads that have had no client feedback for 12 hours (counts as resolved-by-bot timeout)
- Daily: renews the Microsoft Graph email subscription and expires stale relay consent requests

**Templates pushed from other systems:**
- Invoice reminders, referral invites, OTP reminders, and email-relay consent prompts can be sent via Meta-approved templates from external apps (campaign tool, Power Automate). Tina is notified so she has context if the client replies.

---

## 6. Referral programme

Tina explains and surfaces the referral programme, but never markets it proactively.

- Campaign runs **1 June 2026 → 30 September 2026** (signup window). First invoices must be paid in full by **31 December 2026** for the reward to land.
- **Rewards (incl VAT):**
  - First invoice under R1,725 → no reward
  - R1,725 to R4,999.99 → R500 cash
  - R5,000 and up → R1,000 cash
- Reward is **cash into the referrer's bank account**, not an invoice discount or credit.
- The friend gets nothing — no discount, no credit. They just have to be net-new to TTT.
- No cap. Every new friend = a separate reward.
- The client forwards their own link. Tina never sends it on the client's behalf.

---

## 7. Tone, style, and boundaries

**How Tina sounds:**
- Light, warm, occasionally playful — like a knowledgeable friend who happens to know South African tax inside out
- South African English (colour, organise, licence)
- Matches the user's register: formal users get professional-warm, casual users get playful-warm
- Short messages (max ~150 words), no closers like "Hope this helps"
- Never says "As an AI", never signs off, never promises follow-ups ("I'll check", "One moment", "I'll get back to you" are banned)

**What Tina won't do:**
- Coding help, general trivia, recipes, news, relationship advice, sports
- Other countries' tax systems
- Tell jokes on demand or roleplay
- Send referral links on a client's behalf
- Proactively suggest a consultant handoff (only when the client asks or is genuinely stuck)
- Capture SARS OTP digits (compliance boundary)

Out-of-scope inputs get a one-line redirect: *"I stick to TTT and South African tax — anything I can help you with there?"*

---

## 8. Under the hood (one-line each, for context only)

- **WhatsApp:** Meta Cloud API v22 — text, buttons, list menus, interactive forms (Flows), PDFs as document messages
- **AI:** Claude Opus 4.7 with prompt caching, forced-tool JSON for deterministic extraction
- **CRM:** Microsoft Dynamics 365 — source of truth for clients, leads, invoices, cases
- **Session store:** Supabase (Postgres) — sessions, conversation history, usage caps, idempotency
- **Email:** Microsoft Graph — shared mailbox `tina-bot@ttt-group.co.za` for the consultant→WhatsApp relay
- **Documents:** SharePoint — LoE PDFs, IRP5 certificates, client uploads
- **OCR:** Mistral OCR for LoE and IRP5 field extraction
- **Hosting:** Azure App Service

---

## How to use this document

Feed this whole file as a prompt to your HTML-generation tool. Ask for a clean single-page web resource that:

- Opens with what Tina is and who she serves
- Has three sections, one per audience (Clients, Leads, Staff), each with a tight bulleted list of capabilities
- Pulls out the referral programme as its own callout block (numbers and dates matter)
- Mentions tone and the things Tina deliberately won't do
- Closes with a short "under the hood" block for credibility, no jargon dump
- Uses TTT brand colours and South African English throughout
- No screenshots, no fake testimonials — facts only
