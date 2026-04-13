# Plan: Staff Create Task Workflow

## Goal

Allow staff users to create a **task** in the CRM (Dynamics 365) for a specific client/lead via the WhatsApp bot or web chat. The AI gathers the required fields conversationally, then calls a new `create_task` tool to POST the task to Dynamics.

---

## Key Fields (from CRM schema)

| Field | CRM Field | Required | How We Get It |
|-------|-----------|----------|---------------|
| **Client / Lead** | `regardingobjectid` (bind via `Contact_Tasks` or `new_lead_Tasks`) | Yes | Staff provides client/lead name -> resolve via `search_contact_by_name` or lead lookup |
| **Task Type** | `_riivo_tasktype_value` | Yes | Staff selects from a list of task types (lookup to `riivo_tasktype` entity) |
| **Tax Year** | `riivo_taxyear` | Yes | Staff provides year -> computed as `463630000 + (year - 2015)` |
| **Primary Representative** | `_riivo_primaryrepresentative_value` | Yes | Auto-set to the staff member's own `systemuser` ID |
| **Subject** | `subject` | Auto | Auto-generated from task type name + timestamp (mirrors CRM pattern) |
| **Description** | `description` | No | Optional — staff can provide notes |
| **Priority** | `prioritycode` | No | Defaults to `1` (Normal) |
| **Status** | `statecode` / `statuscode` | Auto | Defaults to `0` (Open) / `2` (Not Started) |
| **Owner** | `ownerid` | Auto | Set to the staff member's own ID |

---

## CRM API Details

### Create Task
```
POST /api/data/v9.2/tasks
```

**Payload (for a lead):**
```json
{
  "subject": "OTP and added to Client CRM List - 3/19/2026 8:02 PM",
  "regardingobjectid_new_lead_task@odata.bind": "/new_leads(<lead-guid>)",
  "riivo_TaskType_Task@odata.bind": "/riivo_tasktypes(<tasktype-guid>)",
  "riivo_taxyear": 463630010,
  "riivo_PrimaryRepresentative@odata.bind": "/systemusers(<staff-user-guid>)",
  "prioritycode": 1,
  "description": "Optional notes"
}
```

**Payload (for a contact):**
```json
{
  "subject": "OTP and added to Client CRM List - 3/19/2026 8:02 PM",
  "regardingobjectid_contact_task@odata.bind": "/contacts(<contact-guid>)",
  "riivo_TaskType_Task@odata.bind": "/riivo_tasktypes(<tasktype-guid>)",
  "riivo_taxyear": 463630010,
  "riivo_PrimaryRepresentative@odata.bind": "/systemusers(<staff-user-guid>)",
  "prioritycode": 1,
  "description": "Optional notes"
}
```

> **Binding properties:** `Contact_Tasks` -> `regardingobjectid_contact_task`, `new_lead_Tasks` -> `regardingobjectid_new_lead_task`.

### Fetch Task Types (for selection)
```
GET /api/data/v9.2/riivo_tasktypes?$select=riivo_tasktypeid,riivo_name&$orderby=riivo_name
```

### Tax Year Option Set Values
Computed formula: `463630000 + (year - 2015)`

| Year | Value |
|------|-------|
| 2015 | 463630000 |
| 2016 | 463630001 |
| 2017 | 463630002 |
| 2018 | 463630003 |
| 2019 | 463630004 |
| 2020 | 463630005 |
| 2021 | 463630006 |
| 2022 | 463630007 |
| 2023 | 463630008 |
| 2024 | 463630009 |
| 2025 | 463630010 |
| 2026 | 463630011 |
| 2027 | 463630012 |
| 2028 | 463630013 |

**In code:** `const taxYearValue = 463630000 + (year - 2015);` — no need to hardcode a lookup table.

---

## Implementation Steps

### Step 1: Dynamics Service — Add task-related methods

**File:** `src/services/dynamics.service.ts`

Add three new methods:

1. **`getTaskTypes()`** — Fetch available task types from `riivo_tasktypes` entity. Cache results (they rarely change).

2. **`createTask(params)`** — POST a new task to Dynamics.
   ```typescript
   async createTask(params: {
     regardingId: string;
     regardingType: 'contact' | 'lead';
     taskTypeId: string;
     taskTypeName: string;
     taxYear: number;
     primaryRepId: string;
     description?: string;
     priority?: number;
   }): Promise<{ success: boolean; taskId?: string; error?: string }>
   ```

3. **`searchLeadByName(name: string)`** — Search leads by name (needed so staff can look up a lead to link the task to). Similar to existing `searchContactByName`.

### Step 2: OpenAI Service — Add `create_task` tool definition

**File:** `src/services/openai.service.ts`

