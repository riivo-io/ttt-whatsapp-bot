# Smoke test: prompt cache hit (Issue 7 verification)

Verifies that the three `cache_control` breakpoints from Issue 7 produce a
real cache hit on the 2nd turn of a conversation. Not automatable —
requires live Anthropic + live Supabase + a dev WhatsApp number.

## Procedure

1. Pick a phone number whose session can be safely reset (`dev` phone).
2. Reset the session so message_count = 0:
   ```sql
   delete from sessions where phone_number = '<dev_phone>';
   ```
3. Send a first inbound: any user-style message ("hi" works).
4. Wait for the assistant reply.
5. Send a second inbound: another user-style message.
6. Wait for the reply.
7. Query `claude_usage`:
   ```sql
   select created_at, call_purpose, input_tokens, cache_creation_tokens, cache_read_tokens
     from claude_usage
    where phone_number = '<dev_phone>'
    order by created_at asc
    limit 5;
   ```

## Pass criteria

- Row 1 (first turn): `cache_read_tokens = 0`, `cache_creation_tokens > 0`
  (the first turn writes the cache, doesn't read it).
- Row 2 (second turn): `cache_read_tokens > 0` (the breakpoint set on
  `messages[N-2]` is now in the cache from turn 1).

If row 2 still shows `cache_read_tokens = 0`, one of the three
breakpoints is mis-wired. Most likely culprits:

- `system` is still being passed as a bare string (no cache_control)
- `messages[N-2]` lookup is off-by-one — verify it targets the message
  TWO before the end, not one
- The top-level `cache_control` param sneaked back in (it's a no-op and
  must not be present)
