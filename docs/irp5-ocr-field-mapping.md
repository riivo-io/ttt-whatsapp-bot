# IRP5 OCR → `riivo_irp5s` field mapping

Source-of-truth for the IRP5 OCR pipeline. Tina will:

1. Receive the IRP5 PDF on WhatsApp.
2. OCR it with Mistral (existing service).
3. Pass the OCR markdown to Claude with a tool-use schema matching this table to extract structured fields.
4. Write the extracted fields onto a new `riivo_irp5s` row, linked to the contact via `riivo_Client@odata.bind`.
5. Use the extracted source codes to drive the follow-up "what other docs do we need" advice via [src/services/requiredDocuments.service.ts](../src/services/requiredDocuments.service.ts).

**Priority cases:** TTT's bread-and-butter is **commission earners (code 3606)** and standard salaried employees (3601). Travel allowances (3701) and company cars (3802) frequently co-occur with commission. v1 must get these rock-solid; everything else is best-effort.

Lower-volume codes are still extracted (so the source-code list passed to the advice engine is complete), but ambiguous `riivo_irp5s` fields are left null rather than guessed. We can fill them in later once we see real volume.

---

## 1. Header / identity fields

These are populated from the IRP5 header section, not from a source-code line.

| `riivo_irp5s` field | IRP5 source | Notes |
|---|---|---|
| `riivo_Client` (lookup) | — | Set from the contact resolved by the inbound phone number, not from OCR. |
| `riivo_certificatenumber` | "Certificate Number" | Unique per IRP5 — useful for dedupe. |
| `riivo_name` | Employer trading name | Treat as display label; populate with the employer trading name as printed on the cert. |
| `riivo_employertradingothername` | Employer "Trading or Other Name" | |
| `riivo_idnumber` | Employee ID number | |
| `riivo_dateofbirth` | Employee DOB | |
| `riivo_incometaxrefno` | Employee Income Tax Ref No. | |
| `riivo_citytown` | Employer address — City/Town | |
| `riivo_suburbdistrict` | Employer address — Suburb/District | |
| `riivo_irp5type` | "Type of Certificate" | Populate with same value as `riivo_typeofcertificate` for now. If one turns out to be an optionset, we'll split later. |
| `riivo_typeofcertificate` | "Type of Certificate" | `IRP5` / `IT3(a)` / etc. |
| `riivo_reconciliationperiod` | Reconciliation period code | e.g. `02` (Aug interim) or `08` (Feb final). |
| `riivo_assessmentyearint` | Year of assessment | Integer — e.g. `2026` for 1 Mar 2025 – 28 Feb 2026. |
| `riivo_assessmentyearstring` | Year of assessment | Same value as a string. |
| `riivo_year` / `riivo_transactionyear` / `riivo_transactionyearstring` | — | Leave null in v1. Not present on most IRP5s. |
| `riivo_taxperiodstartdate` | "Period of Reconciliation: From" | |
| `riivo_taxperiodenddate` | "Period of Reconciliation: To" | |
| `riivo_noofperiodsworked` | "Number of Periods Worked" | |
| `riivo_reasonfornondeductionoftax` | Code **4150** | Reason code for no PAYE. |
| `riivo_filename` | — | Set from the uploaded PDF filename, not OCR. |

---

## 2. Income / remuneration source codes → amount fields

These are the SARS 3xxx-series codes that drive both (a) the `riivo_irp5s` financial fields and (b) the source-code list passed to `requiredDocuments.service.ts`.

| SARS code | Description | `riivo_irp5s` field | Notes |
|---|---|---|---|
| **3601** | Income (basic salary) — *priority* | `riivo_incomepaye` | Most common code. |
| **3605** | Annual payment (e.g. 13th cheque) | `riivo_annualpaymentpaye` | |
| **3606** | Commission — **TTT priority** | `riivo_commissionpaye` | Highest-value case. Must always be extracted, always triggers downstream advice. |
| **3615** | Director's remuneration | `riivo_incomepaye` | Rolled into main income field for v1; rare enough that a dedicated field isn't worth it yet. |
| **3701** | Travel allowance (taxable) — *priority* | `riivo_taxabletravelremuneration` | Common alongside 3606. |
| **3702** | Reimbursive travel allowance (taxable portion) | `riivo_reimbursedtravelallowance` | Sum 3702 + 3703 into this field. |
| **3703** | Reimbursive travel allowance (non-taxable portion) | `riivo_reimbursedtravelallowance` | See 3702. |
| **3704** | Subsistence allowance (local) | `riivo_nontaxablesubsistenceallowance` | |
| **3713** | Other allowances | `riivo_otherallowancespaye` | |
| **3715** | Subsistence allowance (foreign) | `riivo_nontaxablesubsistenceallowance` | Sum with 3704. |
| **3721** | Employee debt benefit | `riivo_employeedebt` | |
| **3801** | General taxable benefit | `riivo_generalbenefits` | |
| **3802 / 3816** | Use of motor vehicle (fringe benefit) — *priority* | `riivo_useofmotorvehiclepaye` | Common with commission earners. |
| **3810** | Medical aid contribution (employer paid for employee) | `riivo_medicalaidemployercontributions` | Code 4474 (deduction side) carries the same value; we use 3810. |
| **3817** | Employer pension fund fringe benefit | `riivo_employerpensioncontributionpaye` | |
| **3825** | Employer provident fund fringe benefit | `riivo_employerprovidentfundcontributions` | |
| **Other 38xx** | Generic taxable fringe benefits not listed above | `riivo_generalfringebenefitspaye` | |
| **3907 / 3908 / 3915 / 3920 / 3921 / 3922** | Lump-sum payments | `riivo_payeonlumpsumbenefit` | Sum all lump-sum codes into this field. |
| **Gross income (sum of taxable codes)** | — | `riivo_grosstaxableincome` | |
| **Gross income (sum of non-taxable codes)** | — | `riivo_grossnontaxableincome` | |
| **`riivo_incomeexcl`** | — | *(leave null in v1)* | Field meaning unclear; revisit when we have a real cert that populates it. |

