# Bulk WhatsApp tool: Clickatell → Meta Cloud API migration

Brief for Claude Code running inside the bulk-comms repo. The goal is to replace the Clickatell send path with Meta WhatsApp Cloud API (same backend that powers the Tina chatbot) and add the rate-limit handling that bulk sending needs.

You don't have access to the Tina codebase, but the patterns below are the exact ones Tina uses against Meta. Treat this doc as the spec.

---

## 1. Goal

Every place that today calls Clickatell to send a WhatsApp message must:

1. Call Meta Cloud API instead, using the same approved templates and the same shared system-user token.
2. Stay under Meta's per-second send rate and per-24h messaging-tier caps without dropping or duplicating messages.
3. Retry the right errors (429, transient 5xx, pair-rate) and stop sending on the wrong errors (template paused, user opted out, invalid number).

Out of scope: changing which contacts get messaged, which templates get sent, or what the messages say. This is a pure transport swap.

---

## 2. Environment variables

Remove the Clickatell ones, add these. Names match Tina so we share a single source of truth in 1Password / the secrets store:

| Var | Purpose | Notes |
|---|---|---|
| `META_WHATSAPP_TOKEN` | Permanent system-user access token | Use the same value as Tina. Don't create a new app/token — Meta rate-limits per phone number, not per token, so a second token wouldn't buy more headroom |
| `META_PHONE_NUMBER_ID` | Sender phone number id (digits, not the phone number itself) | Same value as Tina |
| `META_GRAPH_API_VERSION` | Default: `v22.0` | Allow override so we can bump versions without code changes |
| `META_MAX_SEND_PER_SECOND` | Default: `60` | Stay safely below Meta's 80/sec soft limit per phone number. Tune up later once tier 3+ is confirmed |
| `META_MAX_CONCURRENT_REQUESTS` | Default: `20` | Caps in-flight HTTP requests to Meta regardless of per-second rate |
| `META_RETRY_MAX_ATTEMPTS` | Default: `5` | Per-recipient retry budget across all transient errors |
| `META_RETRY_BASE_DELAY_MS` | Default: `500` | First backoff delay; doubles each retry with jitter |
| `META_DAILY_TIER_LIMIT` | Default: `100000` | Bot's current Meta messaging tier (1k / 10k / 100k / unlimited). Used to refuse a campaign that would overflow the tier in a 24h window |

Delete: any `CLICKATELL_API_KEY`, `CLICKATELL_BASE_URL`, `CLICKATELL_FROM`, `CLICKATELL_*` vars in `.env`, `.env.example`, deployment configs (Vercel/Render/Railway/Azure/etc), and CI secrets.

Update `.env.example` accordingly so a fresh checkout boots correctly.

---

## 3. Endpoint + auth changes

| | Clickatell | Meta |
|---|---|---|
| Base URL | `https://platform.clickatell.com/v1/message` | `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${META_PHONE_NUMBER_ID}/messages` |
| Method | `POST` | `POST` |
| Auth header | `Authorization: <api key>` | `Authorization: Bearer ${META_WHATSAPP_TOKEN}` |
| Content type | `application/json` | `application/json` |
| Batch shape | One request, `messages: [...]` array | One HTTP request per recipient. No batching endpoint exists |

The "one HTTP request per recipient" point is the biggest change. Anywhere the existing code builds a Clickatell `messages[]` array and POSTs once, replace it with a loop that posts N times, gated by the rate limiter from §6.

---

## 4. Request body — template send

