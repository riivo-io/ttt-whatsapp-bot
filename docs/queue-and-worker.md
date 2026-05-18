# Queue + worker (Phase 1 scaling)

The webhook ingester and the message processor are now **two separate
processes** connected by a Redis-backed BullMQ queue. This is the foundation
for handling ~5000 concurrent users without webhook timeouts or duplicate
processing.

## Why

Meta WhatsApp Cloud API requires a webhook ack within 10 seconds. The
previous design did all the Claude + Dynamics + Supabase work inside the
webhook handler, so any slowness pushed the response past 10s, Meta retried,
and we'd double-bill on every retry. The new shape:

```
                ┌───────────────────┐
   Meta ──POST──▶ webhook ingester ──▶ enqueue → 200 OK
                │   (server.ts)     │       │
                └───────────────────┘       │
                                            ▼
                                      ┌──────────────┐
                                      │  Redis       │
                                      │  (Upstash)   │
                                      │  ┌────────┐  │
                                      │  │shard 0 │  │
                                      │  │shard 1 │  │
                                      │  │  ...   │  │
                                      │  │shard 15│  │
                                      │  └────────┘  │
                                      └──────────────┘
                                            │
                                            ▼
                                      ┌───────────────────┐
                                      │ worker process    │
                                      │  (worker.ts)      │
                                      │  16 BullMQ workers│
                                      │  each conc=1      │
                                      └───────────────────┘
                                            │
                                            ▼
                                      Claude / Dynamics /
                                      Supabase / Meta send
```

## Per-conversation FIFO

`shard(phone) = hash(phone) % WORKER_NUM_SHARDS` — every message from a given
phone always lands in the same shard queue. Each shard runs a BullMQ worker
with `concurrency: 1`, so within a phone's lane jobs process strictly in
order. Across lanes runs in parallel.

Bump `WORKER_NUM_SHARDS` for more parallel throughput. Default is 16 — that
gives 16-way parallelism and roughly 300 users per shard at 5000 concurrent.
Each shard adds one BLPOP connection on the worker side, so 64 shards still
costs only ~64 Redis connections (well within Upstash limits).

The ingester and the worker process **must agree on `WORKER_NUM_SHARDS`** —
they both use it to derive the same queue names. Changing it requires
re-deploying both, ideally after draining existing queues.

## Idempotency

Two layers:

1. **Supabase** (`whatsapp_webhook_events` table) — persistent, survives
   restarts and spans multiple ingester replicas. Primary key on Meta's
   `messages[].id`. `idempotencyService.claim()` does an `ON CONFLICT DO
   NOTHING` insert; if zero rows come back, it's a duplicate redelivery and
   we drop it.
2. **BullMQ** (`jobId = metaMessageId`) — transient, defends against the
   rare race where two ingester replicas insert into Supabase simultaneously
   before either sees the other's row.

Meta retries on exponential backoff for up to 7 days on any non-2xx. The
ingester now always returns 200 immediately, so retries should only happen
on actual network failure — but the idempotency check is the safety net.

## Dead-letter queue

After 4 retry attempts with exponential backoff (2s, 4s, 8s, 16s) a job
lands in the `whatsapp_queue_dlq` table for human review. The worker's
`failed` handler at [src/workers/whatsappWorker.ts:42](../src/workers/whatsappWorker.ts#L42)
writes the payload, error, attempts, and stack trace.

Inspect with:

```sql
select id, job_id, phone_number, failed_reason, attempts_made, failed_at
from whatsapp_queue_dlq
order by failed_at desc
limit 20;
```

A future iteration should wire Sentry alerts off this table. For now,
periodic checks during launch are sufficient.

## Setup

### 1. Provision Redis

Sign up for [Upstash Redis](https://upstash.com/), create a database in the
region closest to where the worker runs, and copy the `rediss://...`
connection string from the console.

```bash
REDIS_URL='rediss://default:<token>@<host>:<port>'
```

### 2. Run the migration

```bash
# Supabase CLI
supabase db push

# or apply the file directly:
psql "$SUPABASE_DB_URL" -f supabase/migrations/20260513120000_webhook_idempotency_and_dlq.sql
```

### 3. Run locally (dev)

In two terminals:

```bash
# Terminal 1 — webhook ingester (Express on :3001, fronted by ngrok)
npm run dev

# Terminal 2 — worker
npm run worker:dev
```

Both processes read `REDIS_URL` and `WORKER_NUM_SHARDS` from `.env`.

### 4. Deploy

**Webhook ingester** stays on Vercel (or wherever — it's a thin Express app
now and almost any host works). Returns 200 within ~50ms once the
idempotency row is in.

**Worker** needs a long-lived process — Vercel serverless functions can't
hold open BLPOP connections to Redis. Recommended hosts:

- **[Fly.io](https://fly.io)** — `flyctl launch`, set the entrypoint to
  `npm run worker`, scale to 1 machine (or more — see "scaling out" below).
- **[Railway](https://railway.app)** — deploy as a "background worker"
  service with the start command `npm run worker`.
- **[Render](https://render.com)** — "Background Worker" service type.

All three: ~$5-10/month for a single small instance. Set `REDIS_URL`,
`WORKER_NUM_SHARDS`, and every variable from `.env.example` in the host's
secret manager.

### 5. Scaling out

For more throughput, run more worker replicas. BullMQ workers compete
safely for the same shard queue, so multiple worker processes can pull
from the same Redis. With N replicas × M shards, you get N×M total
parallelism — but **strict per-phone FIFO requires `concurrency: 1` per
shard**, which the current setup enforces. Running multiple replicas
trades strict FIFO within a phone (because two replicas can pull
consecutive jobs from the same shard) for higher throughput. If you need
both, bump `WORKER_NUM_SHARDS` instead of adding replicas.

## Files added

- [supabase/migrations/20260513120000_webhook_idempotency_and_dlq.sql](../supabase/migrations/20260513120000_webhook_idempotency_and_dlq.sql) — idempotency + DLQ tables
- [src/queue/connection.ts](../src/queue/connection.ts) — shared ioredis client
- [src/queue/whatsappQueue.ts](../src/queue/whatsappQueue.ts) — sharded queues + enqueue helper
- [src/workers/whatsappProcessor.ts](../src/workers/whatsappProcessor.ts) — `processMessage` and all helpers (moved from webhook.controller.ts)
- [src/workers/whatsappWorker.ts](../src/workers/whatsappWorker.ts) — BullMQ Worker setup, DLQ wiring
- [src/services/idempotency.service.ts](../src/services/idempotency.service.ts) — Supabase-backed dedupe + DLQ writer
- [src/worker.ts](../src/worker.ts) — worker process entrypoint
- [src/controllers/webhook.controller.ts](../src/controllers/webhook.controller.ts) — slimmed to verify+dedupe+enqueue
