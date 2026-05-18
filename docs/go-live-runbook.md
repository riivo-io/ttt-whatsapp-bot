# Go-Live Runbook

Step-by-step process for taking the bot from local dev to a production WhatsApp number that's always on. Written to be runnable top to bottom.

_Drafted: 2026-05-05. Verify the decisions in §0 against what we actually agreed yesterday before starting._

---

## How to use this doc

- Work top to bottom. Don't skip phases.
- Each step is either a shell command, a click-path in someone's dashboard, or a verification check.
- **DECISION POINT** boxes flag the spots where the right answer depends on a call we made (or still need to make).
- **VERIFY** boxes are sanity checks. If they fail, stop and fix before moving on.
- Tick the boxes as you go.

---

## §0. Decisions to confirm before you start

Things I want to lock down up front so we don't waste a deploy. These came up (or should have come up) yesterday. If any of these is wrong, fix it here before you touch anything.

### 0.1 Hosting

**DECISION POINT.** Right now [vercel.json](../vercel.json) suggests we're going to Vercel. But [src/server.ts](../src/server.ts) calls `app.listen()`, which is the long-running Node pattern, not the Vercel serverless pattern. As-is the code will not deploy to Vercel cleanly.

Two viable paths:

| Option | What it means | Code change | Cost shape |
|---|---|---|---|
| **A. Vercel serverless** | Wrap Express in a serverless handler at `api/index.ts`. Each request spins up a function (cold start ~300ms first hit, warm after). Cron route is a separate serverless function. | Yes, ~30 lines. See §2.2. | Free tier covers low volume. Pro $20/mo if we cross limits. |
| **B. Railway / Fly.io / Render** | Run the Node process as-is. One always-on container. Cron stays inside the process or moves to the host's scheduler. | None. | $5 to $20/mo for the smallest always-on instance. Predictable. |

My recommendation: **Option B (Railway)** for go-live. Reasons:
- Zero code change, lower risk on cutover.
- The webhook handler does meaningful work (Claude calls, Dynamics writes) and we already ACK Meta with 200 before the work happens, so cold starts on every webhook would add latency for no benefit.
- The `pendingUpload` service holds 10-minute TTL state in memory. Serverless invocations don't share memory between cold starts, which would break the LoE flow. We'd have to move that to Supabase first.

If the call yesterday was Vercel, do §2.2 first and adapt the rest. If Railway / Fly / Render, follow the doc straight.

- [ ] Decision logged: ___________________ (Vercel / Railway / Fly / Render / other)

### 0.2 Production WhatsApp number

