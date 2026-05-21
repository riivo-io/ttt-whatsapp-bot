# Azure migration: Railway + Upstash → App Service + Service Bus

Spec for the infrastructure cutover. Current stack runs the bot on Railway with BullMQ over Upstash Redis. Target stack runs it on Azure App Service with `@azure/service-bus`.

This doc captures the architecture decisions, the code changes needed, and the gotchas worth knowing before you start touching the queue layer.

---

## 1. Architecture decision: ASB sessions, not sharded queues

Today's BullMQ design uses 16 sharded queues (`whatsapp-inbound-0..15`), each with worker concurrency = 1, to fake per-conversation FIFO on top of Redis. That pattern exists because Redis has no native concept of per-key ordering.

**Azure Service Bus has this built in — it's called Sessions.** Set `sessionId = phone` on the message and ASB guarantees per-session FIFO automatically. Receivers lock one session at a time; multiple sessions process in parallel.

**Use one session-enabled queue. Not 16 sharded queues.** The shard count, the hash function, the per-shard connection management — all of it goes away.

### Queue layout

| Queue | Sessions | Purpose |
|---|---|---|
| `whatsapp-inbound` | ✅ Enabled | All inbound WhatsApp messages. `sessionId = phone` |
| `feedback-prompt` | ❌ Disabled | Delayed L1 feedback prompts. Order across phones doesn't matter |

---

## 2. Service Bus queue settings (provisioned in portal)

Both queues, unless noted:

- **Max delivery count**: 5 (matches current `attempts: 4` + headroom; ASB counts the initial delivery)
- **Message TTL**: 1 day for `whatsapp-inbound`, 2 days for `feedback-prompt` (delayed prompts need headroom)
- **Lock duration**: 5 minutes (must exceed worst-case processing — Claude calls + Dynamics writes occasionally run 30–60s)
- **Duplicate detection**: ON, 10-minute window (replaces BullMQ `jobId` dedup)
- **Dead lettering on expiration**: ON
- **Partitioning**: OFF (incompatible with some session guarantees, throughput not needed)
- **Auto-delete on idle**: OFF

---

## 3. Code changes

### Dependencies

```diff
- "bullmq": "^5.34.0",
- "ioredis": "^5.4.1",
+ "@azure/service-bus": "^7.x",
+ "@azure/identity": "^4.x",
```

`@azure/identity` is only needed if you switch to managed identity for ASB auth (cleaner long-term — see §6). SAS connection string works fine to start.

### Files affected

- `src/queue/connection.ts` — replace `createRedisConnection()` with a `ServiceBusClient` factory
- `src/queue/whatsappQueue.ts` — delete shard logic (`getNumShards`, `shardFor`, `shardQueueName`). Replace with a single `ServiceBusSender` that sets `sessionId = phone`. Keep the public API (`enqueueInboundMessage`, `enqueueRetryAfterRateLimit`) so callers don't change.
- `src/queue/feedbackPromptQueue.ts` — straight BullMQ → ASB swap, no sessions
- `src/workers/whatsappWorker.ts` — replace BullMQ `Worker` with `ServiceBusSessionReceiver` loop or `ServiceBusClient.acceptNextSession()` pattern
- `src/workers/feedbackPromptWorker.ts` — straight worker swap

### Enqueue pattern (whatsappQueue.ts)

```ts
import { ServiceBusClient, ServiceBusMessage } from '@azure/service-bus';

const client = new ServiceBusClient(process.env.SERVICE_BUS_CONNECTION_STRING!);
const sender = client.createSender('whatsapp-inbound');

export async function enqueueInboundMessage(payload: WhatsAppJobPayload) {
    const msg: ServiceBusMessage = {
        body: payload,
        sessionId: payload.phone,          // ← FIFO per phone
        messageId: payload.metaMessageId,  // ← duplicate detection key
    };
    await sender.sendMessages(msg);
}
```

### Retry pattern (replacing `enqueueRetryAfterRateLimit`)

ASB has scheduled messages built in — no separate retry queue needed:

```ts
const msg: ServiceBusMessage = {
    body: payload,
    sessionId: payload.phone,
    messageId: `${payload.metaMessageId}:retry:${attemptNum}`,  // distinct from original
    scheduledEnqueueTimeUtc: new Date(Date.now() + delayMs),
};
await sender.sendMessages(msg);
```

### Consume pattern (whatsappWorker.ts)

```ts
import { ServiceBusClient, ProcessErrorArgs } from '@azure/service-bus';

const client = new ServiceBusClient(process.env.SERVICE_BUS_CONNECTION_STRING!);
const processor = client.createSessionProcessor('whatsapp-inbound', {
    maxConcurrentSessions: parseInt(process.env.MAX_CONCURRENT_SESSIONS ?? '8', 10),
    maxConcurrentCallsPerSession: 1,  // strict per-session FIFO
    autoCompleteMessages: false,
});

await processor.subscribe({
    processMessage: async (msg, session) => {
        try {
            await handleInbound(msg.body);
            await session.completeMessage(msg);
        } catch (err) {
            // ASB increments delivery count automatically on abandon
            await session.abandonMessage(msg);
            throw err;
        }
    },
    processError: async (args: ProcessErrorArgs) => {
        console.error('[ASB]', args.error);
    },
});
```

