# Plan: Test Context Switcher (User / Lead / Contact)

## Goal

Add a context switcher to the web UI so testers can easily swap between **client** (contact), **lead**, and **user** (staff) personas without needing real phone numbers tied to Dynamics 365 records.

---

## How It Works Today

1. Frontend sends `POST /api/chat` with `{ message, phoneNumber }`.
2. Backend resolves the phone number against Dynamics 365 (contacts, leads, systemusers).
3. The matched CRM type (`client` | `lead` | `user`) determines:
   - Which **system prompt** the AI gets (role-specific context).
   - Which **tools** are available (e.g., only staff can search contacts, only clients can opt out).
   - Which **CRM operations** are allowed.
4. A Supabase session caches the resolved entity for 30 minutes.

**Problem:** To test as a different type, you need a real phone number that maps to that entity in Dynamics. There's no way to override this from the UI.

---

## Proposed Solution

### Frontend: Context Switcher Bar

Add a dropdown/toggle bar above the chat in `web/app/page.tsx`:

```
[ Client (Contact) v ]  [ Lead v ]  [ Staff (User) v ]
  Phone: 0787133880       Phone: ...    Phone: ...
```

**Behaviour:**
- Three toggle buttons (pill-style) — one for each CRM type.
- Selecting a type sets a `testContext` state: `{ type, phoneNumber, label }`.
- Switching context **clears the chat history** and starts a fresh session.
- The selected context is sent to the backend as a new parameter.

**State:**
```typescript
const [testContext, setTestContext] = useState<{
  type: 'client' | 'lead' | 'user';
  phoneNumber: string;
  label: string;
}>({ type: 'client', phoneNumber: '0787133880', label: 'Client' });
```

### Backend: Accept Context Override

Modify the chat route (`src/routes/chat.route.ts`) to accept an optional `testOverride` parameter:

```typescript
// POST /api/chat
interface ChatRequest {
  message: string;
  phoneNumber?: string;
  testOverride?: {           // NEW
    type: 'client' | 'lead' | 'user';
  };
}
```

**When `testOverride` is present:**
1. Skip the Dynamics lookup entirely.
2. Use a **mock CRM entity** with the specified type:
   - `client` mock: fake contact ID, name "Test Client", optIn true
   - `lead` mock: fake lead ID, name "Test Lead"
   - `user` mock: fake user ID, name "Test Staff Member"
3. Create/reuse a Supabase session tagged with the mock entity.
4. Everything downstream (system prompt, tool selection, AI response) uses the overridden type.

This means:
- AI tools are filtered by the selected type (you'll see different capabilities per role).
- System prompt changes per role (client vs lead vs staff context).
- No real CRM reads/writes happen (safe for testing).

### Guard: Test Mode Only

Wrap the override logic so it only works in development:

```typescript
if (testOverride && process.env.NODE_ENV !== 'production') {
  // use mock entity
}
```

---

## Implementation Steps

### Step 1: Backend — Add mock entity support
**File:** `src/routes/chat.route.ts`

- Accept `testOverride` in the request body.
- When present (and not production), skip `resolveContact()`.
- Build a mock `CrmEntity` with a deterministic fake ID per type (so sessions persist across messages).
- Pass the mock entity through the existing flow (session creation, prompt building, tool filtering).

### Step 2: Backend — Skip CRM writes for mock entities
**File:** `src/routes/chat.route.ts`

- When using a mock entity, skip:
  - `dynamicsService.logMessage()` (no real CRM record to link to).
  - `dynamicsService.updateWhatsAppOptIn()` (no real contact).
- Keep Supabase session + message storage working (so conversation history works).

### Step 3: Frontend — Add context switcher UI
**File:** `web/app/page.tsx`

- Add a bar at the top of the chat container with three pill buttons: **Client**, **Lead**, **Staff**.
- Active pill is highlighted (use existing green accent).
- Switching context:
  - Clears `messages` state.
  - Resets `showWelcome` to true.
  - Updates the `testContext` state.

### Step 4: Frontend — Send context with messages
**File:** `web/app/page.tsx`

- Update the `fetch('/api/chat')` call to include `testOverride: { type: testContext.type }`.
- Update the phone number sent based on the selected context (or use a fixed test number).

### Step 5: Frontend — Visual indicator of active context
**File:** `web/app/page.module.css`

- Style the switcher bar to sit above the chat.
- Show a subtle banner in the chat: "Testing as: Client" so it's always clear which mode is active.
- Different accent colour per type (green = client, orange = lead, blue = staff).

---

## File Changes Summary

| File | Change |
|------|--------|
| `src/routes/chat.route.ts` | Accept `testOverride`, mock entity logic, skip CRM writes |
| `web/app/page.tsx` | Context switcher UI, state management, send override param |
| `web/app/page.module.css` | Switcher bar styles, per-type accent colours |

**No new files needed.** Three existing files modified.

---

## What You'll Be Able to Test

| Context | System Prompt | Available Tools | CRM Writes |
|---------|--------------|-----------------|------------|
| **Client** | "You are a registered TTT client..." | get_my_details, get_client_invoices, get_client_cases, request_callback, opt_out, save_document, refer_friend | Skipped (mock) |
| **Lead** | "You are a prospect in onboarding..." | save_document (upload docs for onboarding) | Skipped (mock) |
| **Staff** | "You are a TTT employee..." | get_my_clients, search_contact, create_case, create_lead, get_client_invoices (for any client), save_document | Skipped (mock) |

Switching between these will immediately change how the AI responds, what tools it offers, and what actions are available — giving you a full picture of each user journey without touching real CRM data.
