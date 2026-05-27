# Tina Infrastructure: Upstash and Railway

This note explains what these two services do, why this kind of system tends to need them, and what the tradeoffs look like. The goal is to give you enough context to judge the spend, not to sell you on it.

---

## At a glance

| Service  | What it is                              | Role in Tina                                          | Monthly cost  |
|----------|-----------------------------------------|-------------------------------------------------------|---------------|
| Upstash  | Hosted message queue (a holding area)   | Holds incoming WhatsApp messages until Tina handles them | ~$10           |
| Railway  | Hosting for always-on background processes | Where Tina's code actually runs, 24/7                | ~$5 to $20    |
| **Total** |                                         |                                                       | **~$15 to $30** |

---

## How the pieces fit together

```
   Client's phone
        │
        │  WhatsApp message
        ▼
   ┌──────────┐         ┌─────────────┐         ┌──────────────┐
   │   Meta   │────────▶│   Upstash   │────────▶│    Railway   │
   │ WhatsApp │  "got   │  (holding   │  pulls  │  (Tina runs  │
   │   API    │  it!"   │    area)    │  next   │   here 24/7) │
   └──────────┘         └─────────────┘         └──────┬───────┘
                                                       │
                              ┌────────────────────────┼────────────────────────┐
                              ▼                        ▼                        ▼
                         ┌──────────┐            ┌──────────┐             ┌──────────┐
                         │ Claude   │            │ Dynamics │             │ Supabase │
                         │  (LLM)   │            │   365    │             │ (records)│
                         └──────────┘            └──────────┘             └──────────┘
```

Meta delivers the message, Upstash holds it, Railway is where Tina picks it up and does the actual work (talking to Claude, looking up the client in Dynamics, etc.).

---

## The problem Upstash solves

WhatsApp (Meta) has a technical rule that shapes everything about how a bot like Tina has to be built: when a client sends a message, the bot must acknowledge it within a few seconds. If the bot is still thinking when the deadline hits, Meta assumes the message was lost and sends it again.

For Tina, "thinking" is not instant. Here's roughly what happens behind the scenes for a typical message:

| Step                                             | Typical time     |
|--------------------------------------------------|------------------|
| Look up the client in Supabase / Dynamics        | 1 to 3 seconds   |
| Check LoE status, SARS onboarding, recent cases  | 2 to 5 seconds   |
| Ask Claude what to reply (with full context)     | 5 to 15 seconds  |
| If a document was sent: read and analyse the PDF | 10 to 30 seconds |
| Send the reply, log the interaction              | 1 to 2 seconds   |
| **Total for a typical message**                  | **10 to 30 seconds** |

Meta's deadline for "we got your message" is much shorter than that. So we need somewhere to park the message immediately while Tina takes her time.

### Without a queue (what tends to go wrong)

```
  Client sends:  ──"Hi Tina, can you help with my return?"
                  │
   Tina is busy thinking...  (calling Claude, checking Dynamics)
                  │
   ⏰ Meta's deadline passes
                  │
   Meta resends:  ──"Hi Tina, can you help with my return?"
                  │
   Tina finishes the first one, then starts the second one
                  │
   Client gets:   ──reply #1
                  ──reply #2  ← duplicate, looks broken
                  And: two cases logged in Dynamics for the same enquiry
```

### With a queue (Upstash)

```
  Client sends:  ──"Hi Tina, can you help with my return?"
                  │
   Message lands in Upstash in ~50ms
                  │
   Meta gets "got it!" within the deadline. ✅
                  │
   Tina pulls the message from Upstash when she's ready
                  │
   Tina works on it for 20 seconds, no pressure
                  │
   Client gets one clean reply, one case in Dynamics
```

This pattern (a queue between the messaging platform and the bot) is how most production WhatsApp and chat systems are built. It's not a luxury, it's the standard shape of the architecture.

---

## The problem Railway solves

Tina is not a website. A website only needs to wake up when someone visits it, which is why most modern web hosting bills per request and shuts processes down between visits.

Tina is different. She needs to be **continuously listening** to the Upstash queue, ready to pick up the next message whenever it lands. She also does work that takes longer than typical "wake up briefly, respond, sleep" hosting allows.

### Hosting options compared