---

## 4. Environment variables

### Remove

```
REDIS_URL
WORKER_NUM_SHARDS
```

### Add

```
SERVICE_BUS_CONNECTION_STRING        # from namespace SAS policy
MAX_CONCURRENT_SESSIONS=8            # ASB session parallelism (replaces WORKER_NUM_SHARDS)
```

The rest of `.env.example` carries over unchanged.

---

## 5. Gotchas

### Session lock vs. message lock

ASB has two locks on a session-enabled queue. Both can bite you:

- **Message lock**: held by the receiver while a single message is being processed. Renews automatically by the SDK *as long as the process is alive*. If your handler exceeds lock duration without completing/abandoning, lock drops and another receiver grabs it → duplicate processing.
- **Session lock**: held by the session receiver across multiple messages from the same phone. Drops if the session goes idle for `lockDuration` without new messages.

Don't set lock duration shorter than your worst-case handler. 5 min is the right starting point. If you ever see "Lock lost" errors, the answer is usually "increase lock duration" or "split the handler into chunks that each complete a message," **not** "renew the lock manually."

### Duplicate detection only spans the configured window

Set to 10 min. If Meta redelivers a webhook 11 min later (extremely rare but possible), ASB will accept it as a new message. The Supabase idempotency table (`whatsapp_inbound_messages.meta_message_id` unique constraint) is the durable layer — ASB dedup is belt-and-braces on top, not a replacement.

### `messageId` is the dedup key, not `sessionId`

ASB duplicate detection checks `messageId`. Set it explicitly to `payload.metaMessageId` (or the retry-suffixed version). Don't rely on the default auto-generated GUID — it makes every send unique and dedup never triggers.

### Scheduled messages are billed when scheduled, not when delivered

Doesn't matter at our volume but worth knowing — a 2.5-min delayed feedback-prompt counts as one operation immediately. No cost surprise but it explains why your "messages sent" metric looks higher than expected on the ASB blade.

### `acceptNextSession` blocks until a session is available

If you write the loop manually instead of using `createSessionProcessor`, the `acceptNextSession()` call blocks up to its timeout waiting for any session with available messages. Pass a sane timeout (e.g. 60s) and loop — otherwise an idle queue will appear to hang.

`createSessionProcessor` handles this for you, which is why the example above uses it. Only drop to the manual pattern if you need session-routing logic the processor can't express.

### Standard tier has 1MB message size limit

Premium goes to 100MB. We're nowhere near 1MB (payload is `messages[i]` from Meta — a few KB). If we ever embed media bodies in the queue payload, that breaks. Don't do that — keep the queue payload to refs and let the worker fetch the binary.

### No native `removeOnComplete` / `removeOnFail` — but you don't need it

BullMQ keeps completed jobs visible for observability and you tune retention with `removeOnComplete: { age, count }`. ASB deletes messages on `complete()` immediately. Successful messages are gone — use Application Insights for processing history. Failed messages land in the queue's DLQ, which has no auto-expiry; build a small DLQ-drainer (or alert) so it doesn't grow unbounded.

### Connection sharing is fine

Unlike Upstash, you don't need one ASB client per queue. `ServiceBusClient` multiplexes over AMQP. Create one client at startup, reuse it across senders and processors. The factory pattern in `src/queue/connection.ts` exists to work around an Upstash bug — collapse it.

---

## 6. Authentication: SAS to start, managed identity later

**Phase 1 (cutover):** SAS connection string in App Settings (Key Vault reference). Works immediately, easy to verify.

**Phase 2 (post-cutover hardening):** switch to managed identity.

```ts
import { DefaultAzureCredential } from '@azure/identity';
const client = new ServiceBusClient(
    'ttt-prod-serv-bus.servicebus.windows.net',
    new DefaultAzureCredential(),
);
```

Requires granting the App Service's system-assigned managed identity the `Azure Service Bus Data Sender` and `Azure Service Bus Data Receiver` roles on the namespace. No connection string in env vars at all. Better security posture, no rotation burden.

Don't do this on day one — get the cutover working first, then swap auth. The code change is small and isolated.

---

## 7. Deployment differences (Railway → App Service)

| | Railway | App Service |
|---|---|---|
| Build | Detects Dockerfile or Nixpacks | Container image from GHCR (or ACR) |
| Process | `Procfile` or implicit | `npm start` from container entrypoint |
| Worker | Separate process via Railway service | Same container, `node dist/worker.js` runs alongside `dist/server.js` via a process manager, OR split into two App Services |
| Restart on crash | Automatic | Automatic (App Service) — but only restarts the container, not individual processes inside it |
| Env vars | Railway dashboard | App Service Configuration → Application settings (use Key Vault references for secrets) |
| Logs | Railway log stream | Application Insights + log stream blade |
| Scaling | Manual sliders | App Service Plan SKU + Scale Out rules |

