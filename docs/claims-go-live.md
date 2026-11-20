# Claims go live

Real clients get the form-based claims flow that the demo numbers have: the kind of claim, the policy, the form link,
signing on the form, the morning reminders, STOP, the missing-items form. It runs against Tina's own CRM.
The October chat walkthrough (`claimsHost.ts`) is retired as soon as live mode is on.

Merging this code changes nothing: everything is off until `CLAIMS_LIVE=on`.

## Settings (ttt-prod-bot AND ttt-prod-bot-worker)

| Setting | Value at go-live | What it does |
|---|---|---|
| `CLAIMS_LIVE` | `on` | Live mode. Anything else: off. |
| `CLAIMS_DATAVERSE_URL` | `https://ttt-financial-group2.crm4.dynamics.com` | The claims CRM. Live mode refuses to run unless it equals `DYNAMICS_URL`, so a real claim can never land in DEV. |
| `CLAIMS_SHAREPOINT_SITE` | `tttfinancialgroup.sharepoint.com:/sites/TTTProduction` | The site with the client folders (`Contact` library / client / Claims / CLM-…). |
| `SERVICE_ROUTING_ENABLED` | `true` | Required. Routing decides tax or insurance; only an insurance claim reaches the form flow. |
| `SERVICE_ROUTING_NUMBERS`, `CLAIMS_LIVE_NUMBERS` | our phones, then pilot clients, then empty | Soft launch. Empty means everyone. |
| `ROADSIDE_ENABLED` | `false` | Until TTT gives the assist numbers. |
| `CLAIMS_DEMO_NUMBERS` | PROD test contacts, or empty | Demo numbers now run against the same (PROD) CRM. |
| `CLAIMS_ENABLED` | leave unset | Not used in live mode. |

## How a live client's message is handled

1. A demo number: the demo flow, as before.
2. A live client with a claim conversation in progress (the last 14 days: a walkthrough, the form, a list or reminder
   they're answering): the claims flow first, files and voice notes too. A message that isn't about the claim is let go.
3. Everything else: service routing. An insurance claim (claim words, the claim link, the Report a claim tap) goes to
   the claims flow on the number's insurance contact; anything else gets the broker hand-over, or the tax path.
4. Numbers not yet live (outside `CLAIMS_LIVE_NUMBERS`) with routing on: a claim is handed to the broker. With routing
   off: Tina's tax path, as today.
5. Unknown numbers reporting a claim: the unknown-number reply (sign-up link). No claim opens.

The 08:00 reminder runs for the demo numbers and every live client with a claim conversation.

## Switch-over

Before pointing the CRM at PROD, delete the rows in Supabase `claim_conversations`. They hold DEV contact ids from
the demo testers. The full runbook is in the TTT workspace: `handovers/go-live-prod-1120/README.md`.