---

## 3. Deductions / contributions source codes → fields

| SARS code | Description | `riivo_irp5s` field | Notes |
|---|---|---|---|
| **4001** | Total pension fund contributions (employee) | `riivo_totalpensionfundcontributions` | |
| **4003** | Total provident fund contributions (employee) | `riivo_totalprovidentfundcontributions` | |
| **4005** | Medical aid contributions (employee, deductible) | `riivo_medicalaidcontributions` | |
| **4006** | Retirement Annuity contributions | `riivo_racontributions` | |
| **4030** | Arrear provident fund contributions | `riivo_currentarrearprovidentfundcontributions` | |
| **4102** | PAYE — *priority* | `riivo_payeamount` | |
| **4116** | Medical scheme tax credit | `riivo_medicalschemetaxcredit` | |
| **4141** | UIF contribution (employee) | `riivo_uifcontribution` | |
| **4142** | SDL contribution (employer) | `riivo_sdlcontribution` | |
| **4149** | Total tax + SDL + UIF | `riivo_totaltaxsdlanduif` | |
| **4474** | Employer medical aid contribution | — | Same value as code 3810; we populate it via 3810 only. |
| **4584** | Bargaining council contribution | `riivo_bargainingcouncilcontributionpaye` | |
| **Total deductions / contributions** | — | `riivo_totaldeductionscontributions` | |
| **`riivo_medicalaidpaye`** | — | *(leave null in v1)* | Field meaning unclear; revisit when needed. |
| **`riivo_providentfundcontributionpaye`** | — | *(leave null in v1)* | Field meaning unclear; revisit when needed. |

---

## 4. Banking fields (deliberately NOT populated from IRP5)

`riivo_accountholder`, `riivo_accountnumber`, `riivo_bankname`, `riivo_branchcode`, `riivo_branchname` — these come from the LoE banking details flow ([src/services/loe-extractor.service.ts](../src/services/loe-extractor.service.ts)), not the IRP5. We leave them untouched when writing IRP5 records.

---

## 5. Source codes used for advice but not stored on `riivo_irp5s`

Codes that don't have a dedicated field on `riivo_irp5s` but **do** trigger extra-doc asks in [src/services/requiredDocuments.service.ts](../src/services/requiredDocuments.service.ts):

- `3696`, `3697` — currently empty in the doc map but kept for completeness.

These get captured in a `sourceCodes: string[]` field on the extraction output that is **passed to the advice engine** but **not written to Dynamics**. (If we ever want them in CRM, we'd add a new field — out of scope for v1.)

---

## 6. Confidence (out of scope for v1)

`riivo_confidence` will not be populated in v1. If we later want it, we can derive it from per-field extraction confidence in the Claude tool-use response.

---

## 7. Commission-earner flow (TTT priority case)

Because most TTT revenue comes from commission earners, the flow for `3606` deserves an explicit walkthrough:

1. Tina extracts source codes from the IRP5; `3606` appears in the list.
2. The advice engine ([src/services/requiredDocuments.service.ts:62](../src/services/requiredDocuments.service.ts#L62)) returns:
   - Logbook (for business travel claim)
   - Till slips / receipts (for any expenses you want to claim)
3. Tina subtracts anything already in `riivo_taxsubmissiondocuments` and asks for the rest, one document at a time.

If the IRP5 also shows `3701` or `3802`, the travel-allowance docs (logbook, lease, fuel slips) get unioned in automatically.

The current advice map for `3606` is light. After v1 ships, we should revisit it with the tax team — commission earners typically also claim home-office, communications, and stationery. Out of scope for this PR.
