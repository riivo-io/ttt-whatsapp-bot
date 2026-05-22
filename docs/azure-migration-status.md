# Azure migration: status & next steps

Snapshot of where the Railway + Upstash → Azure App Service + Service Bus migration sits as of 2026-05-21. Reads top-to-bottom — section 1 is everything that's been built and validated, section 2 is everything that's left.

**Sister document:** [azure-migration.md](azure-migration.md) is the technical spec — architecture decisions, code-change recipes, gotchas. Read this doc for status; read that one for "how do I actually do the rewrite."

---

## 1. What's done

### 1.1 Azure resources provisioned

All resources live in resource group **`ttt-prod-wa-bot`** in **South Africa North** (Johannesburg). Same-region traffic between them is free and sub-10ms.

| Resource | Name | SKU / config | Purpose |
|---|---|---|---|
| Service Bus namespace | `ttt-prod-serv-bus` | Standard, zone-redundant | Queue layer replacing BullMQ + Upstash |
| Service Bus queue | `whatsapp-inbound` | Sessions ON, dup-detect 10m, TTL 1d, lock 5m, max delivery 5 | All inbound WhatsApp messages |
| Service Bus queue | `feedback-prompt` | No sessions, dup-detect 10m, TTL 2d, lock 5m, max delivery 5 | Delayed L1 feedback prompts |
| Key Vault | `ttt-prod-kv` | Standard, RBAC permission model, purge protection ON | Holds all secrets |
| App Service Plan | `ttt-prod-plan` | Basic B2 Linux (2 vCPU, 3.5 GB) | Shared compute for both apps |
| Web App (web) | `ttt-prod-bot` | Node 22 LTS, Always On, system-assigned identity | Webhook ingester (`server.ts`) |
| Web App (worker) | `ttt-prod-bot-worker` | Node 22 LTS, Always On, startup `node dist/worker.js`, system-assigned identity | Queue consumer (`worker.ts`) |
| Application Insights | `ttt-prod-ai` | Pay-as-you-go, free tier covers current volume | Logs + traces from both apps |
| Log Analytics workspace | `DefaultWorkspace-…-JNB` | Auto-created, regional default | Backs Application Insights |

### 1.2 Secrets stored in Key Vault

All secrets from `.env` migrated. Names use dashes (Key Vault constraint), App Service env vars use underscores via reference resolution.

- `SERVICE-BUS-CONNECTION-STRING` (the most important — wires the bot to the new queue)
- `META-WHATSAPP-TOKEN`, `META-VERIFY-TOKEN`, `META-APP-SECRET`, `META-PHONE-NUMBER-ID`
- `ANTHROPIC-API-KEY`, `OPENAI-API-KEY`, `MISTRAL-API-KEY`
- `DYNAMICS-CLIENT-SECRET`, `GRAPH-CLIENT-SECRET`
- `SUPABASE-SERVICE-ROLE-KEY`
- `LOE-SIGNING-SECRET`, `CRON-SECRET`

### 1.3 Access wiring

- Both App Services have **system-assigned managed identity** enabled.
- Both identities granted **Key Vault Secrets User** role on `ttt-prod-kv`.
- App Service env vars use `@Microsoft.KeyVault(...)` references — no secrets in plain App Settings, no rotation burden.
- Subscription-level: `riivo@ttt-tax.co.za` is Owner on the subscription. Root-scope User Access Administrator was removed (was a leftover from the initial elevation).

### 1.4 CI/CD pipeline

- GitHub Actions service principal `ttt-github-actions` created, scoped to `ttt-prod-wa-bot` resource group (Contributor).
- Service principal JSON stored as `AZURE_CREDENTIALS` repo secret in `riivo-io/ttt-whatsapp-bot`.
- `AZURE_WEBAPP_NAME=ttt-prod-bot` and `AZURE_WORKER_APP_NAME=ttt-prod-bot-worker` set as repo variables.
- Workflow file: [.github/workflows/deploy.yml](../.github/workflows/deploy.yml)
    - Trigger: push to `main` or manual `workflow_dispatch`.
    - Jobs: `build` → `deploy-web` + `deploy-worker` (latter two parallel).
    - Build artifact: zip of `dist/ + node_modules/ + package.json + package-lock.json` after `npm prune --production`.
    - Total runtime: ~2m 14s (verified on first run).