- [ ] Production phone number confirmed: ___________________
- [ ] Number is owned by TTT Financial Group's Meta Business account (not a personal account)
- [ ] Number is not currently in use elsewhere (can't be on a personal WhatsApp at the same time)

### 0.3 Production domain

The bot needs an HTTPS URL that Meta will hit. Options:

- `bot.ttt-tax.co.za` (cleanest, looks professional in Meta App settings)
- Default platform domain (e.g. `ttt-bot.up.railway.app` or `ttt-bot.vercel.app`)

- [ ] Production webhook URL: ___________________
- [ ] DNS access confirmed if using a custom subdomain (we'll need to add a CNAME)

### 0.4 Environment isolation

We do **not** want production hitting the dev Supabase or dev Dynamics. Confirm separation:

- [ ] Production Supabase project (separate from dev): ___________________
- [ ] Production Dynamics environment (URL): ___________________
- [ ] Production Anthropic API key (separate from dev for spend tracking): yes / no

### 0.5 Who has access

- [ ] Meta Business Manager admin: ___________________
- [ ] Vercel / Railway / chosen host owner: ___________________
- [ ] Supabase project owner: ___________________
- [ ] Dynamics tenant admin (for App Registration): ___________________
- [ ] Where production secrets live (1Password / Bitwarden / etc.): ___________________

---

## §1. Account inventory and credentials

Before deploying, you need these accounts set up and the right people invited. Walk through and tick.

### 1.1 Meta Business

- [ ] Meta Business Manager account exists for TTT Financial Group
- [ ] WhatsApp Business Account (WABA) created inside the Business Manager
- [ ] Production phone number added to the WABA and verified (SMS or voice code)
- [ ] Display name set, profile picture uploaded, business description filled in
- [ ] Business verification submitted (Meta requires this before lifting the unverified messaging limits)

### 1.2 Meta App (the WhatsApp Cloud API integration)

- [ ] App created at https://developers.facebook.com/apps
- [ ] App type: Business
- [ ] WhatsApp product added to the App
- [ ] App connected to the WABA
- [ ] System User created in Business Manager with full WhatsApp permissions on the WABA
- [ ] Permanent access token generated for the System User (not a temporary user token, those expire in 24h)
- [ ] Token stored in the production secrets vault, not in any text file

**VERIFY.** Run this against the production access token to confirm it works and points at the right phone number ID:

```bash
curl -s "https://graph.facebook.com/v22.0/me?access_token=$META_WHATSAPP_TOKEN" | jq
curl -s "https://graph.facebook.com/v22.0/$META_PHONE_NUMBER_ID?access_token=$META_WHATSAPP_TOKEN" | jq
```

The second call should return the phone number's display details. If it 401s, the token is wrong or expired. If it 404s, the phone number ID is wrong.

### 1.3 Supabase production project

- [ ] Project created in the TTT Supabase organization
- [ ] Region: closest to where the bot host will run (latency matters for every Claude turn)
- [ ] Connection pooling enabled (Supavisor in transaction mode is the default)
- [ ] Service role key copied into the production vault
- [ ] Database password rotated from the auto-generated one and stored

### 1.4 Microsoft Dynamics 365 production tenant

- [ ] Confirmed the production tenant URL (e.g. `https://tttfinancial.crm4.dynamics.com/`)
- [ ] Azure AD App Registration created for the bot (separate from the dev one)
  - In Azure Portal: Azure Active Directory → App registrations → New registration
  - Name: `TTT WhatsApp Bot (prod)`
  - Single tenant, no redirect URI
- [ ] Client secret generated, copied immediately (Azure won't show it again), stored in vault
- [ ] App given Dynamics permissions:
  - In Power Platform Admin Center, add the App as an Application User on the prod environment
  - Assign the security role that grants the bot read/write on contacts, leads, system users, invoices, cases, requests, tasks, annotations, task types, industries
- [ ] `tenant_id`, `client_id`, `client_secret` saved

**VERIFY.** Run this from any machine with the prod creds in env:

```bash
curl -s -X POST "https://login.microsoftonline.com/$DYNAMICS_TENANT_ID/oauth2/v2.0/token" \
  -d "grant_type=client_credentials" \
  -d "client_id=$DYNAMICS_CLIENT_ID" \
  -d "client_secret=$DYNAMICS_CLIENT_SECRET" \
  -d "scope=$DYNAMICS_URL.default" | jq .access_token
```

Should return a JWT. If it returns an error, fix the App Registration before continuing.

### 1.5 Anthropic Claude

- [ ] Production API key generated at https://console.anthropic.com/settings/keys
- [ ] Spend cap set on the production key (recommend $200/month to start, adjust after first week)
- [ ] Workspace separated from dev so you can see prod-only spend on the dashboard
- [ ] Key saved in vault

### 1.6 Mistral OCR

- [ ] Production API key generated at https://console.mistral.ai/api-keys
- [ ] Spend cap set
- [ ] Key saved in vault

---

## §2. Code prep

### 2.1 Branch hygiene

- [ ] All cleanup is committed. Right now `git status` shows tracked-but-deleted files in `convex/` and the renamed `openai.service.ts` to `claude.service.ts`. Land those first.
- [ ] Production deploys from `main` only. No feature branches go live.
- [ ] Branch protection enabled on `main` (require PR, require passing checks).
- [ ] `npm run build` runs clean locally with the prod env file (catches missing env vars early).

### 2.2 Vercel-only step (skip if going Railway / Fly / Render)

If you picked Vercel in §0.1, the Express app needs a serverless wrapper. Add this file:

```ts
// api/index.ts
import { app } from '../src/server';
export default app;
```

And refactor [src/server.ts](../src/server.ts) so it only calls `listen()` when run directly:

```ts
export const app = express();
// ... all the existing route wiring ...

if (require.main === module) {
    app.listen(PORT, () => { /* ... */ });
}
```

Plus: the `pendingUpload` service ([src/services/pendingUpload.service.ts](../src/services/pendingUpload.service.ts)) holds in-memory state that doesn't survive serverless cold starts. Move it to a Supabase table before going live on Vercel, otherwise document uploads will silently fail when the user's "I just sent a doc" message and their next "it's an LoE" reply land on different function instances.

If you picked Railway / Fly / Render, this section doesn't apply, the existing `app.listen()` works as-is.

### 2.3 Health endpoint

The `/health` endpoint already exists. Confirm:

```bash
curl https://your-prod-domain/health
# {"status":"ok","timestamp":"..."}
```

The production host (Railway / Fly / Render / Vercel) should be configured to ping `/health` for uptime checks. We'll wire alerts to this in §10.

### 2.4 SIGNUP_URL is correct

Open [.env.example](../.env.example). Today it shows `SIGNUP_URL=https://app.ttt-tax.co.za/signup`, which is **stale**. The canonical URL is `https://ttt-tax.co.za/client-onboarding`. Fix the example file and confirm production env uses the correct one.

```bash
SIGNUP_URL=https://ttt-tax.co.za/client-onboarding
```

---

## §3. Production Supabase setup

### 3.1 Run migrations

From a machine with `psql` and the production database URL:

```bash
# Set DATABASE_URL to the production connection string from Supabase project settings
psql "$DATABASE_URL" -f supabase/migrations/20260401120000_create_permissions_tables.sql
psql "$DATABASE_URL" -f supabase/migrations/20260401130000_add_role_to_sessions.sql
psql "$DATABASE_URL" -f supabase/migrations/20260413100000_split_lookup_lead_permission.sql
psql "$DATABASE_URL" -f supabase/migrations/20260414100000_pending_loe_data.sql
psql "$DATABASE_URL" -f supabase/migrations/20260417100000_case_lifecycle.sql
psql "$DATABASE_URL" -f supabase/migrations/20260428100000_claude_usage_tracking.sql
```

Or use the Supabase SQL editor and paste each migration in order.

**VERIFY.** Confirm tables exist:

```sql
select table_name from information_schema.tables
where table_schema = 'public'
order by table_name;
```

Expected: `claude_usage`, `crm_audit_log`, `messages`, `pending_loe_data`, `role_tools`, `roles`, `sessions`, `users`, `whatsapp_cases` (plus the `claude_usage_daily` view).

### 3.2 Seed the role permissions

The `roles` table is auto-seeded by the migration with `No Access`, `Some Access`, `Full Access`. Confirm `role_tools` has the right entries for `Full Access`:

```sql
select r.name, count(rt.tool_name) filter (where rt.enabled) as enabled_count
from roles r
left join role_tools rt on rt.role_id = r.id
group by r.name;
```

`Full Access` should show all tools enabled. If it's empty, the seed didn't run, re-apply [supabase/migrations/20260401120000_create_permissions_tables.sql](../supabase/migrations/20260401120000_create_permissions_tables.sql).

### 3.3 Sync staff users from Dynamics

Once Dynamics prod creds are in your local `.env` (temporarily, for this one-shot), run:

```bash
npm run sync:users
```

This pulls `systemuser` rows from production Dynamics and upserts them into Supabase `users`. The sync script never touches `role_id`, so you'll need to assign roles manually:

```sql
-- Find the Full Access role id
select id from roles where name = 'Full Access';

-- Assign Full Access to a staff user by email
update users
set role_id = (select id from roles where name = 'Full Access')
where dynamics_email = 'luc@riivo.io';

-- Repeat for each staff member who should have access on day one
```

- [ ] `users` table populated
- [ ] At least one Full Access user assigned (so a staff smoke test works)
- [ ] All other users either get a non-empty role or stay on No Access

### 3.4 Wipe dev artefacts

If by accident you ran any local tests against this prod project, clean up before opening the gate:

```sql
delete from claude_usage;
delete from messages;
delete from whatsapp_cases;
delete from pending_loe_data;
delete from crm_audit_log;
delete from sessions;
```

(Don't run this against a project you've been using, obviously. Only run it on the freshly created prod project to make sure it's pristine.)

---

## §4. Choose host, set env vars, first deploy

This section covers Railway since that's my recommendation. If you went Vercel or Fly, the steps are analogous but the dashboard click-paths differ.

### 4.1 Railway project

- [ ] Create a new Railway project from GitHub: connect the repo, select the `main` branch
- [ ] Service auto-detects Node. Confirm:
  - Build command: `npm run build`
  - Start command: `npm start`
  - Healthcheck path: `/health`
  - Healthcheck timeout: 30s
- [ ] Add environment variables (Service settings → Variables). Paste each from §1's saved values:

```
DYNAMICS_URL
DYNAMICS_TENANT_ID
DYNAMICS_CLIENT_ID
DYNAMICS_CLIENT_SECRET
META_WHATSAPP_TOKEN
META_PHONE_NUMBER_ID
META_VERIFY_TOKEN          # any random string, you set this, Meta echoes it back
META_APP_SECRET
WHATSAPP_SIGNUP_FLOW_ID    # leave empty until §6.4
ANTHROPIC_API_KEY
MISTRAL_API_KEY
MISTRAL_OCR_MODEL=mistral-ocr-latest
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SIGNUP_URL=https://ttt-tax.co.za/client-onboarding
CRON_SECRET                # any random string, used to protect /api/cron
PORT=3001                  # Railway sets this for you, included for completeness
NODE_ENV=production
```

- [ ] Generate a `CRON_SECRET` with `openssl rand -hex 32` and save it.
- [ ] Generate a `META_VERIFY_TOKEN` with `openssl rand -hex 16` and save it. (You'll paste this in Meta's webhook config in §6.)

### 4.2 Custom domain

- [ ] In Railway service settings → Networking → Custom Domains, add `bot.ttt-tax.co.za` (or whatever you decided in §0.3)
- [ ] Add the CNAME record to TTT's DNS pointing at the value Railway gives you
- [ ] Wait for DNS to propagate (5 to 30 minutes), Railway auto-provisions SSL via Let's Encrypt

**VERIFY.** Once the certificate is live:

```bash
curl https://bot.ttt-tax.co.za/health
# {"status":"ok","timestamp":"..."}
```

### 4.3 First deploy

- [ ] Push to `main`, Railway auto-deploys
- [ ] Watch the build log for errors
- [ ] Once deployed, watch the runtime log: should print `🚀 TTT WhatsApp Tax Bot server running on port 3001`

**VERIFY.** No exceptions in the log. If you see "Supabase service throws on import if missing", an env var is wrong. Fix and re-deploy.

### 4.4 Cron job

The current `vercel.json` cron only fires on Vercel. On Railway, set it up at the host level:

- [ ] Railway → service → Cron jobs → New cron
- [ ] Schedule: `0 2 * * *` (daily, 02:00 UTC, same as `vercel.json`)
- [ ] Command: `curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://bot.ttt-tax.co.za/api/cron/case-timeout`

(Or, if Railway's cron-as-curl pattern feels fragile, use a 3rd-party uptime cron like cron-job.org pointing at the same URL with the same Authorization header.)

**VERIFY.** Manually fire the cron once:

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://bot.ttt-tax.co.za/api/cron/case-timeout
```

Expected: 200 with a JSON body like `{"swept": 0, "ok": true}` (the count is whatever was cleanable today).

---

## §5. Production Meta WhatsApp setup

### 5.1 Webhook URL configuration

- [ ] Go to your Meta App → WhatsApp → Configuration → Webhook
- [ ] Callback URL: `https://bot.ttt-tax.co.za/webhook` (or whatever your prod URL is)
- [ ] Verify token: paste the `META_VERIFY_TOKEN` you generated in §4.1
- [ ] Click Verify and Save. Meta sends a GET to your webhook with the verify token, your bot echoes the challenge back. If this fails, the bot isn't reachable, env var is wrong, or both.

**VERIFY.** Watch the Railway log. You should see one GET to `/webhook` from Meta and a 200 response.

### 5.2 Subscribe to webhook fields

- [ ] In the same WhatsApp Configuration page, click Manage on the WABA subscription
- [ ] Subscribe to: `messages` (required), `message_template_status_update` (nice-to-have), `account_alerts` (nice-to-have)
- [ ] Save

### 5.3 Add the production phone number

- [ ] WhatsApp → API Setup → select the production phone number from the dropdown
- [ ] Copy the **Phone Number ID** to the Railway env var `META_PHONE_NUMBER_ID`
- [ ] Re-deploy if the env var changed

### 5.4 (Optional) Sign-up Flow

If we're shipping the WhatsApp Flow sign-up form on day one (per [whatsapp-flow-signup.md](./whatsapp-flow-signup.md)):

- [ ] Publish the Flow in Meta Flow Manager (production environment, not draft)
- [ ] Copy the Flow ID into the Railway env var `WHATSAPP_SIGNUP_FLOW_ID`
- [ ] Re-deploy

If we're skipping the Flow on day one, leave `WHATSAPP_SIGNUP_FLOW_ID` blank. Unknown numbers will get the plain-link fallback, which is also acceptable.

### 5.5 Approved message templates

WhatsApp requires templates for any business-initiated message (the bot replying within the 24-hour service window doesn't need this, but if we want to send proactive nudges we will). Confirm:

- [ ] Templates from [meta-templates.md](./meta-templates.md) submitted and approved
- [ ] Template names in the bot code match the approved names exactly (Meta is case-sensitive on these)

---

## §6. Smoke tests

Don't skip these. Each one catches a specific class of failure.

### 6.1 Inbound from a known client

Pick a client phone number that exists in production Dynamics. Send a message from that phone to the production WhatsApp number.

- [ ] Bot replies within ~10 seconds
- [ ] First message gets the welcome menu (interactive list with two sections)
- [ ] Reply mentions the client's first name
- [ ] In Dynamics, on that contact's record, the WhatsApp comms thread shows both the inbound and outbound messages

If anything fails here, check the Railway log. Most common cause: `META_PHONE_NUMBER_ID` mismatch (you'll see "phone number not found" or similar in the Meta API error response).

### 6.2 Inbound from a staff phone

Pick a staff phone number that you assigned `Full Access` to in §3.3.

- [ ] Send "show me my clients"
- [ ] Bot lists the staff member's clients (using their Dynamics ownership)
- [ ] Send "search for client John"
- [ ] Bot returns matching clients

### 6.3 Inbound from a permission-restricted staff phone

If you have a staff member with the `Some Access` role:

- [ ] Send "create a lead for Jane Doe"
- [ ] Bot politely declines, mentions the user doesn't have that permission

### 6.4 Inbound from an unknown number

Use a personal phone that isn't in Dynamics or the staff table.

- [ ] Bot sends either the sign-up Flow or the plain-link sign-up message
- [ ] Tap through the Flow (if enabled), submit the form
- [ ] In production Dynamics → Leads, a new lead appears with the submitted details

### 6.5 Document upload (LoE flow)

This is the most fragile workflow, test it end-to-end with a real signed LoE PDF.

- [ ] Staff sends "I want to upload an LoE" from their phone
- [ ] Send a signed LoE PDF in the same chat
- [ ] Bot asks which lead it's for, staff replies with the lead's name
- [ ] Bot OCRs, extracts fields, replies with the extracted values for review
- [ ] Staff confirms ("yes")
- [ ] In production Dynamics → Lead → the LoE fields are PATCHed, the PDF is attached as an annotation, `riivo_loereceived = true`

If OCR fails: check Mistral spend cap. If extraction returns wrong fields: that's an LLM issue, not an infra one. If the Dynamics PATCH fails: check the App Registration permissions in §1.4.

### 6.6 Cron sanity

Manually fire the timeout sweep one more time and watch the log:

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://bot.ttt-tax.co.za/api/cron/case-timeout
```

- [ ] Returns 200
- [ ] Log shows `[Cron] swept N cases` with N = 0 (no stale cases to clean yet)

### 6.7 Out-of-scope smoke

Send "what's the recipe for boerewors" to test the scope guardrail.

- [ ] Bot redirects with a single warm line, doesn't actually answer

---

## §7. Going live (cutover)

If §6 all passed, you're cleared to go live. The cutover itself is just flipping who knows about the production phone number.

### 7.1 Pre-cutover checks

- [ ] All of §6 passed in the last hour (don't trust tests from yesterday)
- [ ] No deploys in flight, no PRs you're about to merge
- [ ] The on-call person knows we're going live and is at their desk

### 7.2 Announce internally

- [ ] Send a Slack/Teams note to TTT consultants: "WhatsApp bot is now live on {production number}, please send a test message to confirm you're routed correctly"
- [ ] Track who replies, follow up with anyone who reports issues

### 7.3 Public-facing rollout

This part depends on TTT's marketing schedule, not the engineering side. Coordinate with whoever owns the website and the email signature:

- [ ] WhatsApp number on `ttt-tax.co.za` updated
- [ ] WhatsApp number on email signatures updated
- [ ] Any "click to chat" links updated (`https://wa.me/{prod-number}`)

### 7.4 First-hour watch

Stay on the Railway log for the first hour. Watch for:

- [ ] Repeated 5xx replies to Meta (means the webhook is throwing)
- [ ] Anthropic 429s (rate limit, raise the spend cap or batch differently)
- [ ] Dynamics 401s (token expired, check MSAL refresh logic)
- [ ] Supabase connection errors (connection pool exhausted, raise the limit)

If any of these spike, jump to §9 (rollback) and triage.

---

## §8. Monitoring and keeping it up

The bot needs to stay up without someone watching it constantly. Here's the minimum:

### 8.1 Uptime monitoring

- [ ] External uptime check on `https://bot.ttt-tax.co.za/health` every 60 seconds
- [ ] Tools that work: BetterStack, UptimeRobot (free tier), Cronitor
- [ ] Alert channel: Slack `#bot-alerts` plus an SMS to the on-call person if it stays down for >5 minutes

### 8.2 Log retention

Railway keeps logs for 7 days on the free plan, longer on paid. For now that's fine. If we need longer retention later:

- [ ] Pipe logs to a destination (Better Stack Logs, Axiom, etc.)
- [ ] Retain at least 30 days for debugging customer complaints

### 8.3 Spend monitoring

Three places to watch:

- [ ] Anthropic dashboard: daily spend, set an alert at 80% of monthly cap
- [ ] Mistral dashboard: same
- [ ] Supabase: per-call cost is logged on every `claude_usage` row. Use the daily view for a quick at-a-glance check:

```sql
select day, sum(cost_usd) as usd, sum(call_count) as calls
from claude_usage_daily
where day >= current_date - interval '7 days'
group by day order by day desc;
```

Set up a weekly review of this query. If costs creep, the conversation caps in [usage-tracking-and-caps.md](./usage-tracking-and-caps.md) are the lever to tune.

### 8.4 Conversation cap signals

A spike in `cap_blocked_at` set on sessions is a signal someone is hitting limits. Could mean abuse, could mean caps are too tight for legitimate use:

```sql
select date_trunc('day', cap_blocked_at) as day, count(*) as blocked
from sessions
where cap_blocked_at is not null
  and cap_blocked_at >= current_date - interval '14 days'
group by 1 order by 1 desc;
```

### 8.5 Case lifecycle metrics (Q2)

The whole point of the case lifecycle is reporting. Run weekly:

```sql
select status, count(*) as cases
from whatsapp_cases
where created_at >= current_date - interval '7 days'
group by status order by status;
```

L1 auto-resolution rate = `(resolved_by_bot + resolved_by_bot_timeout) / total`.

---

## §9. Rollback

If go-live goes wrong, get back to a working state quickly.

### 9.1 Bot is broken (5xx, no replies)

- [ ] Railway → Deployments → previous deploy → Redeploy
- [ ] Or: revert the bad commit on `main`, push, Railway auto-deploys the revert

The webhook URL stays the same, Meta keeps retrying inbound messages for ~24h, so messages sent during the outage will replay once the bot is back. The bot is idempotent on most paths (the case lifecycle creates one row per qualifying message) so replays should not double-write.

### 9.2 Bot is sending wrong replies

This is harder than a 5xx because Meta has already delivered the wrong message. Steps:

- [ ] Roll back the deploy as above
- [ ] If the bad message went to many users: send a follow-up correction template (requires an approved template, see §5.5)
- [ ] If only a few users: the on-call consultant DMs them on WhatsApp directly to clarify

### 9.3 Total disable (kill switch)

If something is so wrong we want the bot to stop replying entirely while we fix it:

- [ ] Railway → service → pause (stops the container, requests will start failing)
- [ ] Meta will retry for 24h, so anything sent during the pause queues up. Be prepared for a flood of replays when you un-pause.
- [ ] Alternative: in Meta App → WhatsApp → Configuration → Webhook, click "delete" on the callback URL. Meta stops delivering inbound webhooks but you don't lose anything; users see no reply but the bot doesn't error either.

### 9.4 Credentials compromise

If a token leaks (committed to git, posted in a screenshot, etc.):

- [ ] Meta: revoke the System User token, generate a new one, update Railway env, redeploy
- [ ] Anthropic: rotate the API key, update Railway env, redeploy
- [ ] Mistral: same
- [ ] Dynamics: rotate the App Registration client secret, update Railway env, redeploy
- [ ] Supabase: rotate the service role key, update Railway env, redeploy

Token rotation is non-breaking as long as the env update and redeploy happen quickly. Aim for under 5 minutes between rotation and redeploy.

---

## §10. Ongoing maintenance

Things that need doing on a recurring basis to keep the bot healthy.

| Frequency | Task | Owner |
|---|---|---|
| Daily | Glance at Railway log for errors. Cron should fire at 02:00 UTC, confirm one entry. | On-call |
| Weekly | Run the spend query in §8.3 and the cases query in §8.5. | TBD |
| Weekly | Run `npm run sync:users` if any staff joined/left. The script never overwrites `role_id` so existing roles are safe. | TBD |
| Monthly | Review and rotate `META_VERIFY_TOKEN` and `CRON_SECRET`. Both are bot-internal. | TBD |
| Monthly | Confirm Anthropic/Mistral spend caps still match expected volume. Raise if hitting them. | TBD |
| Quarterly | Rotate Dynamics App Registration secret (Azure expires them after 24 months by default, do it sooner). | TBD |
| As needed | When Anthropic ships a new Opus model, swap `CLAUDE_MODEL` in [src/services/claude.service.ts](../src/services/claude.service.ts) and update the pricing table in [src/services/claudePricing.service.ts](../src/services/claudePricing.service.ts). | Eng |

---

## §11. What this doc doesn't cover

- **Disaster recovery for Supabase data.** Supabase has automated backups on paid plans. If you're on the free plan for prod, fix that before §3.
- **Multi-region.** We're single-region. If South Africa needs lower-latency access, that's a separate project.
- **Compliance and POPIA.** Conversation history is stored in Supabase (which is on AWS US/EU regions depending on what you picked) and message threads in Dynamics. If POPIA or any DPA needs the data in-country, we have to revisit hosting.
- **Load testing.** Meta delivers webhooks serially per-phone-number, so we don't have a fanout problem. But if you want to confirm the bot handles a Black Friday-style burst, that's a separate exercise.

---

## §12. Sign-off

Once §0 through §7 are all ticked, fill this in:

- [ ] Go-live date: ___________________
- [ ] Cutover performed by: ___________________
- [ ] Smoke tests verified by: ___________________
- [ ] On-call for first 48h: ___________________
- [ ] Issues observed: ___________________
- [ ] Notes for next time: ___________________
