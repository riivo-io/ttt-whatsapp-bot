# Unknown numbers: test steps (TTTFG-5340)

How to test, by acceptance criterion, that Tina treats a WhatsApp number on no contact and no lead the way SPEC-05 says. The
design is in [leads-and-contacts.md](leads-and-contacts.md) ("Unknown numbers"); the code is `src/domain/unknownNumber.ts`.

## Before you start

1. **Apply the migration** `supabase/migrations/20261118120000_unknown_number_replies.sql` to the Supabase of the environment you
   test on, *before* Tina with this change runs there. Without the table an unknown number is not answered at all (the claim fails
   and the worker retries), and an existing lead's message only logs a warning.
2. Tina with this change is deployed to that environment. `TAX_SIGNUP_LINK` is optional; the default is
   `https://www.ttt-tax.co.za/client-onboarding`.
3. A WhatsApp number that is **on no contact and no lead** in that environment's CRM (search `Mobile Phone` on Contacts and
   Leads in every format: `082…`, `+2782…`, `2782…`). A second such number is handy for the roadside and claim checks.
4. To see what the CRM did, open **Leads** (owner: the Tax team) and **My Day** for a Tax user, or run
   `npx tsx src/scripts/unknown-number-dev.ts --show <number>` against DEV.

## The steps

| # | Do | Expect |
|---|---|---|
| **AC 1, 2** | From the new number send: *Hi, I'm Jane Smith, ID 8001015009087, where is my refund?* | One reply only: *I can't find this number on our system. If you're already a TTT client, please email us from the address we have on file. If you're new, you can sign up here: https://www.ttt-tax.co.za/client-onboarding*. No answer about the refund, no question, no ID number asked for. |
| **AC 3** | In the CRM, search Contacts for ID number `8001015009087` (or any real client's) | No contact has this number as its mobile; no contact was changed. Tina has no tool that looks a client up by ID number. |
| **AC 4** | Send *Hi* from a second new number | The same one reply. No name, ID number or "create your profile" questions. |
| **AC 5** | Open **Leads** and filter on the number | **One** lead: name `WhatsApp <number>`, lead type **Tax**, lead source WhatsApp, owner **Tax** team. In **My Day** (Tax): one open agent action, Kind **Created**, *New lead from WhatsApp <number>*. |
| **AC 6** | Send another message from the same number straight away, and a third a minute later | No reply, and still one lead and one action. (After 24 hours the number is answered once more, with no second lead.) |
| **AC 5** | From that same number send a real referral code (`TTT-<code>`) to get the referral message, and submit its sign-up form | The form **updates** the lead (name, email, notes). Still one lead. With an email on it, the number is an ordinary lead and Tina serves it as one. The online sign-up page does the same on the LOE app's side only once it matches on phone number (TTTFG-5581). |
| **AC 7** | From a third new number send *My car broke down on the N1* (roadside switched on, `ROADSIDE_ENABLED=true`) | Tina asks which insurer, then gives that insurer's assist number. **No** sign-up reply and **no** lead for this number. |
| **AC 8** | Message from a known client's number, and from an existing lead's number | Served exactly as before: the client menu and answers, the lead's normal replies. |

## Clean up

Delete the test leads and their agent actions (DEV). The script does it for its own test number:
`npx tsx src/scripts/unknown-number-dev.ts --clean 27600053400`. In DEV, the reply table row for your number can be deleted in
Supabase (`delete from unknown_number_replies where phone_number = '<number>'`) to start a number again.

## What the DEV script proves, and what it does not

`npx tsx src/scripts/unknown-number-dev.ts --run` runs the real domain code against the real TTT DEV Dataverse with WhatsApp
faked and the reply table in memory. It proves the lead and the Created action are accepted, owned by the Tax team, and that one
lead remains after the sign-up form. It signs in as a DEV user, so it does **not** prove Tina's application user has the rights
to create them, that Meta delivers the reply, or that the Supabase migration is right. The real-phone steps above do.
