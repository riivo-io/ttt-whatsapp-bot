# Issue 6: [Backend/Worker] Re-enqueue on `RateLimitError` with retry cap

Breakdown §6. JobId `${wamid}:retry:${attemptNum + 1}`, delay = retryAfterMs, cap = 5.
