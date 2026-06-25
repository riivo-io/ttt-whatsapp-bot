# TTT Financial Group — Personal Income Tax: Document Requirements Guide

> **In-repo snapshot — source of truth for the recommendation kernel.**
> This is the consultants' SharePoint document-requirements guide, transcribed
> verbatim into the repo as a **dated snapshot of the 2026 tax year**
> (assessment period **01/03/2025 – 28/02/2026**). Periods are left literal here
> exactly as the guide states them; the kernel (`src/domain/docRecommendation.ts`)
> derives live periods from the assessment year itself and does **not** read the
> dates off this file.
>
> **This file is authoritative.** Where this guide and the kernel disagree, the
> guide wins and the kernel is rewritten to match it (see the ADR 0002 addendum,
> `docs/adr/0002-document-collection-journey.md`). Editing the SharePoint guide
> obliges an engineer to re-sync the kernel against this snapshot — this is a
> **manual sync point**, the same posture as the manually-applied Supabase
> migrations.
>
> Snapshot taken for the 2026 tax year. Next year's guide replaces this file
> wholesale; do not hand-edit individual periods.

---

## How to use this guide

Send us whatever applies to you. Each scenario below lists the documents we need
to complete your return correctly and the reason we need them — so you can
pick out the ones that fit your situation and skip the ones that don't.

The assessment period for the **2026 tax year** is **01/03/2025 – 28/02/2026**.
Wherever a document is needed "for the tax year," that is the period we mean.

---

## Everyone (baseline)

Every client sends these, regardless of how they earn:

- **IRP5** — your employer's tax certificate, the starting point for your return.
- **Investment tax certificates (IT3(b)/IT3(c))** — declare the interest and
  investment income you earned from each bank, savings or investment account.
- **Medical aid tax certificate** — only if you belong to a medical scheme; lets
  us claim your contributions.
- **Retirement annuity (RA) tax certificate** — only if you contribute to an RA;
  lets us claim your contributions as a deduction.

(No bank statements and no ID document are needed as a baseline — those apply
only to specific scenarios below.)

---

## Commission earners — source code 3606

If your IRP5 carries source code **3606**, you earn commission and can claim
your business and vehicle expenses against it. Complete the attached templates,
and send the supporting documents **only if you want to claim** those expenses:

**Complete and return these templates:**

- **Vehicle Detail Sheet** *(complete attached template)* — only if you want to
  claim vehicle expenses against your own car. The template captures your
  logbook, service records and the dates you were away, so you don't need to dig
  those out separately.
- **Commission Earner Expenses List** *(complete attached template)* — list your
  business expenses (till slips, client entertainment, etc.) here so we can
  claim them in one go.

**Supporting documents — only if you want to claim commission / vehicle
expenses against your own car:**

- **Vehicle purchase agreement** — to establish your vehicle's value.
- **Vehicle finance statements** — to claim the finance interest on the vehicle.
- **Vehicle insurance policy schedule** — to claim the insurance you carry on
  the vehicle.
- **Bank statements (cheque / savings / credit card)** — to back up the expenses
  you're claiming, for the tax year.

---

## Travel allowance — source code 3701

If your IRP5 carries source code **3701**, you receive a travel allowance.
Complete the template and send the supporting documents:

- **Vehicle Detail Sheet** *(complete attached template)* — the template captures
  your logbook, service records and the dates you were away, so we can work out
  your travel claim without a separate logbook.
- **Vehicle purchase agreement** — to establish your vehicle's value for the
  travel claim.
- **Service records** — captured by the Vehicle Detail Sheet.
- **Leave dates** — the dates you were away or not travelling for work, captured
  by the Vehicle Detail Sheet.

---

## Company car (use of motor vehicle fringe benefit) — source code 3802

If your IRP5 carries source code **3802**, your employer provides a company car
and the use of it is taxed as a fringe benefit:

- **Vehicle Detail Sheet** *(complete attached template)* — so we can work out
  the business-use portion of the company car.
- **Fringe-benefit letter from your employer** — confirming the company-car
  fringe benefit and its terms.

(Medical aid, RA and investment certificates for company-car clients come from
the baseline above — they are not repeated here.)

---

## Rental income

If you let out property, send the full rental document set so all your rental
deductions are captured:

- **Lease agreement(s)** — to confirm the rent you charge your tenants.
- **Bank statement showing rent received** — to confirm the rental income you
  received, for the tax year.
- **Bond statement (including bond interest)** — to claim the interest on your
  bond as an expense.
- **Rates & levies** — to claim rates and levies against your rental income.
- **Maintenance & repairs receipts** — to claim the cost of keeping the property
  in shape.
- **Insurance** — to claim the cover you carry on the property.
- **Agency commission paid** — to claim the letting agent's commission.

---

## Foreign income

If you earned income while working outside South Africa, tell us and send:

- **Proof of foreign income for the tax year (payslips / bank statements)** — to
  confirm what you earned abroad for the period 01/03/2025 – 28/02/2026.
- **Passport showing exit and entry stamps** — so we can check the days you spent
  outside South Africa for the foreign-income exemption (you must be outside the
  country for more than 183 days in a 12-month period, 60 of them consecutive,
  with the first R1.25 million of qualifying foreign employment income exempt).

We use the passport stamps and proof of income to assess you for the
foreign-income exemption; we will tell you which documents we need and why, and
your consultant will confirm whether you qualify.