### Worker process decision

Today `server.ts` and `worker.ts` run as separate Railway services. On App Service you have two options:

1. **Single container, both processes** — use a tiny supervisor (`tsx` won't survive a worker crash without one). Add `pm2` or write a small `start.sh` that runs both with restart-on-exit. Cheaper (one App Service Plan) but a worker crash that ate memory affects the web process too.
2. **Two App Services sharing the plan** — `ttt-prod-bot` (web) and `ttt-prod-bot-worker` (worker). Same Linux Plan so cost is identical. Cleaner isolation. Recommended.

Option 2 is the industry-standard approach. Pick it unless you have a reason not to.

### Health check

Expose `GET /healthz` returning `200 OK` from the web process. Configure App Service → Configuration → General settings → Health check path. App Service uses it to decide when a deployment is healthy and when to restart unhealthy instances.

---

## 8. Cutover sequence

1. **Provision Azure infra** (Service Bus namespace + queues, App Service plan + web app + worker app, Key Vault, Application Insights) — see the portal walkthrough you've already started.
2. **Build the code changes** on a branch. Both `REDIS_URL` and `SERVICE_BUS_CONNECTION_STRING` work side-by-side via a feature flag (`QUEUE_BACKEND=bullmq|asb`) during development.
3. **Deploy to staging slot** with `QUEUE_BACKEND=asb` and the Azure connection string.
4. **Point a test WhatsApp number** at the staging slot's webhook URL. Run golden-path flows for 30 min.
5. **Swap slots** — production traffic moves to Azure. Meta webhook URL update happens here.
6. **Watch Application Insights** for 30 min. Errors should be flat; queue depth should drain quickly.
7. **Leave Railway/Upstash running for 48h** as rollback insurance. Real edge cases surface over days, not minutes.
8. **Decommission Railway + Upstash** after 48h clean. Remove `QUEUE_BACKEND` flag and BullMQ deps in a follow-up PR.

---

## 9. Provisioned SKUs (as deployed)

Recording the actual choices made during the cutover so future-you knows what's in prod without clicking through the portal.

| Resource | SKU | Approx $/mo (South Africa North) | Notes |
|---|---|---|---|
| App Service Plan `ttt-prod-plan` | **Basic B2** (Linux) | $35.55 | 2 vCPU, 3.5 GB RAM. Hosts both the web app and the worker app on the same plan |
| Service Bus namespace `ttt-prod-serv-bus` | **Standard** | ~$10 base | Zone-redundant. Standard required for duplicate detection + sessions |
| Key Vault `ttt-prod-kv` | **Standard** | < $1 | RBAC permission model |
| Application Insights `ttt-prod-ai` | Pay-as-you-go | $0 at current volume | Free up to 5 GB/mo ingestion |
| Log Analytics workspace `ttt-prod-law` | Pay-as-you-go | $0 at current volume | Backs Application Insights |

**Region**: South Africa North (Johannesburg) for everything. Same-region traffic between App Service ↔ Service Bus ↔ Key Vault stays free and sub-10ms.

**Why Basic B2 not Premium**: B2 has the same vCPU/RAM as P1V3 at a quarter of the price. The Premium-only features (autoscaling, deployment slots, vnet integration, zone redundancy on the app itself) aren't needed at current volume. Upgrade in place is a SKU dropdown change with no downtime if we ever need them.

**Basic tier has no deployment slots — direct-deploy only.** Slot swap is a Standard+ feature. The cutover model is therefore "deploy to prod, monitor App Insights, redeploy previous build if broken" rather than "deploy to staging slot and swap." Acceptable trade-off at our traffic — a 30-second redeploy is recoverable, clients retry. If we ever need true zero-downtime swaps, upgrade the plan to Standard S1 (SKU dropdown, no migration). Don't pay double for a feature used once during migration.

**Cost ceiling**: ~$50/mo all-in vs. Railway + Upstash today. Per-message Service Bus cost is negligible at our volume — Standard tier covers 12.5M operations/mo before metering kicks in.

---

## 10. What stays the same

- Supabase remains the durable cache and idempotency layer. The `whatsapp_inbound_messages` table still does first-line dedup before anything hits the queue.
- Dynamics, Graph, Anthropic, OpenAI, Mistral all unchanged — they're external services, not Azure-specific.
- Meta webhook signature verification, payload shape, business logic — untouched.
- Job payload shape (`WhatsAppJobPayload`) — unchanged. The transport changes; the cargo doesn't.

This migration is a transport swap. Treat any pressure to refactor business logic during the cutover as scope creep.