**Tool definition:**
```typescript
{
  type: "function",
  function: {
    name: "create_task",
    description: "Create a new task in the CRM for a client or lead. Gather ALL required info before calling: the client/lead name, task type, and tax year. Use search_contact_by_name or search_lead_by_name first to resolve the client/lead ID. The primary representative is automatically set to the staff member.",
    parameters: {
      type: "object",
      properties: {
        client_or_lead: {
          type: "string",
          description: "The resolved GUID of the client (contact) or lead to link the task to."
        },
        entity_type: {
          type: "string",
          enum: ["contact", "lead"],
          description: "Whether the regarding entity is a contact or lead."
        },
        task_type_id: {
          type: "string",
          description: "The GUID of the selected task type."
        },
        task_type_name: {
          type: "string",
          description: "The display name of the task type (used for the subject line)."
        },
        tax_year: {
          type: "number",
          description: "The tax year option set value (e.g. 463630010 for 2025)."
        },
        description: {
          type: "string",
          description: "Optional notes or description for the task."
        }
      },
      required: ["client_or_lead", "entity_type", "task_type_id", "task_type_name", "tax_year"]
    }
  }
}
```

**Add `get_task_types` tool:**
```typescript
{
  type: "function",
  function: {
    name: "get_task_types",
    description: "Get the list of available task types. Use this when a staff member wants to create a task, so they can pick the correct type.",
    parameters: {
      type: "object",
      properties: {}
    }
  }
}
```

**Add `search_lead_by_name` tool:**
```typescript
{
  type: "function",
  function: {
    name: "search_lead_by_name",
    description: "Search for a lead by name. Use when staff needs to find a lead to link a task or other record to.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The lead name to search for." }
      },
      required: ["name"]
    }
  }
}
```

### Step 3: OpenAI Service — Register tools for staff role

**File:** `src/services/openai.service.ts`

Update the `staffTools` array to include the new tools:
```typescript
const staffTools = [
  'get_my_clients', 'get_client_details', 'get_client_invoices',
  'get_client_cases', 'get_case_by_name', 'get_outstanding_balance',
  'search_contact_by_name', 'create_case', 'create_lead',
  'save_document',
  // NEW
  'create_task', 'get_task_types', 'search_lead_by_name'
];
```

### Step 4: OpenAI Service — Handle tool execution

**File:** `src/services/openai.service.ts`

Add handlers in the tool execution block:

```typescript
} else if (functionName === 'get_task_types') {
    const taskTypes = await dynamicsService.getTaskTypes();
    functionResponse = taskTypes.length > 0
      ? JSON.stringify(taskTypes)
      : "No task types found.";

} else if (functionName === 'search_lead_by_name') {
    const args = JSON.parse(toolCall.function.arguments || '{}');
    const results = await dynamicsService.searchLeadByName(args.name);
    functionResponse = results.length > 0
      ? JSON.stringify(results)
      : "No leads found matching that name.";

} else if (functionName === 'create_task') {
    const args = JSON.parse(toolCall.function.arguments || '{}');
    const result = await dynamicsService.createTask({
      regardingId: args.client_or_lead,
      regardingType: args.entity_type,
      taskTypeId: args.task_type_id,
      taskTypeName: args.task_type_name,
      taxYear: args.tax_year,
      primaryRepId: contactId,  // staff member's own ID
      description: args.description,
    });
    functionResponse = result.success
      ? `Task created successfully: "${args.task_type_name}" for tax year ${args.tax_year}.`
      : `Failed to create task: ${result.error}`;
}
```

### Step 5: System prompt — Add task creation guidance for staff

**File:** `src/services/openai.service.ts`

Add to the staff system prompt section:
```
**Creating Tasks**:
- When a staff member asks to create a task, first ask for:
  1. Which client or lead it's for (then search to resolve their ID)
  2. The task type (call get_task_types to show options)
  3. The tax year
- The primary representative is automatically set to the staff member.
- Optionally ask for a description/notes.
- Only call create_task once all required fields are gathered.
```

---

## Conversational Flow (Example)

```
Staff:  Create a task for Maheshwar
Bot:    I found Maheshwar LIMITED. What type of task would you like to create?
        Here are the available types:
        1. OTP and added to Client CRM List
        2. Tax Return Filing
        3. Payroll Processing
        ...
Staff:  OTP and added to Client CRM List
Bot:    Which tax year is this for?
Staff:  2025
Bot:    I've created the task:
        - Client: Maheshwar LIMITED
        - Type: OTP and added to Client CRM List
        - Tax Year: 2025
        - Assigned to: You
```

---

## File Changes Summary

| File | Change |
|------|--------|
| `src/services/dynamics.service.ts` | Add `getTaskTypes()`, `createTask()`, `searchLeadByName()` |
| `src/services/openai.service.ts` | Add tool definitions, tool handlers, update `staffTools`, update staff system prompt |

**No new files needed.** Two existing files modified.

---

## Resolved Questions

1. **Tax Year option set values** — Confirmed. Formula: `463630000 + (year - 2015)`. Range: 2015–2028.
2. **Regarding object binding** — Confirmed. `Contact_Tasks` -> `regardingobjectid_contact_task@odata.bind: "/contacts(<guid>)"`, `new_lead_Tasks` -> `regardingobjectid_new_lead_task@odata.bind: "/new_leads(<guid>)"`.
3. **Task type caching** — Will cache in memory on first fetch.