Bulk sending almost always uses pre-approved templates (the 24h customer-service window doesn't apply to outbound campaigns). Body shape:

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "27821234567",
  "type": "template",
  "template": {
    "name": "<TEMPLATE_NAME>",
    "language": { "code": "<LANG_CODE>" },
    "components": [
      {
        "type": "body",
        "parameters": [
          { "type": "text", "text": "<value for {{1}}>" },
          { "type": "text", "text": "<value for {{2}}>" }
        ]
      },
      {
        "type": "button",
        "sub_type": "url",
        "index": "0",
        "parameters": [
          { "type": "text", "text": "<dynamic URL suffix>" }
        ]
      }
    ]
  }
}
```

Rules:

- **`to`** must be E.164 **digits only, no leading `+`**, no spaces, no dashes. Add a normalize step before send (`String(raw).replace(/\D/g, '')`).
- **`<TEMPLATE_NAME>`** must match what's approved in Meta Business Manager (case-sensitive). Templates have to be reapproved in Meta — Clickatell-side templates don't carry over.
- **`<LANG_CODE>`** must match the language the template was approved under (often `en` or `en_US`). Pick once, use consistently.
- **Positional vs named variables.** If the template was approved with named vars (`{{customer_name}}`), each body parameter also needs `"parameter_name": "customer_name"`. If positional (`{{1}}`), the array order is what matters and `parameter_name` is omitted. The two modes don't mix.
- **Drop the body component entirely** when the template has no variables in its body.
- **Button index is 0-based.** First button is `"index": "0"`.
- **URL button parameter is the dynamic suffix only**, not the full URL — the base URL is baked into the approved template.
- **Quick-reply buttons:** `"sub_type": "quick_reply"`, `parameters: [{ "type": "payload", "payload": "<string>" }]`.
- **No `messages[]` wrapper.** One recipient per HTTP request.

---

## 5. Response shape changes

Success (2xx):

```json
{
  "messaging_product": "whatsapp",
  "contacts": [{ "input": "27821234567", "wa_id": "27821234567" }],
  "messages": [{ "id": "wamid.HBgL...", "message_status": "accepted" }]
}
```

The message id to persist is `response.messages[0].id` (a `wamid.*` string). Anywhere the code stores the Clickatell `apiMessageId`, switch the field to read `messages[0].id`.

Error (non-2xx):

```json
{
  "error": {
    "message": "...",
    "code": 131056,
    "error_subcode": 2494102,
    "fbtrace_id": "..."
  }
}
```

Classify errors by `error.code` — see §7.

---

## 6. Rate limiting (the heart of the bulk migration)

Meta enforces several independent limits per phone number. Hit any of them and you start seeing 429s and message rejections.

**Per-second rate.** Soft cap of 80 messages/sec per phone number on Cloud API; this can rise with throughput tier but should be treated as the ceiling. Send at `META_MAX_SEND_PER_SECOND` (default 60) so we have headroom for Tina's own conversational traffic on the same number.

**Concurrency.** Even at 60/sec, if individual requests take 800ms, an unbounded loop will have hundreds of sockets open. Cap in-flight requests with `META_MAX_CONCURRENT_REQUESTS` (default 20).

**24-hour business-initiated cap.** Driven by messaging tier:
- Tier 1: 1,000 unique users / 24h
- Tier 2: 10,000
- Tier 3: 100,000
- Unlimited

Read `META_DAILY_TIER_LIMIT` at campaign start. If the recipient list size + the count already sent in the last 24h would exceed the tier, refuse to start (or chunk into multiple days) — don't discover this mid-send.

**Per-recipient pair rate (`error.code` 131056).** Sending many messages to the same recipient in a short window. Almost never happens on real campaigns (each contact appears once), but handle the error: backoff and retry that one recipient with extra jitter; do not retry the whole batch.

### Implementation

Use a token-bucket limiter — `bottleneck` (Node) or equivalent. Pseudocode:

```ts
import Bottleneck from 'bottleneck';

const limiter = new Bottleneck({
  reservoir: Number(process.env.META_MAX_SEND_PER_SECOND ?? 60),
  reservoirRefreshAmount: Number(process.env.META_MAX_SEND_PER_SECOND ?? 60),
  reservoirRefreshInterval: 1000,
  maxConcurrent: Number(process.env.META_MAX_CONCURRENT_REQUESTS ?? 20),
  minTime: 0,
});