### 1.5 Pipeline validation

First push to `main` (commit `724dceb`) was a **deliberate fail-test**:

- ✅ Build succeeded.
- ✅ Both deploys succeeded.
- ✅ App Service ran the deployed code.
- ❌ Both apps crash-looped on missing `REDIS_URL` — which is the *expected* failure, because the code is still on BullMQ and the env var was intentionally not migrated.

This proves the deploy pipeline works end-to-end without needing real working code. The crash is removed by the rewrite below.

---

## 2. What's left

### 2.1 Engineering work: BullMQ → @azure/service-bus rewrite

**This is the bulk of the remaining work.** Full technical spec is in [azure-migration.md](azure-migration.md). Summary of the changes:

**Dependencies:** Remove `bullmq`, `ioredis`. Add `@azure/service-bus`.

**Files to rewrite:**
- [src/queue/connection.ts](../src/queue/connection.ts) — replace Redis factory with a `ServiceBusClient` singleton.
- [src/queue/whatsappQueue.ts](../src/queue/whatsappQueue.ts) — delete shard logic (`getNumShards`, `shardFor`, `shardQueueName`). Replace with one sender that sets `sessionId = phone` and `messageId = metaMessageId`.
- [src/queue/feedbackPromptQueue.ts](../src/queue/feedbackPromptQueue.ts) — straight transport swap, no sessions.
- [src/workers/whatsappWorker.ts](../src/workers/whatsappWorker.ts) — replace BullMQ `Worker` with `ServiceBusClient.createSessionProcessor()`.
- [src/workers/feedbackPromptWorker.ts](../src/workers/feedbackPromptWorker.ts) — straight worker swap.

**Architecture call (locked in):** 1 session-enabled queue, **not** 16 sharded queues. The 16-shard pattern was a Redis workaround; ASB sessions provide per-key FIFO natively. `WORKER_NUM_SHARDS` env var goes away, replaced by `MAX_CONCURRENT_SESSIONS=8`.

**Gotchas worth re-reading before touching the code** (§5 of [azure-migration.md](azure-migration.md)):
- Session lock vs. message lock — don't shorten lock duration "for safety."
- `messageId` is the dedup key, not `sessionId`. Set it explicitly.
- ASB deletes completed messages immediately — no `removeOnComplete` equivalent. Failed messages go to DLQ which doesn't auto-expire.

### 2.2 Local test against JNB Service Bus

Before pushing the rewrite, validate it end-to-end locally:

1. Pull `SERVICE-BUS-CONNECTION-STRING` from Key Vault (Portal → `ttt-prod-kv` → Secrets → click secret → current version → Show secret value).
2. Paste into local `.env` as `SERVICE_BUS_CONNECTION_STRING=…`.
3. Run `npm run dev` against the prod Service Bus (queues are empty, no risk).
4. Send a test message via the existing webhook simulator. Verify it enqueues, the worker picks it up, and processing completes.
5. Watch the ASB queue blade in the portal — message count should rise then fall.

This catches integration issues before they reach prod.

### 2.3 Push, auto-deploy, watch logs

Once local works:

```bash
git push origin main
```

GitHub Actions ships it. Watch:
- Actions tab for the build/deploy.
- Azure portal → `ttt-prod-bot` → Log stream for runtime errors.
- Application Insights → Live metrics for traffic.

### 2.4 Custom domain (optional but recommended)

Wire `bot.ttt-tax.co.za` to the App Service so the Meta webhook URL is stable across any future infra change.

1. App Service `ttt-prod-bot` → Custom domains → + Add custom domain.
2. Add a CNAME at your DNS provider: `bot` → `ttt-prod-bot-<random>.southafricanorth-01.azurewebsites.net`.
3. Validate, then add a free App Service Managed Certificate (Custom domains → + Add binding). Renews automatically.