| Option                                | Fits Tina? | Monthly cost   | Why                                                                    |
|---------------------------------------|------------|----------------|------------------------------------------------------------------------|
| Free serverless (Vercel free tier)    | No         | $0             | Shuts down between requests, has hard timeout limits Tina would hit constantly |
| Run on a laptop / office PC           | No         | $0             | Goes offline whenever the machine sleeps, reboots, or loses internet   |
| **Railway** (what we're using)        | Yes        | $5 to $20      | Always-on, no timeout limits, predictable bill, almost no maintenance  |
| Raw AWS / Azure (DIY)                 | Yes        | $10 to $50+    | Cheaper at scale but needs someone to set up and maintain it           |
| Enterprise managed hosting            | Overkill   | $200 to $500+  | Designed for systems serving millions of users                         |

Railway is the middle path. It costs slightly more than raw cloud hosting, but in exchange we don't need someone whose job is to maintain servers. Most small-to-mid teams sit here for the same reason.

---

## Why not Vercel / Netlify or Azure Service Bus?

These came up as fair questions: both are products we could plausibly be using instead. The short answer is that each one solves a different shape of problem than what Tina actually needs. The full reasoning is below.

### Vercel / Netlify in place of Railway

Vercel and Netlify are built around serverless functions. A request comes in, a function wakes up, runs briefly, returns, shuts down. They bill per invocation and enforce hard timeouts (Vercel: 10 seconds on Hobby, 60 seconds on Pro; Netlify: 10 seconds default, 26 seconds on background functions). This model is excellent for websites and APIs that respond quickly and then go quiet.

Tina is not one process, she is actually two running side by side:

| Process           | What it does                                                       | Fits serverless?      |
|-------------------|--------------------------------------------------------------------|-----------------------|
| Webhook receiver  | Meta hits this URL, it drops the message into Upstash in ~50ms     | Yes, technically      |
| Queue worker      | Pulls jobs from Upstash, runs the 10 to 30 seconds of actual work  | **No**                |

The worker is the disqualifier. It is a long-running Node process that holds an open connection to Upstash, blocks on the queue waiting for jobs, and then works each one for 10 to 30 seconds (sometimes longer with PDF analysis). Neither Vercel nor Netlify has a concept of an always-on background process, and the per-job duration exceeds their timeout limits on every plan a small team would realistically pay for.

So the real choice is not "Vercel vs Railway." It is:

- **Just Railway** (what we have today): one deployment, one bill, one log stream, one place to look when something breaks.
- **Vercel or Netlify for the webhook + Railway for the worker**: two deployments, two bills, two log streams, two places to debug. The webhook does so little that splitting it out buys nothing in exchange for that operational overhead.

If Tina ever moved to a pure request-and-respond model with no queue and no long-running jobs, Vercel or Netlify would be the right answer. Given Meta's deadline rule covered earlier, that model does not work for us.

### Azure Service Bus in place of Upstash

This one is a closer call and worth taking seriously, because TTT is already on Microsoft 365 and Dynamics 365, so an Azure subscription likely already exists. Consolidating onto one vendor is a real benefit when it lines up.

The thing to understand first is what Upstash is actually doing for us. It is hosted Redis. Redis is a piece of infrastructure that does a few different jobs at once, and we are using it for three:

1. **The job queue itself** (built on Redis using an open-source library called BullMQ)
2. **The phone-number-to-identity cache** (so Tina doesn't hit Dynamics on every single message)
3. **Rate-limit and deduplication state** (for retries, idempotency, and respecting Meta's rate limits)

Azure Service Bus only does #1. If we switched the queue to Service Bus, we would still need Redis (or Azure Cache for Redis, which starts around $15 to $20 per month at the smallest tier) for #2 and #3. The bill goes up, not down, and we would be running two pieces of infrastructure instead of one.

Setting the cache question aside and looking at queue-only:

| Dimension                    | Upstash Redis + BullMQ                                       | Azure Service Bus (Standard tier)                        |
|------------------------------|--------------------------------------------------------------|----------------------------------------------------------|
| Monthly cost at our volume   | ~$10                                                         | ~$10 base + per-operation charges                        |
| Queue library                | BullMQ (popular, MIT licensed, widely used in Node projects) | `@azure/service-bus` (Azure-specific SDK)                |
| Setup                        | Set one environment variable, point the bot at it            | Azure subscription, namespace, queue, role assignments, connection strings, networking |
| Job retry / backoff          | Built into BullMQ                                            | Built in, different semantics                            |
| Delayed jobs and scheduling  | Built into BullMQ                                            | Scheduled messages, yes                                  |
| Portability                  | Any Redis provider (AWS, GCP, self-hosted, etc.)             | Azure only                                               |
| Operational familiarity      | Standard Node ecosystem, large community                     | Requires Azure tooling and conventions                   |
| Migration effort from today  | $0 (it's what we have)                                       | A few days of work to rewrite the queue layer and shift the cache to a separate Redis |

Azure Service Bus is a perfectly good product. It is what a larger team inside an Azure-native shop with a dedicated platform group would reach for. The decision criteria that actually matter for a bot maintained by one or two people are: how long it takes to set up, how easy it is to debug at 9pm when something breaks, and how locked in we are to one vendor's proprietary protocol. On all three, Upstash + BullMQ wins for our current size.

### What an Azure-equivalent setup would actually cost

To match what Tina actually needs end-to-end (queue + cache + always-on worker), the minimum viable Azure setup looks like this:

| Component                              | Azure equivalent           | Tier needed       | Monthly (USD)    |
|----------------------------------------|----------------------------|-------------------|------------------|
| Queue (Upstash today)                  | Azure Service Bus          | Standard          | ~$10             |
| Cache + dedup state (Upstash today)    | Azure Cache for Redis      | Basic C0 (250 MB) | ~$16             |
| Worker host (Railway today)            | Azure App Service          | B1 Linux          | ~$13             |
| Egress, logs, monitoring               | Bundled / minor            | n/a               | ~$1 to $5        |
| **Realistic total**                    |                            |                   | **~$40 to $45**  |

That is roughly $40 to $45 per month versus the $15 to $30 we are paying today. About 2x.

A few ways the number could move:

**Cheaper (close to today's spend), with caveats**

- Service Bus Basic tier is ~$0.05 per million operations and would be effectively free at our volume. It lacks topics, sessions, and some retry semantics BullMQ relies on, so the queue layer would need rewriting anyway.
- The cache and dedup state could be moved into Supabase (Postgres) instead of Redis. This costs nothing extra but adds latency to every message and increases load on Supabase.
- Combined, that brings the bill to around $14 per month, close to current. The cost is several days of rewrite work and a slower, more brittle system.

**More expensive, if anyone asks for "production-grade" tiers**

- Service Bus Standard ($10) + Redis Standard C0 with replication ($41) + App Service B2 ($26) lands at about $77 per month.
- Service Bus Premium starts at ~$670 per month per messaging unit. Worth mentioning only because "Premium" sounds reassuring to non-technical buyers; it is wildly overkill for Tina and would never be the right call.

**A few notes on these numbers**

- Prices are Microsoft list prices for the South Africa North region. Enterprise Agreement discounts of 5 to 15% apply if TTT has one, which a company this size typically does not.
- The current $15 to $30 figure already covers everything (queue + cache + worker). The $40 to $45 Azure figure is the equivalent like-for-like total, not a partial estimate.
- The roughly $25 per month delta is small in absolute terms. The stronger argument against switching is the migration cost (a few days of engineering work to rewrite the queue layer and split the cache) and vendor lock-in, not the bill itself.

### Where this lands

- **Vercel / Netlify** don't fit the worker process at all, so they would have to be added on top of Railway rather than replace it. No saving, more moving parts.
- **Azure Service Bus** would work for the queue specifically, but we would still need Redis for caching and dedup, the migration is non-trivial, and we would be trading a widely-used open library for vendor-specific code. Worth revisiting if Tina's scale grows by an order of magnitude or if TTT brings on a dedicated platform engineer.

Both alternatives are reasonable answers to different questions. They become the right answer if the shape of the problem changes; right now the shape of the problem matches what Upstash and Railway are built for.

---

## What we're actually getting for the spend

| What we get          | Why it matters                                                                  |
|----------------------|---------------------------------------------------------------------------------|
| Reliability          | Messages aren't lost if Tina restarts. Clients don't get duplicate replies.     |
| Predictable cost     | Roughly the same bill each month, regardless of how busy Tina is.               |
| Headroom             | Same setup handles 5 clients/day or 500/day. No re-platforming when we grow.    |
| Low maintenance      | Both services are managed. Our time stays on what Tina says, not how she runs.  |

---

## Honest tradeoffs

- We are paying for managed convenience. A team with dedicated infrastructure people could replicate this on cheaper raw cloud hosting. We are choosing to spend money instead of time.
- The cost will grow if Tina's usage grows substantially. At an order of magnitude more clients, it would be worth re-evaluating, but the growth is gradual and predictable.
- If we ever wanted to leave these providers, the code would mostly transfer (it's not deeply locked in), but the migration would be a few days of work.

---

## Where this leaves us

The roughly $15 to $30/month covers the two pieces of infrastructure that turn Tina from a script that works on a laptop into a system clients can actually rely on. It is not the cheapest possible option, and it is not enterprise-grade. It is the middle path that most teams of our size settle on for this kind of tool, chosen because the cost is small relative to the engineering time it saves and the client-facing reliability it buys.

Happy to walk through any of this in more detail, or to put together a cheaper alternative if the budget calls for it.