async function sendOne(recipient: Recipient): Promise<SendResult> {
  return limiter.schedule(() => sendTemplateWithRetry(recipient));
}
```

`sendTemplateWithRetry` wraps the axios/fetch call with exponential backoff + jitter:

```ts
async function sendTemplateWithRetry(recipient: Recipient): Promise<SendResult> {
  const max = Number(process.env.META_RETRY_MAX_ATTEMPTS ?? 5);
  const base = Number(process.env.META_RETRY_BASE_DELAY_MS ?? 500);

  for (let attempt = 0; attempt < max; attempt++) {
    try {
      const res = await postToMeta(recipient);
      return { status: 'sent', messageId: res.data.messages[0].id };
    } catch (err: any) {
      const classification = classifyError(err);
      if (classification === 'permanent') return { status: 'failed', reason: err };
      if (classification === 'retryable') {
        const delay = base * 2 ** attempt + Math.floor(Math.random() * 250);
        await sleep(delay);
        continue;
      }
    }
  }
  return { status: 'failed', reason: 'retry budget exhausted' };
}
```

Honor `Retry-After` if Meta returns one — use it instead of the computed backoff for that attempt.

---

## 7. Error classification

| code | Meaning | Action |
|---|---|---|
| 80007 | Rate limit hit | Retryable. Backoff respecting `Retry-After` |
| 131056 | Pair rate limit (same sender+recipient) | Retryable for that one recipient with longer jitter |
| 131026 | Recipient cannot receive (not on WhatsApp / blocked) | Permanent. Mark contact unreachable |
| 131047 | Re-engagement message (24h window closed) | Permanent for non-template sends — bulk should always be template, so this means we sent a wrong payload type. Don't retry |
| 132000 / 132001 / 132005 / 132007 / 132012 / 132015 / 132016 | Template variable mismatch / template paused / language mismatch | Permanent. Stop the campaign and alert — every recipient will hit this |
| 130472 | User experiment / marketing-template throttle | Permanent for this recipient. Skip and continue |
| 5xx | Meta upstream | Retryable |
| Network / ETIMEDOUT / ECONNRESET | Transport | Retryable |

A retryable error must not consume the recipient's slot in the failed list until the retry budget is exhausted. A permanent error must immediately move the recipient to the failed list with the `error.code` recorded.

If three consecutive 132xxx errors fire from the same template+language pair, **abort the whole campaign** — that's a sign the template is paused or misnamed and continuing will burn through the list.

---

## 8. Phone number normalization

Bulk lists come from CRM exports and almost always have inconsistent formatting (`+27 82 123 4567`, `082 123 4567`, `27821234567`). Normalize at ingest:

```ts
function normalizeToE164Digits(raw: string, defaultCountryCode = '27'): string | null {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('0')) digits = defaultCountryCode + digits.slice(1);
  if (digits.length < 9 || digits.length > 15) return null;
  return digits;
}
```

Skip recipients where normalization returns `null` and log them — don't send a malformed number to Meta (it counts against the tier even on rejection).

---

## 9. Idempotency

Meta does not deduplicate by client request id (no equivalent of Stripe's `Idempotency-Key`). The bulk tool must:

1. Persist a `(campaign_id, recipient_e164)` row before the HTTP call goes out.
2. Mark it `sent` only on 2xx with a `wamid`.
3. On retry of a crashed run, skip rows where status is already `sent`.

This protects against double-sends if the process crashes mid-campaign.

---

## 10. Observability

For each send, log structured fields:

```
campaign_id, recipient (last 4 digits only), template_name, status (sent|failed|skipped),
error_code, wamid, attempt_count, latency_ms
```

Track per-campaign:

- send rate (per-second moving average — should sit at ≤ `META_MAX_SEND_PER_SECOND`)
- 429 rate (should be near zero; if not, lower `META_MAX_SEND_PER_SECOND`)
- daily tier usage (cumulative unique recipients in last 24h)

---

## 11. Test plan

Before pointing at a real list:

1. **Single-recipient smoke test.** Set the campaign list to one internal number. Confirm the message lands and the `wamid` is persisted.
2. **Rate-limiter unit test.** Mock `postToMeta` to resolve immediately; feed 1,000 fake recipients; confirm wall-clock time ≥ `1000 / META_MAX_SEND_PER_SECOND` seconds.
3. **Retry classification.** Mock the axios call to return error.code 80007 twice then succeed; confirm 3 attempts, message ends `sent`.
4. **Permanent error.** Mock error.code 131026; confirm zero retries, status `failed`.
5. **Template abort.** Mock 3 consecutive error.code 132012 responses; confirm the campaign aborts before the 4th send.
6. **Idempotency replay.** Kill the process mid-campaign, restart, confirm already-sent recipients are skipped.

---

## 12. Per-call-site checklist

For each Clickatell call site being migrated:

- [ ] URL switched to `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${META_PHONE_NUMBER_ID}/messages`
- [ ] `Authorization` header is `Bearer ${META_WHATSAPP_TOKEN}`
- [ ] No `messages[]` wrapper; one POST per recipient
- [ ] `to` is digits-only E.164 (no `+`)
- [ ] `template.name` + `language.code` match the approved Meta template exactly
- [ ] Body parameters are positional OR named consistently with how the template was approved
- [ ] Button `index` values are 0-based; URL buttons send only the dynamic suffix
- [ ] All sends are scheduled through the rate limiter (`limiter.schedule(...)`)
- [ ] Retry wrapper honors `Retry-After` and uses jittered exponential backoff
- [ ] Error code classification (§7) is in place
- [ ] Persisted message id is read from `response.messages[0].id`
- [ ] CRM/DB write that previously stored Clickatell `apiMessageId` now stores Meta `wamid`
- [ ] Clickatell env vars removed from `.env.example`, CI, and prod config

---

## 13. Roll-out order

1. Approve every Clickatell template inside Meta Business Manager first — nothing can send until approval lands.
2. Land the code change behind a feature flag (e.g. `BULK_SEND_PROVIDER=meta` vs `clickatell`) so we can flip it per campaign.
3. Run a 1-recipient smoke against an internal number.
4. Run a small campaign (< 50 recipients) against opted-in staff/test contacts.
5. Flip the default to `meta`. Watch 429 rate + daily tier usage for the first real campaign.
6. Once a full week of campaigns has run cleanly on Meta, delete the Clickatell code path and env vars.