Do this **before** cutover so you only point Meta at it once.

### 2.5 Cutover

Order of operations, all on one day:

1. **Pre-flight:** confirm both Azure apps are healthy on the prod Service Bus, processing test traffic correctly.
2. **Update Meta webhook URL.** Meta Business Manager → WhatsApp → Configuration → Webhooks → change to `https://bot.ttt-tax.co.za/webhook` (or the raw App Service URL if you skipped the custom domain). Re-verify using `META_VERIFY_TOKEN`.
3. **Watch Application Insights Live Metrics for 30 min.** Inbound webhook count should pick up, queue depth on the ASB blade should rise then drain. Failures should be flat.
4. **If anything is broken:** revert the Meta webhook URL to the Railway one. Cutover aborted. Diagnose, retry.

### 2.6 48-hour soak

Leave Railway + Upstash **running** for 48 hours after cutover, even though no new traffic hits them. Reason: rare flows (low-volume templates, scheduled cron jobs, weekend-only patterns) take days to surface. Rollback in 48h is "change one Meta URL."

After 48h clean:
- Cancel Railway service.
- Cancel Upstash Redis instance.
- Remove `REDIS_URL`, `WORKER_NUM_SHARDS`, `QUEUE_BACKEND` (if you used a feature flag during the rewrite) from `.env.example`.
- Remove `bullmq` + `ioredis` from `package.json` if you didn't already.

### 2.7 Post-cutover hardening (lower priority)

These don't block anything, but worth doing within a few weeks:

- **Switch ASB auth from SAS connection string to managed identity.** §6 of [azure-migration.md](azure-migration.md). Removes the connection string from Key Vault entirely; the app authenticates as itself. Small code change in `connection.ts`, plus assigning two RBAC roles on the namespace to each app's managed identity.
- **Set up alerts in Application Insights.** Two starters: failed requests > 10 in 5 min, p95 latency > 5s over 10 min. Route to email or Slack webhook.
- **DLQ drainer.** Failed messages land in the dead-letter queue and don't auto-expire. Either build a small admin script to drain + log them, or alert on `DeadLetterMessageCount > 0` so you notice before it grows.
- **OIDC federation for GitHub Actions** instead of the `--sdk-auth` JSON secret. Removes the credential from the repo entirely; GitHub authenticates to Azure directly. 15-minute setup.

---

## 3. Rollback plan

If anything goes catastrophically wrong post-cutover, the rollback is:

1. **Meta Business Manager → WhatsApp → Webhooks → revert URL** to the Railway endpoint. Verify with the old token.
2. Traffic immediately resumes flowing to Railway/Upstash.
3. Azure resources stay up but idle — they cost ~$50/mo to leave running while you diagnose, which is fine.

The 48-hour parallel-running window exists precisely so this rollback stays cheap.

---

## 4. Cost summary

| Service | $/mo (approx) | Notes |
|---|---|---|
| App Service Plan (Basic B2) | $35.55 | Hosts both apps |
| Service Bus (Standard) | ~$10 | Base + per-message at our volume is negligible |
| Key Vault | < $1 | Per-operation pricing |
| Application Insights | $0 | Free tier covers our volume |
| Log Analytics workspace | $0 | Same |
| **Total** | **~$47/mo** | |

Replaces whatever Railway + Upstash currently runs at.

---

## 5. Key contacts / references

- **GitHub repo:** `riivo-io/ttt-whatsapp-bot` (main, push triggers deploy).
- **Azure subscription:** TTT Production, subscription ID `9820a639-25bf-420b-87fe-55cbe9f8eb52`.
- **Service Bus connection string:** in Key Vault as `SERVICE-BUS-CONNECTION-STRING`.
- **Migration technical spec:** [azure-migration.md](azure-migration.md).
- **CSP partner with co-Owner access:** Crayon (`AdminAgents` foreign group). They can act as Owner on the subscription — standard for CSP-purchased subs, expected.
