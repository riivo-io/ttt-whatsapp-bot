import OpenAI from 'openai';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { dynamicsService } from './dynamics.service';
import { pdfService, InvoiceData, mapInvoiceToInvoiceData } from './pdf.service';
import { metaWhatsAppService } from './meta.service';
import { hasPendingUpload, savePendingUpload, peekPendingUpload, clearPendingUpload } from '../routes/upload.route';

dotenv.config();

/**
 * Maps internal tool names to the permission keys stored in role_tools.tool_name.
 * A staff user can invoke an internal tool only if its permission is in the
 * session's permitted_tools array. Tools not listed here are NOT staff-gated
 * (e.g. client-only tools like refer_friend, or unknown-user tools like
 * verify_identity) and are filtered by role-type instead.
 */
const STAFF_TOOL_PERMISSIONS: Record<string, string> = {
    create_lead: 'create_lead',
    create_case: 'create_case',
    create_task: 'create_task',
    get_task_types: 'create_task',                 // supporting tool for create_task flow
    search_contact_by_name: 'lookup_client',
    search_lead_by_name: 'lookup_lead',
    get_my_clients: 'lookup_client',
    get_my_leads: 'lookup_lead',
    get_client_details: 'lookup_client',
    get_client_cases: 'view_open_cases',
    get_case_by_name: 'view_open_cases',
    get_client_invoices: 'view_outstanding_invoices',
    get_outstanding_balance: 'view_outstanding_invoices',
    get_invoice_pdf: 'send_invoice_pdf',
    send_invoice_pdf: 'send_invoice_pdf',
    upload_letter_of_engagement: 'upload_letter_of_engagement',
    create_contact: 'create_contact',
    create_invoice: 'create_invoice',
    // get_industries is a supporting lookup used by both create_lead and create_contact.
    // Intentionally NOT gated here so it stays available whenever the staff has either
    // create permission. It only returns harmless reference data on its own.
};

const BASE_SYSTEM_PROMPT = `You are a helpful South African Tax Expert assistant for TTT (The Tax Team).
Your role is to provide accurate, helpful advice about South African tax matters.
You also have access to the user's TTT account information (Invoices and Support Cases) via tools.

**Distinguish clearly between General Tax Questions and CRM Data Requests**:
- If the user asks 'What are the rates?' or 'Double check the brackets', answer from your GENERAL KNOWLEDGE. Do NOT check the user's specific records.
- If the user asks you to "double check" a FACT, verify your internal knowledge first. Do not default to checking CRM records unless the topic is specifically about the user's file (e.g., "Double check my invoice status").
- ONLY use the available tools if the user explicitly asks about THEIR data (e.g. "Do *I* have invoices?", "What is *my* case status?").

**Consultant Callback Requests**:
- If the user wants to speak to a consultant, talk to a human, needs personal assistance, or wants someone to call them back, use the request_consultant_callback tool.
- After submitting the request, relay the confirmation message from the tool response.

**WhatsApp Opt-Out**:
- If the user explicitly wants to stop receiving WhatsApp messages, unsubscribe, or opt out, use the opt_out_whatsapp tool.
- Confirm their opt-out was successful and let them know they can message again anytime to opt back in.

**CRM Data**:
- If the tool returns no data, inform the user politely that you couldn't find any records.
- For Invoices: Mention the invoice number, amount, and status.
- For Cases: Mention the Title (Name), Process, and Stage. **DO NOT** output the Case ID (GUID).

**Tool Errors & Ambiguity — MUST follow these rules**:
- If a tool response contains \`error: "multiple_matches"\` and a \`candidates\` list, show the candidate names (and mobile numbers if helpful) back to the user and ask which one they mean. Do NOT pick one yourself. **When the user picks one, you MUST re-call the SAME tool with the \`client\` argument set to the chosen candidate's \`id\` (the GUID, e.g. "50334bea-1a00-f111-88b4-002248a29481"), NOT the name. Re-using the name will trigger the same ambiguous result and you will loop forever.**
- **CONTEXT RE-USE — VERY IMPORTANT.** When a tool response contains a \`client_id\` (GUID) and \`client_name\`, that means a specific client was successfully resolved. For any FOLLOW-UP calls in the same conversation about the same person ("can you also show me their cases", "send them an invoice", "what about their balance"), you MUST reuse that exact \`client_id\` GUID as the \`client\` argument. Do NOT re-look up the same person by name — they may be one of several people with that name, and re-looking up will cause an ambiguous-match loop.
- If a tool response contains \`error: "not_found"\`, tell the user clearly you couldn't find a match for exactly what they gave you, and ask for more information — full name, phone number, or offer to list their clients.
- If a tool response contains \`error: "lookup_failed"\` or any other error, state clearly that the CRM had an issue looking that up, and suggest they try again or ask you to list their clients instead.
- Never silently return an empty result when the real problem was an unresolved lookup. Always say specifically *why* you couldn't complete the action.

**Format Guidelines (CRITICAL)**:
- Responses MUST be short (under 150 words) and optimized for WhatsApp.
- **Formatting**:
  - WhatsApp uses SINGLE asterisks for bold (e.g., *bold*). **DO NOT** use double asterisks (**bold**).
  - Use _italics_ for emphasis.
  - NO Markdown headers (#). Just use *bold text* for emphasis where needed.
- Get straight to the point. Avoid fluff.
- Use max 3 bullet points if listing.
- Short sentences.
- No "Hope this helps" or generic closers.
- NEVER write a message that sounds like you will send another message after (e.g. "Please hold on a moment", "Let me check that for you", "One moment please"). Every message you send is FINAL — the user will not receive a follow-up unless they message again. If you are calling a tool, the result will be included in your response automatically — do not promise a follow-up.
- Use South African English spelling (e.g. colour, favour, organise, analyse, centre, licence, practise, defence, catalogue, cheque).

**Tax Guidelines**:
- Always be professional and courteous
- When recommending professional help, mention that *our team at TTT* can assist (e.g., "One of our tax practitioners at TTT can help you with this" or "For personalized advice, our TTT consultants are available to assist")
- Do NOT say "consult a registered tax practitioner" - instead, promote TTT's services`;

// Tool Definitions
const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
        type: "function",
        function: {
            name: "get_my_details",
            description: "Use when the user asks for their details on file, profile information, personal info, or wants to see what data you have about them. Do NOT use this for invoices or cases.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_client_invoices",
            description: "Get invoices. For clients, returns their own invoices. For staff, provide a client name or phone to look up their invoices.",
            parameters: {
                type: "object",
                properties: {
                    client: {
                        type: "string",
                        description: "Client name or phone number (staff only — not needed for clients viewing their own)"
                    }
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_client_cases",
            description: "Get cases. For clients, returns their own cases. For staff, returns cases they own as consultant. Optionally provide a client name or phone to look up a specific client's cases.",
            parameters: {
                type: "object",
                properties: {
                    client: {
                        type: "string",
                        description: "Client name or phone number (optional — to look up a specific client's cases)"
                    }
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_invoice_pdf",
            description: "Use this when the user wants to VIEW or DOWNLOAD a PDF of a specific invoice for themselves. Returns a link. Do NOT use this to send an invoice to a client — use send_invoice_pdf for that.",
            parameters: {
                type: "object",
                properties: {
                    invoice_number: {
                        type: "string",
                        description: "The invoice number (e.g. INV123)"
                    }
                },
                required: ["invoice_number"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "send_invoice_pdf",
            description: "Staff-only: DELIVER an invoice PDF to a specific client via WhatsApp. Requires the invoice number AND which client to send it to (name or phone number). Fetches the invoice, generates the PDF, sends as a WhatsApp document message, and logs the send to the client's timeline. Do NOT use this when the staff just wants to preview the PDF — use get_invoice_pdf for that.",
            parameters: {
                type: "object",
                properties: {
                    invoice_number: {
                        type: "string",
                        description: "The invoice number to send (e.g. INV123)"
                    },
                    client: {
                        type: "string",
                        description: "The client to send to — their name or phone number. Will be resolved to a Contact record."
                    }
                },
                required: ["invoice_number", "client"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_tax_number",
            description: "Use this when the user asks for their tax number, tax reference number, or income tax number.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "request_consultant_callback",
            description: "Use this when the client wants to speak to their consultant, talk to a human, needs personal assistance, or wants someone to call them back.",
            parameters: {
                type: "object",
                properties: {
                    reason: {
                        type: "string",
                        description: "Optional reason why they want to speak to a consultant"
                    }
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "opt_out_whatsapp",
            description: "Use this when the user wants to stop receiving WhatsApp messages, unsubscribe, or opt out of communications.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "create_case",
            description: "Create a new case in the CRM. Gather ALL required info from the user BEFORE calling: case_type, description, and priority. For staff users, also ask which client and use search_contact_by_name first to get their contact ID.",
            parameters: {
                type: "object",
                properties: {
                    case_type: {
                        type: "string",
                        enum: ["Claim", "Query", "Complaint", "Admin", "Other"],
                        description: "The type of case"
                    },
                    description: {
                        type: "string",
                        description: "Brief description of the case"
                    },
                    priority: {
                        type: "string",
                        enum: ["High", "Medium", "Low"],
                        description: "Priority level"
                    },
                    client: {
                        type: "string",
                        description: "The client's name or phone number to link the case to. Required for staff users. Not needed for clients (auto-linked)."
                    }
                },
                required: ["case_type", "description", "priority"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_my_clients",
            description: "Use when a staff member asks to see their CLIENTS — confirmed contacts they own. Do NOT use this for leads or prospects. Returns contacts assigned to them.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_my_leads",
            description: "Use when a staff member asks to see their LEADS — prospects in the onboarding pipeline that they own as consultant. Leads and clients are different: clients are confirmed contacts, leads are not yet clients. Returns each lead's id, full name, mobile number, and email. This is ALL the lead info we have — do NOT then call get_client_details for a lead (leads are not contacts and get_client_details will return nothing). Just answer from what this tool returns.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "search_contact_by_name",
            description: "Search for a contact by name. Use this when a staff member needs to find a client. Returns matching contacts with their IDs.",
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "The client name to search for (partial match supported)"
                    }
                },
                required: ["name"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_client_details",
            description: "Get a specific CLIENT's (contact record) full profile: name, phone, email, ID number, tax number. For staff to look up any confirmed client. Do NOT use this for LEADS — leads live in a separate entity and this tool will not find them. For lead info, use search_lead_by_name or get_my_leads, which already return complete lead details.",
            parameters: {
                type: "object",
                properties: {
                    client: {
                        type: "string",
                        description: "Client name or phone number"
                    }
                },
                required: ["client"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_case_by_name",
            description: "Search for a specific case by name or reference (e.g. 'Lloyd Pienaar - 2025'). Returns case details including stage, process, and status.",
            parameters: {
                type: "object",
                properties: {
                    case_name: {
                        type: "string",
                        description: "The case name or partial name to search for"
                    }
                },
                required: ["case_name"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_outstanding_balance",
            description: "Get the total outstanding (unpaid) invoice amount for a client. For clients, returns their own balance. For staff, provide a client name or phone.",
            parameters: {
                type: "object",
                properties: {
                    client: {
                        type: "string",
                        description: "Client name or phone number (staff only — not needed for clients)"
                    }
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "create_lead",
            description: "Create a new lead (prospect) in the CRM. Before calling, you MUST gather: first name, last name, client_type, lead_type, and the industry. Use get_industries to resolve the industry to a GUID — ask the staff member what industry the lead is in, then call get_industries with a name_filter to find a match. Phone, email, and notes are optional.",
            parameters: {
                type: "object",
                properties: {
                    first_name: { type: "string", description: "Lead's first name" },
                    last_name: { type: "string", description: "Lead's last name" },
                    client_type: {
                        type: "string",
                        enum: ["Individual", "Business", "Private Company", "Closed Corporation", "Business Trust", "Sole Proprietorship"],
                        description: "What kind of entity the lead is. Ask the staff member."
                    },
                    lead_type: {
                        type: "string",
                        enum: ["Tax", "Accounting", "Long Term Insurance", "Short Term Insurance"],
                        description: "Which TTT service line this lead is for. Ask the staff member."
                    },
                    industry_id: {
                        type: "string",
                        description: "GUID of the lead's industry from riivo_industries. MUST be resolved via get_industries first — do not invent."
                    },
                    phone: { type: "string", description: "Lead's phone number (optional)" },
                    email: { type: "string", description: "Lead's email address (optional)" },
                    notes: { type: "string", description: "Any additional notes (optional)" }
                },
                required: ["first_name", "last_name", "client_type", "lead_type", "industry_id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "refer_friend",
            description: "Client wants to refer a friend or family member. Creates a lead linked to the referring client. Ask for the friend's name, phone number, email address, and which service they need.",
            parameters: {
                type: "object",
                properties: {
                    friend_name: { type: "string", description: "The friend's full name" },
                    friend_phone: { type: "string", description: "The friend's phone number" },
                    friend_email: { type: "string", description: "The friend's email address" },
                    service: {
                        type: "string",
                        enum: ["Insurance", "Tax", "Accounting", "Financial Planning", "Not sure"],
                        description: "Which service they're interested in"
                    }
                },
                required: ["friend_name", "friend_phone", "friend_email", "service"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "verify_identity",
            description: "Look up a person by their South African ID number to find their account. Use when an unknown caller provides their ID number.",
            parameters: {
                type: "object",
                properties: {
                    id_number: { type: "string", description: "The 13-digit SA ID number" }
                },
                required: ["id_number"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "create_task",
            description: "Create a new task in the CRM for a client or lead. Gather ALL required info before calling: the client/lead (resolve their ID first using search_contact_by_name or search_lead_by_name), task type (use get_task_types to show options), and tax year. The primary representative is automatically set to the staff member.",
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
                        description: "The GUID of the selected task type from get_task_types."
                    },
                    task_type_name: {
                        type: "string",
                        description: "The display name of the task type (used for the subject line)."
                    },
                    tax_year: {
                        type: "number",
                        description: "The tax year as a 4-digit number (e.g. 2025)."
                    },
                    description: {
                        type: "string",
                        description: "Optional notes or description for the task."
                    }
                },
                required: ["client_or_lead", "entity_type", "task_type_id", "task_type_name", "tax_year"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_task_types",
            description: "Get the list of available task types. Use this when a staff member wants to create a task, so they can pick the correct type.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "search_lead_by_name",
            description: "Search for a lead by name. Scoped to leads owned by the calling staff member. Returns each match's id, full name, and mobile number — that is the COMPLETE lead info we expose. Do NOT then call get_client_details for any of the results (leads are not contacts and that tool won't find them). If nothing comes back, the tool will tell you and you should offer to create a new lead via create_lead.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "The lead name to search for (partial match supported)" }
                },
                required: ["name"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "save_document",
            description: "Save an uploaded document after the user has classified its type. The user uploads a file, then you ask what type it is (ID Document, Payslip, Bank Statement, Tax Certificate, Other). For staff, also ask which client it's for. Call this once you have the document type (and client for staff).",
            parameters: {
                type: "object",
                properties: {
                    doc_type: {
                        type: "string",
                        enum: ["ID Document", "Payslip", "Bank Statement", "Tax Certificate", "Other"],
                        description: "The type of document"
                    },
                    client: {
                        type: "string",
                        description: "Client name or phone (staff only — clients auto-link to themselves)"
                    }
                },
                required: ["doc_type"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_industries",
            description: "Search the TTT industry list for a lead or contact. Pass a name_filter (e.g. 'doctor', 'tax') to narrow down. Use this BEFORE create_lead or create_contact so you can resolve the industry name the staff member gave you to a GUID. If multiple matches come back, ask the staff member to disambiguate.",
            parameters: {
                type: "object",
                properties: {
                    name_filter: {
                        type: "string",
                        description: "Substring to match against industry name. Optional — omit to fetch the first 50 industries alphabetically (rarely useful)."
                    }
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "create_contact",
            description: "Create a new contact (client) in the CRM. Before calling, you MUST gather: first name, last name, entity_type, and the industry. Use get_industries to resolve the industry to a GUID. The Consultant (owner) and Primary TTT Representative both default to the staff member calling — do not ask for them.",
            parameters: {
                type: "object",
                properties: {
                    first_name: { type: "string", description: "Contact's first name" },
                    last_name: { type: "string", description: "Contact's last name" },
                    entity_type: {
                        type: "string",
                        enum: ["Individual", "Business", "Private Company", "Closed Corporation", "Business Trust", "Sole Proprietorship"],
                        description: "What kind of entity the contact is. Ask the staff member."
                    },
                    industry_id: {
                        type: "string",
                        description: "GUID of the contact's industry from riivo_industries. MUST be resolved via get_industries first."
                    },
                    phone: { type: "string", description: "Contact's mobile number (optional)" },
                    email: { type: "string", description: "Contact's email address (optional)" }
                },
                required: ["first_name", "last_name", "entity_type", "industry_id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "create_invoice",
            description: "Create a new invoice for an existing client. Before calling, you MUST resolve the customer to a Contact GUID via search_contact_by_name (the bot only supports invoicing Contacts, not Accounts). Then ask the staff member which type of invoice it is (Tax or Accounting). The Consultant (owner) defaults to the staff member calling.",
            parameters: {
                type: "object",
                properties: {
                    customer_contact_id: {
                        type: "string",
                        description: "Contact GUID of the customer. MUST come from search_contact_by_name — never invent."
                    },
                    invoice_type: {
                        type: "string",
                        enum: ["Tax", "Accounting"],
                        description: "Which type of invoice this is. Ask the staff member."
                    }
                },
                required: ["customer_contact_id", "invoice_type"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "upload_letter_of_engagement",
            description: "Attach a signed Letter of Engagement (PDF) to a specific lead. Use ONLY after: (1) the staff member has indicated they want to upload an LOE, (2) you've confirmed the target lead via search_lead_by_name, and (3) the staff member has uploaded a file. Will refuse non-PDF files.",
            parameters: {
                type: "object",
                properties: {
                    lead_id: {
                        type: "string",
                        description: "The new_leadid GUID of the lead to attach the LOE to."
                    },
                    lead_name: {
                        type: "string",
                        description: "The lead's full name (for confirmation in the response)."
                    }
                },
                required: ["lead_id", "lead_name"],
            },
        },
    }
];

export class OpenAIService {
    private openai: OpenAI | null = null;

    constructor() {
        if (process.env.OPENAI_API_KEY) {
            this.openai = new OpenAI({
                apiKey: process.env.OPENAI_API_KEY,
                fetch: fetch as unknown as typeof globalThis.fetch,
            });
        }
    }

    private getClient(): OpenAI | null {
        return this.openai;
    }

    async generateResponse(userMessage: string, contactId?: string, phoneNumber?: string, history: { role: 'user' | 'assistant', content: string }[] = [], entityType?: 'client' | 'lead' | 'user', permittedToolKeys: string[] = [], userFullName?: string): Promise<string> {
        const client = this.getClient();

        if (!client) {
            return "🔧 **Demo Mode**: OpenAI API key missing. Cannot access CRM functions.";
        }

        try {
            const currentDate = new Date().toDateString();

            // Build role-specific context
            const isFirstMessage = history.length === 0;
            const firstMessageInstruction = isFirstMessage
                ? `\n\n**IMPORTANT: This is the user's FIRST message in this conversation.** Introduce yourself as the TTT Tax Assistant and clearly explain what you can help them with based on their role. Be warm and friendly. List their available capabilities as bullet points so they know exactly what's possible.`
                : '';

            // First name for friendly greetings ("Hi Luc" rather than "Hi Luc Duval")
            const firstName = userFullName ? userFullName.trim().split(/\s+/)[0] : '';
            const nameLine = userFullName ? `\n\n**User's full name:** ${userFullName}. Address them by their first name (${firstName}) in greetings.` : '';

            let roleContext = '';
            if (entityType === 'client') {
                roleContext = `\n\n**User Role: CLIENT**\nThis is a registered TTT client. They have full access to their invoices, cases, tax number, consultant callbacks, and opt-out. Address them as a valued client.${isFirstMessage ? `\n\nIn your introduction, let them know you can help with:\n- Viewing their invoices and outstanding balance\n- Checking the status of their tax cases\n- Looking up their tax number\n- Requesting a callback from their consultant\n- Uploading documents (IRP5s, bank statements, etc.)\n- Referring a friend or family member to TTT` : ''}`;
            } else if (entityType === 'lead') {
                roleContext = `\n\n**User Role: LEAD (Prospective Client)**\nThis is a prospective client (lead) in the onboarding pipeline. They are NOT yet a TTT client.\n\n**CRITICAL RULE: Do NOT answer any tax questions, give tax advice, or provide tax information.** If they ask tax-related questions, politely let them know that tax assistance is available to registered TTT clients, and encourage them to complete their onboarding to become a client. Direct them to sign up at ${process.env.SIGNUP_URL || 'https://app.ttt-tax.co.za/signup'} if needed.\n\nWhat you CAN do for leads:\n- Help them upload onboarding documents (ID, payslips, bank statements, tax certificates)\n- Answer questions about the onboarding process and what documents are needed\n- Explain what TTT offers and the benefits of becoming a client\n- Encourage them to complete their sign-up${isFirstMessage ? `\n\nIn your introduction, welcome them to TTT, let them know you're here to help them get set up, and list what you can assist with. Also mention that once they become a registered client, they'll unlock full access to invoice lookups, case tracking, consultant callbacks, and more.` : ''}`;
            } else if (entityType === 'user') {
                // Build the staff capability list DYNAMICALLY from permitted_tools.
                // This ensures the AI only advertises (and acts on) tools the
                // user's role actually allows.
                const capabilityBulletMap: Record<string, string> = {
                    lookup_client: 'Searching for clients by name or phone number',
                    lookup_lead: 'Searching for leads (prospects) by name',
                    view_outstanding_invoices: 'Viewing any client\'s invoices and outstanding balance',
                    view_open_cases: 'Viewing any client\'s cases',
                    create_case: 'Creating new cases for clients',
                    create_task: 'Creating new tasks for clients or leads',
                    create_lead: 'Creating new leads (prospects)',
                    create_contact: 'Creating new contacts',
                    create_invoice: 'Creating invoices',
                    send_invoice_pdf: 'Sending invoice PDFs to clients',
                    upload_letter_of_engagement: 'Uploading signed Letters of Engagement for leads',
                };
                const capabilityBullets = permittedToolKeys
                    .map(k => capabilityBulletMap[k])
                    .filter(Boolean)
                    .map(line => `- ${line}`)
                    .join('\n');

                const taskInstructions = permittedToolKeys.includes('create_task')
                    ? `\n\n**Creating Tasks**:\n- When a staff member asks to create a task, first ask for:\n  1. Which client or lead it's for (then use search_contact_by_name or search_lead_by_name to resolve their ID)\n  2. The task type (call get_task_types to show available options)\n  3. The tax year (e.g. 2025)\n  4. Any notes/description (optional)\n- The primary representative is automatically set to the staff member.\n- Only call create_task once ALL required fields are gathered.`
                    : '';

                roleContext = `\n\n**User Role: TTT STAFF**\nThis is an internal TTT staff member. Treat them as a colleague. Staff ask on behalf of THEIR clients — if they say "my clients" or "my cases", they mean clients/cases they own as the consultant. Freely use the available tools for any reasonable staff request; do not second-guess whether they "should" have access — the available tools list has already been filtered to match their permissions.\n\nYour permitted capabilities for this user:\n${capabilityBullets || '(none)'}\n\nOnly decline if the user explicitly asks for a capability that is clearly NOT in the list above (e.g. they ask you to send an SMS when that's not a listed capability). In that case, politely tell them they don't have access to that specific feature and suggest contacting their administrator. Otherwise, just use the tools available to you.${taskInstructions}${isFirstMessage ? `\n\nIn your introduction, greet them as a colleague and list the capabilities above as bullet points. Do NOT mention any capability not in the list.` : ''}`;
            } else {
                roleContext = `\n\n**User Role: UNKNOWN**\nThis person's phone number was not found in our system. Greet them warmly and ask them to provide their 13-digit South African ID number so you can look them up using verify_identity. If they can't be found by ID number, let them know a consultant will be in touch, or they can sign up at https://app.ttt-tax.co.za/signup`;
            }

            roleContext += nameLine + firstMessageInstruction;

            // If there's a pending file upload, append upload-specific guidance.
            // MUST happen before systemPrompt is built, otherwise the AI never
            // sees the nudge and defaults to the wrong tool (e.g. search_contact_by_name
            // instead of search_lead_by_name for an LOE upload).
            if (phoneNumber && hasPendingUpload(phoneNumber)) {
                if (entityType === 'user') {
                    // Staff have only one upload path: signed LOE for a lead.
                    roleContext += `\n\n**PENDING DOCUMENT — IMPORTANT**: The staff member has just uploaded a file. The ONLY document upload available to staff is a signed Letter of Engagement, which attaches to a LEAD (not a contact/client). Follow this flow exactly:\n1. Ask which lead the LOE is for if not already clear.\n2. Use **search_lead_by_name** (NOT search_contact_by_name — leads and clients are different entities). If multiple matches, ask the staff to disambiguate.\n3. Call **upload_letter_of_engagement** with the resolved lead_id.\nThe file must be a PDF. Do not use save_document — that tool is not available to staff.`;
                } else {
                    roleContext += `\n\n**PENDING DOCUMENT**: The user has uploaded a file. Ask them what type of document it is: ID Document, Payslip, Bank Statement, Tax Certificate, or Other. Then call save_document with the doc_type.`;
                }
            }

            const systemPrompt = `Current Date: ${currentDate}\n${BASE_SYSTEM_PROMPT}${roleContext}`;

            const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
                { role: 'system', content: systemPrompt },
                ...history, // Prepend conversation history
                { role: 'user', content: userMessage },
            ];

            // Filter tools by role
            const clientTools = ['get_my_details', 'get_client_invoices', 'get_client_cases', 'get_invoice_pdf', 'get_tax_number', 'get_outstanding_balance', 'request_consultant_callback', 'opt_out_whatsapp', 'refer_friend', 'save_document'];
            const staffTools = ['get_my_clients', 'get_my_leads', 'get_client_details', 'get_client_invoices', 'get_client_cases', 'get_case_by_name', 'get_outstanding_balance', 'search_contact_by_name', 'create_case', 'create_lead', 'create_contact', 'create_invoice', 'create_task', 'get_task_types', 'get_industries', 'search_lead_by_name', 'get_invoice_pdf', 'send_invoice_pdf', 'upload_letter_of_engagement'];
            const leadTools = ['save_document'];
            const unknownTools = ['verify_identity'];

            let availableTools: typeof TOOLS | undefined;
            if (contactId && entityType === 'client') {
                availableTools = TOOLS.filter(t => clientTools.includes((t as any).function.name));
            } else if (entityType === 'user') {
                // Staff: start from staffTools, then apply role-based filter using
                // the permitted_tools list loaded from the session (role_tools table).
                // If a tool isn't in STAFF_TOOL_PERMISSIONS it's not staff-gated and
                // stays available. If it is, keep it only if its permission is permitted.
                availableTools = TOOLS.filter(t => {
                    const name = (t as any).function.name;
                    if (!staffTools.includes(name)) return false;
                    const perm = STAFF_TOOL_PERMISSIONS[name];
                    if (!perm) return true;
                    return permittedToolKeys.includes(perm);
                });
            } else if (entityType === 'lead') {
                availableTools = TOOLS.filter(t => leadTools.includes((t as any).function.name));
            } else {
                // Unknown users
                availableTools = TOOLS.filter(t => unknownTools.includes((t as any).function.name));
            }

            // When a staff member has a pending document upload, the only valid
            // next action is "identify the target lead and attach the LOE". Strip
            // contact-lookup and client-data tools from the available list so the
            // AI physically cannot pick the wrong path (e.g. search_contact_by_name
            // for what is meant to be a lead lookup). Prompt-only guidance wasn't
            // enough — gpt-4o-mini kept reaching for search_contact_by_name.
            if (entityType === 'user' && phoneNumber && hasPendingUpload(phoneNumber) && availableTools) {
                const allowedDuringUpload = new Set([
                    'search_lead_by_name',
                    'get_my_leads',
                    'upload_letter_of_engagement',
                    'create_lead',           // fallback if the lead doesn't exist yet
                    'get_industries',        // supporting tool for create_lead
                ]);
                const before = availableTools.length;
                availableTools = availableTools.filter(t => allowedDuringUpload.has((t as any).function.name));
                console.log(`[OpenAI] Pending LOE upload detected — restricted tool surface from ${before} to ${availableTools.length} tools`);
            }

            // When the caller is staff, restrict contact lookups to clients they own.
            // Scoped here so both the first-round and follow-up tool handlers can use it.
            const ownerFilter = entityType === 'user' ? contactId : undefined;

            // 1. First Call: Natural Language or Function Call
            const completion = await client.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: messages,
                tools: availableTools && availableTools.length > 0 ? availableTools : undefined,
                ...(availableTools && availableTools.length > 0 ? { tool_choice: 'auto' as const } : {}),
                max_tokens: 500,
                temperature: 0.7,
            });

            const responseMessage = completion.choices[0]?.message;

            // 2. Handle Function Calls
            if (responseMessage?.tool_calls) {
                // Append the assistant's decision to call tools to history
                messages.push(responseMessage);

                // ---- Choice option-set value maps (Power Apps Choice → integer) ----
                // Lead's riivo_clienttype and Contact's riivo_clienttypeindbus share
                // the global "Client Type" choice set.
                const CLIENT_TYPE_VALUES: Record<string, number> = {
                    'Individual': 0,
                    'Business': 1,
                    'Private Company': 2,
                    'Closed Corporation': 3,
                    'Business Trust': 4,
                    'Sole Proprietorship': 5,
                };
                // Lead's riivo_leadtype is the global "Lead Types" choice set.
                const LEAD_TYPE_VALUES: Record<string, number> = {
                    'Tax': 100000000,
                    'Accounting': 100000001,
                    'Long Term Insurance': 463630001,
                    'Short Term Insurance': 463630002,
                };
                // Invoice's riivo_invoicetype.
                const INVOICE_TYPE_VALUES: Record<string, number> = {
                    'Tax': 100000000,
                    'Accounting': 100000001,
                };

                // Helper: dispatch create_lead. Hoisted so the follow-up loop can call it too.
                const handleCreateLead = async (toolCall: any): Promise<string> => {
                    const args = JSON.parse(toolCall.function.arguments || '{}');
                    if (!contactId) {
                        return JSON.stringify({ status: 'error', message: 'No staff identity on session — cannot set lead owner.' });
                    }
                    const clientTypeValue = CLIENT_TYPE_VALUES[args.client_type];
                    const leadTypeValue = LEAD_TYPE_VALUES[args.lead_type];
                    if (clientTypeValue === undefined) {
                        return JSON.stringify({ status: 'error', message: `Unknown client_type "${args.client_type}". Must be one of: ${Object.keys(CLIENT_TYPE_VALUES).join(', ')}.` });
                    }
                    if (leadTypeValue === undefined) {
                        return JSON.stringify({ status: 'error', message: `Unknown lead_type "${args.lead_type}". Must be one of: ${Object.keys(LEAD_TYPE_VALUES).join(', ')}.` });
                    }
                    const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                    if (!args.industry_id || !guidRegex.test(String(args.industry_id))) {
                        return JSON.stringify({ status: 'error', message: 'industry_id must be a GUID returned by get_industries. Run get_industries first to resolve the industry name.' });
                    }
                    const result = await dynamicsService.createLead({
                        firstName: args.first_name,
                        lastName: args.last_name,
                        phone: args.phone,
                        email: args.email,
                        notes: args.notes,
                        clientType: clientTypeValue,
                        leadType: leadTypeValue,
                        industryId: args.industry_id,
                        ownerSystemUserId: contactId,
                    });
                    if (result) {
                        return JSON.stringify({
                            status: 'success',
                            lead_id: result.new_leadid,
                            message: `Lead ${args.first_name} ${args.last_name} created successfully.`,
                        });
                    }
                    return JSON.stringify({ status: 'error', message: 'Failed to create the lead. Check the server logs for the Dynamics error.' });
                };

                // Helper: dispatch create_contact.
                const handleCreateContact = async (toolCall: any): Promise<string> => {
                    const args = JSON.parse(toolCall.function.arguments || '{}');
                    if (!contactId) {
                        return JSON.stringify({ status: 'error', message: 'No staff identity on session — cannot set contact owner.' });
                    }
                    const entityTypeValue = CLIENT_TYPE_VALUES[args.entity_type];
                    if (entityTypeValue === undefined) {
                        return JSON.stringify({ status: 'error', message: `Unknown entity_type "${args.entity_type}". Must be one of: ${Object.keys(CLIENT_TYPE_VALUES).join(', ')}.` });
                    }
                    const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                    if (!args.industry_id || !guidRegex.test(String(args.industry_id))) {
                        return JSON.stringify({ status: 'error', message: 'industry_id must be a GUID returned by get_industries.' });
                    }
                    const result = await dynamicsService.createContact({
                        firstName: args.first_name,
                        lastName: args.last_name,
                        entityType: entityTypeValue,
                        industryId: args.industry_id,
                        ownerSystemUserId: contactId,
                        primaryRepSystemUserId: contactId,
                        phone: args.phone,
                        email: args.email,
                    });
                    if (result?.contactid) {
                        return JSON.stringify({
                            status: 'success',
                            contact_id: result.contactid,
                            message: `Contact ${args.first_name} ${args.last_name} created successfully.`,
                        });
                    }
                    return JSON.stringify({ status: 'error', message: 'Failed to create the contact. Check the server logs for the Dynamics error.' });
                };

                // Helper: dispatch create_invoice.
                const handleCreateInvoice = async (toolCall: any): Promise<string> => {
                    const args = JSON.parse(toolCall.function.arguments || '{}');
                    if (!contactId) {
                        return JSON.stringify({ status: 'error', message: 'No staff identity on session — cannot set invoice owner.' });
                    }
                    const invoiceTypeValue = INVOICE_TYPE_VALUES[args.invoice_type];
                    if (invoiceTypeValue === undefined) {
                        return JSON.stringify({ status: 'error', message: `Unknown invoice_type "${args.invoice_type}". Must be one of: ${Object.keys(INVOICE_TYPE_VALUES).join(', ')}.` });
                    }
                    const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                    if (!args.customer_contact_id || !guidRegex.test(String(args.customer_contact_id))) {
                        return JSON.stringify({ status: 'error', message: 'customer_contact_id must be a Contact GUID resolved via search_contact_by_name.' });
                    }
                    const result = await dynamicsService.createInvoice({
                        customerContactId: args.customer_contact_id,
                        invoiceType: invoiceTypeValue,
                        ownerSystemUserId: contactId,
                    });
                    if (result?.new_invoicesid) {
                        return JSON.stringify({
                            status: 'success',
                            invoice_id: result.new_invoicesid,
                            message: `${args.invoice_type} invoice created successfully.`,
                        });
                    }
                    return JSON.stringify({ status: 'error', message: 'Failed to create the invoice. Check the server logs for the Dynamics error.' });
                };

                // Helper: dispatch get_industries with optional name filter.
                const handleGetIndustries = async (toolCall: any): Promise<string> => {
                    const args = JSON.parse(toolCall.function.arguments || '{}');
                    const industries = await dynamicsService.getIndustries(args.name_filter);
                    if (industries.length === 0) {
                        return JSON.stringify({ status: 'no_match', message: `No industries matched "${args.name_filter || '(no filter)'}". Ask the staff member to try a different keyword or use 'Other'.` });
                    }
                    return JSON.stringify({ status: 'ok', count: industries.length, industries });
                };

                // Helper: handle the send_invoice_pdf tool call.
                // Orchestrates the 6-step flow (resolve client → fetch invoice →
                // generate PDF → send via Meta → log timeline note). Every
                // failure mode returns a structured status so the AI can surface
                // a clear message to staff. Dry-run mode (no Meta creds) is
                // handled transparently inside metaWhatsAppService.sendDocument.
                const handleSendInvoicePdf = async (toolCall: any): Promise<string> => {
                    const args = JSON.parse(toolCall.function.arguments || '{}');
                    const invoiceNum: string | undefined = args.invoice_number;
                    const clientInput: string | undefined = args.client;
                    if (!invoiceNum || !clientInput) {
                        return JSON.stringify({ status: 'error', message: 'Both invoice_number and client are required.' });
                    }
                    if (!contactId) {
                        return JSON.stringify({ status: 'error', message: 'No staff identity on session — cannot log invoice-send note.' });
                    }

                    // 1. Resolve the client to a Contact GUID. Inlined (rather
                    //    than reusing resolveClientDetailed) because this helper
                    //    is hoisted above the scope where that resolver lives,
                    //    and the logic is small enough not to justify further
                    //    refactoring right now.
                    let clientId: string | null = null;
                    let clientFullname: string = '';
                    const inputTrimmed = clientInput.trim();
                    const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                    if (guidRegex.test(inputTrimmed)) {
                        clientId = inputTrimmed;
                    } else {
                        try {
                            // Phone-shaped input: try contact-by-phone directly,
                            // then fall back to getContactByPhone. This avoids
                            // the multi-table priority issue where a phone that
                            // also matches a systemuser/lead wins over the contact.
                            const phoneShaped = /^[+0-9\s]+$/.test(inputTrimmed) && inputTrimmed.replace(/\D/g, '').length >= 9;
                            if (phoneShaped) {
                                const contactDirect = await dynamicsService.getContactByPhoneAndType(inputTrimmed, 'client');
                                if (contactDirect) {
                                    clientId = contactDirect.id;
                                    clientFullname = contactDirect.fullname || '';
                                }
                            }
                            if (!clientId) {
                                const byPhone = await dynamicsService.getContactByPhone(inputTrimmed);
                                if (byPhone?.type === 'client') {
                                    clientId = byPhone.id;
                                    clientFullname = byPhone.fullname || '';
                                }
                            }
                            if (!clientId) {
                                const matches = await dynamicsService.searchContactByName(inputTrimmed, ownerFilter);
                                console.log(`[send_invoice_pdf] searchContactByName("${inputTrimmed}", owner=${ownerFilter || 'none'}) → ${matches.length} match(es)`);
                                if (matches.length === 0) {
                                    return JSON.stringify({ status: 'client_not_found', message: `No client matched "${clientInput}". Ask the staff to clarify — full name or phone number.` });
                                }
                                if (matches.length > 1) {
                                    // Auto-resolve when only one candidate has a usable
                                    // mobile number — the others physically cannot receive
                                    // a WhatsApp document, so making the staff disambiguate
                                    // between them is wasted friction.
                                    const withMobile = matches.filter((m: any) => m.mobilephone && String(m.mobilephone).trim().length > 0);
                                    if (withMobile.length === 1) {
                                        console.log(`[send_invoice_pdf] Auto-resolved ambiguity: only ${withMobile[0].fullname} has a mobile; picking that contact.`);
                                        clientId = withMobile[0].contactid;
                                        clientFullname = withMobile[0].fullname || '';
                                    } else {
                                        return JSON.stringify({
                                            status: 'client_ambiguous',
                                            candidates: matches.map((m: any) => ({ id: m.contactid, fullname: m.fullname, mobilephone: m.mobilephone })),
                                            message: `Multiple clients match "${clientInput}". Show the candidates (names + phones) to the staff and ask which one. When they pick one, re-call send_invoice_pdf with \`client\` set to that candidate's \`id\` value (the long GUID like "50334bea-1a00-f111-..."). Do NOT pass their name. Do NOT pass their phone number. ONLY the \`id\` GUID will work — anything else will loop back to this same ambiguous response.`,
                                        });
                                    }
                                } else {
                                    clientId = matches[0].contactid;
                                    clientFullname = matches[0].fullname || '';
                                }
                            }
                        } catch (e: any) {
                            return JSON.stringify({ status: 'error', message: `Client lookup failed: ${e?.message || 'unknown error'}` });
                        }
                    }
                    if (!clientId) {
                        return JSON.stringify({ status: 'client_not_found', message: `No client matched "${clientInput}".` });
                    }

                    // 2. Fetch the contact's mobile number from Dynamics.
                    const details = await dynamicsService.getContactDetails(clientId);
                    const clientPhone: string | undefined = details?.mobilephone || undefined;
                    if (!clientPhone) {
                        return JSON.stringify({ status: 'no_whatsapp_number', client_name: clientFullname, message: `${clientFullname || 'The client'} has no mobile number on file, so the PDF cannot be sent. Ask staff to update the client's contact record first.` });
                    }
                    if (!clientFullname && details?.fullname) clientFullname = details.fullname;

                    // 3. Fetch the invoice and generate the PDF.
                    const invoice = await dynamicsService.getInvoiceByNumber(invoiceNum);
                    if (!invoice) {
                        return JSON.stringify({ status: 'invoice_not_found', message: `Invoice ${invoiceNum} could not be found in the CRM. Nothing was sent.` });
                    }
                    let pdfBuffer: Buffer;
                    try {
                        const invoiceData: InvoiceData = mapInvoiceToInvoiceData(invoice);
                        pdfBuffer = await pdfService.generateInvoicePDF(invoiceData);
                    } catch (err: any) {
                        console.error('[send_invoice_pdf] PDF generation failed:', err?.message || err);
                        return JSON.stringify({ status: 'send_failed', message: `PDF generation failed for invoice ${invoiceNum}. Nothing was sent. Please try again.` });
                    }

                    // 4. Send via Meta (or stub in dry-run mode).
                    // Caption includes recipient's first name + sender's name so
                    // the client sees who at TTT initiated the send. Falls back
                    // gracefully if either name is missing.
                    const recipientFirst = clientFullname ? clientFullname.split(/\s+/)[0] : '';
                    const senderName = (userFullName && userFullName.trim()) || 'the team';
                    const greeting = recipientFirst ? `Hi ${recipientFirst}` : 'Hi there';
                    const caption = `${greeting}, ${senderName} from TTT has sent you an invoice. Please find it attached. Thank you.`;
                    const sendResult = await metaWhatsAppService.sendDocument(
                        clientPhone,
                        pdfBuffer,
                        `${invoiceNum}.pdf`,
                        caption
                    );

                    // 5. If Meta reported a real failure (not a dry-run), stop
                    //    here — no timeline note. Dry-run counts as "would have
                    //    delivered" so we still log the audit trail.
                    if (!sendResult.delivered && !sendResult.dryRun) {
                        return JSON.stringify({ status: 'send_failed', message: `WhatsApp delivery failed: ${sendResult.error || 'unknown error'}. The client was not notified and no timeline note was written.` });
                    }

                    // 6. Log the send to the client's Contact timeline.
                    await dynamicsService.logInvoiceSentToContact(clientId, invoiceNum, contactId);

                    const pdfPreviewUrl = `http://localhost:3001/api/pdf/invoice/${invoiceNum}`;
                    return JSON.stringify({
                        status: 'sent',
                        invoice_number: invoiceNum,
                        client_name: clientFullname || 'the client',
                        client_phone: clientPhone,
                        whatsapp_caption: caption,
                        dry_run: Boolean(sendResult.dryRun),
                        pdf_preview_url: pdfPreviewUrl,
                        message: sendResult.dryRun
                            ? `TEST MODE — no real WhatsApp message was sent. Confirm to the staff that:\n- Invoice ${invoiceNum} has been "sent" to ${clientFullname || 'the client'}.\n- It would have been delivered to: ${clientPhone}\n- PDF preview link: ${pdfPreviewUrl}\n- The caption that would accompany the PDF reads: "${caption}"\nMention all four lines (client name + phone + preview link + caption) verbatim so the staff can verify targeting, content, and message wording.`
                            : `Invoice ${invoiceNum} has been sent to ${clientFullname || 'the client'} via WhatsApp.`,
                    });
                };

                // Helper: handle the upload_letter_of_engagement tool call.
                // Hoisted to this scope so both the first-round and follow-up
                // tool loops can use it without duplicating PDF / GUID / staging checks.
                const handleUploadLoe = async (
                    toolCall: any,
                    phone: string | undefined,
                    triggeredBy: string | undefined
                ): Promise<string> => {
                    const args = JSON.parse(toolCall.function.arguments || '{}');
                    if (!phone) {
                        return JSON.stringify({ status: 'error', error: 'no_phone', message: 'Cannot upload — no phone number on session.' });
                    }
                    const staged = peekPendingUpload(phone);
                    if (!staged) {
                        return JSON.stringify({ status: 'error', error: 'no_pending_upload', message: 'No file is staged. Ask the staff member to upload the signed LOE PDF first.' });
                    }
                    if (staged.mimeType !== 'application/pdf') {
                        return JSON.stringify({
                            status: 'error',
                            error: 'wrong_file_type',
                            message: `Letters of Engagement must be PDF. The uploaded file is ${staged.mimeType || 'an unknown type'}. Please ask the staff member to resend it as a PDF.`,
                        });
                    }
                    const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                    if (!args.lead_id || !guidRegex.test(String(args.lead_id))) {
                        return JSON.stringify({ status: 'error', error: 'invalid_lead_id', message: 'lead_id must be the GUID returned from search_lead_by_name. Run that lookup first.' });
                    }
                    const result = await dynamicsService.uploadLoeToLead(
                        args.lead_id,
                        staged.fileName,
                        staged.buffer,
                        triggeredBy || phone
                    );
                    if (!result.success) {
                        // Special-case: LOE already on file. We leave the staged
                        // upload in place so the staff member can re-target a
                        // different lead without re-uploading the same PDF.
                        if (result.alreadyReceived) {
                            return JSON.stringify({
                                status: 'already_received',
                                lead_name: result.leadName || args.lead_name,
                                message: `A signed Letter of Engagement has already been submitted for ${result.leadName || args.lead_name}. No new upload was made. Ask the staff member whether they meant a different lead.`,
                            });
                        }
                        return JSON.stringify({ status: 'error', error: 'attach_failed', message: `Could not attach the LOE to the lead: ${result.error || 'unknown error'}.` });
                    }
                    clearPendingUpload(phone);
                    if (!result.flagSet) {
                        return JSON.stringify({
                            status: 'partial_success',
                            message: `LOE attached to ${args.lead_name}'s lead record, but the LOE Received flag could not be set. Please flip it manually in the CRM.`,
                        });
                    }
                    return JSON.stringify({
                        status: 'success',
                        message: `Signed LOE for ${args.lead_name} has been attached to the lead timeline and the LOE Received flag is now set.`,
                    });
                };

                // Execute each tool call
                for (const toolCall of responseMessage.tool_calls) {
                    // Cast to any to avoid TS union type issues with CustomToolCall
                    const functionName = (toolCall as any).function.name;
                    let functionResponse = "No data found.";

                    console.log(`[OpenAI] Executing tool: ${functionName}`);

                    // Defense-in-depth: for staff users, re-check permission at
                    // handler level in case the AI invokes a tool that wasn't in
                    // the filtered list (shouldn't happen, but enforce anyway).
                    if (entityType === 'user') {
                        const requiredPerm = STAFF_TOOL_PERMISSIONS[functionName];
                        if (requiredPerm && !permittedToolKeys.includes(requiredPerm)) {
                            console.warn(`[OpenAI] Blocked tool "${functionName}" — role lacks permission "${requiredPerm}"`);
                            messages.push({
                                role: 'tool',
                                tool_call_id: (toolCall as any).id,
                                content: `You do not have access to this feature. Please contact your administrator if you believe this is incorrect.`,
                            } as OpenAI.Chat.Completions.ChatCompletionToolMessageParam);
                            continue;
                        }
                    }

                    // Helper: resolve a client name/phone to a contact GUID
                    const resolveClientId = async (clientInput?: string): Promise<string | null> => {
                        if (!clientInput) return null;
                        const input = clientInput.trim();
                        const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                        if (guidRegex.test(input)) return input;
                        // Try phone first
                        const byPhone = await dynamicsService.getContactByPhone(input);
                        if (byPhone?.type === 'client') return byPhone.id;
                        // Try name — scoped to staff's own clients if applicable
                        const byName = await dynamicsService.searchContactByName(input, ownerFilter);
                        if (byName.length > 0) return byName[0].contactid;
                        return null;
                    };

                    // Detailed resolver: returns status + candidates so the AI can
                    // disambiguate with the user (e.g. "did you mean X?") or ask
                    // for more details (full name, phone number).
                    type ClientResolveResult =
                        | { status: 'found'; id: string; fullname: string }
                        | { status: 'ambiguous'; candidates: { id: string; fullname: string; mobilephone: string | null }[] }
                        | { status: 'not_found'; tried: string }
                        | { status: 'error'; message: string };

                    const resolveClientDetailed = async (clientInput?: string): Promise<ClientResolveResult> => {
                        if (!clientInput?.trim()) return { status: 'not_found', tried: '' };
                        const input = clientInput.trim();
                        const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                        if (guidRegex.test(input)) return { status: 'found', id: input, fullname: '' };
                        try {
                            // Try phone first
                            const byPhone = await dynamicsService.getContactByPhone(input);
                            if (byPhone?.type === 'client') {
                                return { status: 'found', id: byPhone.id, fullname: byPhone.fullname || '' };
                            }
                            // Try name (contains match) — scoped to staff's own clients if applicable
                            const matches = await dynamicsService.searchContactByName(input, ownerFilter);
                            if (matches.length === 0) return { status: 'not_found', tried: input };
                            if (matches.length === 1) {
                                return { status: 'found', id: matches[0].contactid, fullname: matches[0].fullname };
                            }
                            return {
                                status: 'ambiguous',
                                candidates: matches.map(m => ({ id: m.contactid, fullname: m.fullname, mobilephone: m.mobilephone })),
                            };
                        } catch (e: any) {
                            return { status: 'error', message: e?.message || 'Lookup failed' };
                        }
                    };

                    if (contactId) {
                        if (functionName === 'get_my_details') {
                            const details = await dynamicsService.getContactDetails(contactId);
                            functionResponse = details ? JSON.stringify(details) : "I couldn't retrieve your details at this time.";
                        } else if (functionName === 'get_client_invoices') {
                            const args = JSON.parse((toolCall as any).function.arguments || '{}');
                            if (entityType === 'user') {
                                if (!args.client) {
                                    functionResponse = "I need a client name or phone number to look up their invoices. Which client?";
                                } else {
                                    const r = await resolveClientDetailed(args.client);
                                    if (r.status === 'found') {
                                        const data = await dynamicsService.getClientInvoices(r.id);
                                        functionResponse = JSON.stringify({ client_id: r.id, client_name: r.fullname, invoices: data });
                                    } else if (r.status === 'ambiguous') {
                                        functionResponse = JSON.stringify({
                                            error: 'multiple_matches',
                                            message: `Multiple clients match "${args.client}". Ask the user which one they mean.`,
                                            candidates: r.candidates,
                                        });
                                    } else if (r.status === 'not_found') {
                                        functionResponse = JSON.stringify({
                                            error: 'not_found',
                                            message: `No client found matching "${args.client}". Ask the user to provide the full name, or a phone number, or call get_my_clients to see the full list of their clients.`,
                                        });
                                    } else {
                                        functionResponse = JSON.stringify({
                                            error: 'lookup_failed',
                                            message: `Client lookup failed: ${r.message}. Tell the user the CRM had an error.`,
                                        });
                                    }
                                }
                            } else {
                                const data = await dynamicsService.getClientInvoices(contactId);
                                functionResponse = JSON.stringify(data);
                            }
                        } else if (functionName === 'get_client_cases') {
                            const args = JSON.parse((toolCall as any).function.arguments || '{}');
                            if (entityType === 'user' && args.client) {
                                const r = await resolveClientDetailed(args.client);
                                if (r.status === 'found') {
                                    const data = await dynamicsService.getClientCases(r.id);
                                    functionResponse = JSON.stringify({ client_id: r.id, client_name: r.fullname, cases: data });
                                } else if (r.status === 'ambiguous') {
                                    functionResponse = JSON.stringify({
                                        error: 'multiple_matches',
                                        message: `Multiple clients match "${args.client}". Ask the user which one they mean.`,
                                        candidates: r.candidates,
                                    });
                                } else if (r.status === 'not_found') {
                                    functionResponse = JSON.stringify({
                                        error: 'not_found',
                                        message: `No client found matching "${args.client}". Ask for the full name or phone number, or call get_my_clients.`,
                                    });
                                } else {
                                    functionResponse = JSON.stringify({
                                        error: 'lookup_failed',
                                        message: `Client lookup failed: ${r.message}.`,
                                    });
                                }
                            } else if (entityType === 'user') {
                                // Staff viewing their own assigned cases
                                const data = await dynamicsService.getStaffCases(contactId);
                                functionResponse = JSON.stringify(data);
                            } else {
                                // Client viewing their own cases
                                const data = await dynamicsService.getClientCases(contactId);
                                functionResponse = JSON.stringify(data);
                            }
                        } else if (functionName === 'get_invoice_pdf') {
                            const args = JSON.parse((toolCall as any).function.arguments);
                            const invoiceNum = args.invoice_number;

                            // Fetch invoice from Dynamics
                            const invoice = await dynamicsService.getInvoiceByNumber(invoiceNum);

                            if (!invoice) {
                                functionResponse = JSON.stringify({
                                    status: "error",
                                    message: `Invoice ${invoiceNum} not found.`
                                });
                            } else {
                                // Return a download link — the /api/pdf route regenerates
                                // the PDF on demand from the same source data.
                                console.log(`[PDF] Invoice ${invoiceNum} found, returning download link`);
                                functionResponse = JSON.stringify({
                                    status: "success",
                                    message: `Here's your invoice: [📄 Download ${invoiceNum}.pdf](http://localhost:3001/api/pdf/invoice/${invoiceNum})`,
                                    pdfLink: `http://localhost:3001/api/pdf/invoice/${invoiceNum}`
                                });
                            }
                        } else if (functionName === 'get_tax_number') {
                            const taxNumber = await dynamicsService.getContactTaxNumber(contactId);
                            functionResponse = taxNumber ? `Your Tax Number is: ${taxNumber}` : "I could not find a tax number on your profile.";
                        } else if (functionName === 'request_consultant_callback') {
                            const args = JSON.parse((toolCall as any).function.arguments || '{}');
                            // Get the CRM entity for this contact
                            const crmEntity = await dynamicsService.getContactByPhone(phoneNumber || contactId || '');
                            const success = await dynamicsService.createCallbackRequest(
                                crmEntity,
                                phoneNumber || contactId || 'unknown',
                                args.reason
                            );

                            if (success) {
                                // Check if within working hours (8:00-17:00 SAST, Mon-Fri)
                                const now = new Date();
                                const saTime = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Johannesburg' }));
                                const hour = saTime.getHours();
                                const day = saTime.getDay(); // 0 = Sunday, 6 = Saturday
                                const isWorkingHours = day >= 1 && day <= 5 && hour >= 8 && hour < 17;

                                if (isWorkingHours) {
                                    functionResponse = JSON.stringify({
                                        status: "success",
                                        message: "Your request has been submitted. A consultant will contact you within 24 hours."
                                    });
                                } else {
                                    functionResponse = JSON.stringify({
                                        status: "success",
                                        message: "Your request has been logged. A consultant will contact you on the next business day."
                                    });
                                }
                            } else {
                                functionResponse = JSON.stringify({
                                    status: "error",
                                    message: "I couldn't submit your request. Please try again or call our office directly."
                                });
                            }
                        } else if (functionName === 'opt_out_whatsapp') {
                            const success = await dynamicsService.updateWhatsAppOptIn(contactId, false);
                            if (success) {
                                functionResponse = JSON.stringify({
                                    status: "success",
                                    message: "You have been opted out of WhatsApp communications. If you message us again, you'll be opted back in automatically."
                                });
                            } else {
                                functionResponse = JSON.stringify({
                                    status: "error",
                                    message: "I couldn't update your preferences. Please contact our office directly."
                                });
                            }
                        } else if (functionName === 'create_case') {
                            const args = JSON.parse((toolCall as any).function.arguments || '{}');
                            const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

                            // Resolve the target contact ID
                            let targetContactId: string | null = null;

                            if (entityType === 'client') {
                                // Clients create cases for themselves
                                targetContactId = contactId || null;
                            } else if (args.client) {
                                // Staff provided a client name or phone — resolve to GUID
                                const clientInput = args.client.trim();
                                console.log(`[OpenAI] create_case: resolving client "${clientInput}"...`);

                                if (guidRegex.test(clientInput)) {
                                    targetContactId = clientInput;
                                } else {
                                    // Try phone lookup first (mobilephone field)
                                    const byPhone = await dynamicsService.getContactByPhone(clientInput);
                                    if (byPhone && byPhone.type === 'client') {
                                        targetContactId = byPhone.id;
                                        console.log(`[OpenAI] create_case: found by phone: ${byPhone.fullname} (${byPhone.id})`);
                                    } else {
                                        // Try name search
                                        const byName = await dynamicsService.searchContactByName(clientInput, ownerFilter);
                                        if (byName.length > 0) {
                                            targetContactId = byName[0].contactid;
                                            console.log(`[OpenAI] create_case: found by name: ${byName[0].fullname} (${targetContactId})`);
                                        }
                                    }
                                }
                            }

                            console.log(`[OpenAI] create_case targetContactId: ${targetContactId}, entityType: ${entityType}`);

                            if (!targetContactId) {
                                functionResponse = JSON.stringify({
                                    status: "error",
                                    message: "Could not find a matching client. Please provide the client's full name."
                                });
                            } else {
                                const result = await dynamicsService.createCase(
                                    targetContactId,
                                    args.case_type,
                                    args.description,
                                    args.priority
                                );
                                if (result) {
                                    functionResponse = JSON.stringify({
                                        status: "success",
                                        case_number: result.new_name || result.new_caseid,
                                        message: `Case ${result.new_name || result.new_caseid} created successfully.`
                                    });
                                } else {
                                    functionResponse = JSON.stringify({
                                        status: "error",
                                        message: "Failed to create the case in CRM. Please try again."
                                    });
                                }
                            }
                        } else if (functionName === 'get_my_clients') {
                            const data = await dynamicsService.getMyClients(contactId);
                            functionResponse = data.length > 0
                                ? JSON.stringify(data)
                                : "No clients found assigned to you.";
                        } else if (functionName === 'get_my_leads') {
                            const data = await dynamicsService.getMyLeads(contactId);
                            functionResponse = data.length > 0
                                ? JSON.stringify(data)
                                : "No leads found assigned to you.";
                        } else if (functionName === 'search_contact_by_name') {
                            const args = JSON.parse((toolCall as any).function.arguments || '{}');
                            const results = await dynamicsService.searchContactByName(args.name, ownerFilter);
                            functionResponse = results.length > 0
                                ? JSON.stringify(results)
                                : "No contacts found matching that name.";
                        } else if (functionName === 'get_client_details') {
                            const args = JSON.parse((toolCall as any).function.arguments || '{}');
                            const resolved = await resolveClientId(args.client);
                            if (resolved) {
                                const details = await dynamicsService.getContactDetails(resolved);
                                functionResponse = details ? JSON.stringify(details) : "Client found but could not load details.";
                            } else {
                                functionResponse = "No client found matching that name or phone number.";
                            }
                        } else if (functionName === 'get_case_by_name') {
                            const args = JSON.parse((toolCall as any).function.arguments || '{}');
                            const cases = await dynamicsService.searchCaseByName(args.case_name);
                            functionResponse = cases.length > 0
                                ? JSON.stringify(cases)
                                : "No cases found matching that name.";
                        } else if (functionName === 'get_outstanding_balance') {
                            const args = JSON.parse((toolCall as any).function.arguments || '{}');
                            let targetId = contactId;
                            let targetName: string | undefined;
                            if (entityType === 'user' && args.client) {
                                const r = await resolveClientDetailed(args.client);
                                if (r.status === 'found') {
                                    targetId = r.id;
                                    targetName = r.fullname;
                                } else if (r.status === 'ambiguous') {
                                    functionResponse = JSON.stringify({
                                        error: 'multiple_matches',
                                        message: `Multiple clients match "${args.client}". Ask the user which one they mean.`,
                                        candidates: r.candidates,
                                    });
                                } else if (r.status === 'not_found') {
                                    functionResponse = JSON.stringify({
                                        error: 'not_found',
                                        message: `No client found matching "${args.client}".`,
                                    });
                                }
                            }
                            // Only run the balance lookup if we didn't already short-circuit
                            // with an error response above.
                            if (functionResponse === "No data found." || !args.client) {
                                const balance = await dynamicsService.getOpenInvoiceTotal(targetId);
                                functionResponse = JSON.stringify({
                                    client_id: targetId,
                                    client_name: targetName,
                                    outstanding_amount: `R${balance.total.toFixed(2)}`,
                                    open_invoices: balance.count,
                                });
                            }
                        } else if (functionName === 'create_lead') {
                            functionResponse = await handleCreateLead(toolCall);
                        } else if (functionName === 'create_contact') {
                            functionResponse = await handleCreateContact(toolCall);
                        } else if (functionName === 'create_invoice') {
                            functionResponse = await handleCreateInvoice(toolCall);
                        } else if (functionName === 'get_industries') {
                            functionResponse = await handleGetIndustries(toolCall);
                        } else if (functionName === 'get_task_types') {
                            const taskTypes = await dynamicsService.getTaskTypes();
                            functionResponse = taskTypes.length > 0
                                ? JSON.stringify(taskTypes)
                                : "No task types found.";
                        } else if (functionName === 'search_lead_by_name') {
                            const args = JSON.parse((toolCall as any).function.arguments || '{}');
                            const results = await dynamicsService.searchLeadByName(args.name, ownerFilter);
                            if (results.length > 0) {
                                functionResponse = JSON.stringify(results);
                            } else {
                                functionResponse = JSON.stringify({
                                    status: 'not_found',
                                    scope: ownerFilter ? 'owned_by_you' : 'all_leads',
                                    message: `No active leads assigned to you match "${args.name}". Ask the staff member what they'd like to do next, offering these three options:\n1. Check the spelling or give more details (full name, phone).\n2. See the full list of their leads (call get_my_leads).\n3. Create a new lead for this person (call create_lead — you'll need first name, last name, client_type, lead_type, and industry).\nPresent all three options and let them choose.`,
                                });
                            }
                        } else if (functionName === 'create_task') {
                            const args = JSON.parse((toolCall as any).function.arguments || '{}');
                            const result = await dynamicsService.createTask({
                                regardingId: args.client_or_lead,
                                regardingType: args.entity_type,
                                taskTypeId: args.task_type_id,
                                taskTypeName: args.task_type_name,
                                taxYear: args.tax_year,
                                primaryRepId: contactId,
                                description: args.description,
                            });
                            if (result.success) {
                                functionResponse = JSON.stringify({
                                    status: "success",
                                    message: `Task "${args.task_type_name}" created successfully for tax year ${args.tax_year}.`
                                });
                            } else {
                                functionResponse = JSON.stringify({
                                    status: "error",
                                    message: `Failed to create task: ${result.error}`
                                });
                            }
                        } else if (functionName === 'refer_friend') {
                            const args = JSON.parse((toolCall as any).function.arguments || '{}');
                            const nameParts = (args.friend_name || '').trim().split(/\s+/);
                            const firstName = nameParts[0] || '';
                            const lastName = nameParts.slice(1).join(' ') || firstName;

                            // Map the client-facing service enum to the riivo_leadtype
                            // Choice value. "Insurance" / "Financial Planning" / "Not sure"
                            // fall through to Tax as a safe default — TTT staff can re-route
                            // the lead afterwards if needed. Keeping this here (not in the
                            // dynamics method) so the staff create_lead tool stays strict.
                            const REFER_LEAD_TYPE_MAP: Record<string, number> = {
                                'Tax': 100000000,
                                'Accounting': 100000001,
                                'Insurance': 463630002,        // defaulting to Short Term Insurance
                                'Financial Planning': 100000001,
                                'Not sure': 100000000,
                            };
                            const leadTypeValue = REFER_LEAD_TYPE_MAP[args.service] ?? 100000000;

                            // Inherit owner from the referring client so the new lead has
                            // a populated ownerid (Lead.ownerid is now Business Required).
                            // If we can't resolve it, the create will fail at Dynamics —
                            // log a clear error rather than guess a system user.
                            let ownerSystemUserId: string | undefined;
                            if (contactId) {
                                ownerSystemUserId = (await dynamicsService.getContactOwnerId(contactId)) || undefined;
                                if (!ownerSystemUserId) {
                                    console.warn(`[refer_friend] Could not resolve owner for referring contact ${contactId}; lead create will likely fail.`);
                                }
                            }

                            // "Other" industry — keeps Industry populated without asking
                            // the client. Hardcoded GUID from riivo_industries (label "Other").
                            // If TTT changes that record, update this constant.
                            const OTHER_INDUSTRY_ID = '02c54e15-95ce-f011-8543-000d3a69c99c';

                            const result = await dynamicsService.createLead({
                                firstName,
                                lastName,
                                phone: args.friend_phone,
                                email: args.friend_email,
                                department: args.service,
                                notes: `Referred by existing client. Interested in: ${args.service || 'Not specified'}`,
                                referredByContactId: contactId,
                                clientType: 0,                  // Individual — referrals default to person
                                leadType: leadTypeValue,
                                industryId: OTHER_INDUSTRY_ID,
                                ownerSystemUserId,
                            });
                            if (result) {
                                functionResponse = JSON.stringify({
                                    status: "success",
                                    message: `${args.friend_name}'s details have been passed to our ${args.service || ''} team. We'll be in touch with them shortly.`
                                });
                            } else {
                                functionResponse = JSON.stringify({ status: "error", message: "Failed to create the referral." });
                            }
                        } else if (functionName === 'upload_letter_of_engagement') {
                            functionResponse = await handleUploadLoe(toolCall, phoneNumber, contactId);
                        } else if (functionName === 'send_invoice_pdf') {
                            functionResponse = await handleSendInvoicePdf(toolCall);
                        } else if (functionName === 'save_document') {
                            const args = JSON.parse((toolCall as any).function.arguments || '{}');
                            if (entityType === 'user') {
                                // Staff have no save_document path — the only staff
                                // upload is upload_letter_of_engagement. Reject defensively.
                                functionResponse = JSON.stringify({ status: "error", message: "Staff cannot use save_document. Use upload_letter_of_engagement to attach a signed LOE to a lead." });
                            } else if (!phoneNumber || !hasPendingUpload(phoneNumber)) {
                                functionResponse = JSON.stringify({ status: "error", message: "No pending document upload found. Ask the user to upload a file first." });
                            } else {
                                let targetEntity: any = null;
                                if (entityType === 'client' && contactId) {
                                    targetEntity = { id: contactId, type: 'client' };
                                } else if (entityType === 'lead' && contactId) {
                                    targetEntity = { id: contactId, type: 'lead' };
                                }

                                if (!targetEntity) {
                                    functionResponse = JSON.stringify({ status: "error", message: "Could not determine which record to attach the document to." });
                                } else {
                                    const result = await savePendingUpload(phoneNumber, args.doc_type, targetEntity);
                                    if (result.success) {
                                        functionResponse = JSON.stringify({
                                            status: "success",
                                            message: `Your ${args.doc_type.toLowerCase()} has been saved to your profile. ${entityType === 'client' ? 'Your consultant has been notified.' : ''}`
                                        });
                                    } else {
                                        functionResponse = JSON.stringify({ status: "error", message: "Failed to save the document. Please try uploading again." });
                                    }
                                }
                            }
                        }
                    } else if (functionName === 'verify_identity') {
                        // This works even without contactId (unknown users)
                        const args = JSON.parse((toolCall as any).function.arguments || '{}');
                        const contact = await dynamicsService.searchContactByIdNumber(args.id_number);
                        if (contact) {
                            // Found — link their phone and return their info
                            if (phoneNumber) {
                                await dynamicsService.linkPhoneToContact(contact.contactid, phoneNumber);
                            }
                            functionResponse = JSON.stringify({
                                status: "found",
                                fullname: contact.fullname,
                                contactid: contact.contactid,
                                message: `Account found! Welcome back, ${contact.fullname}. Your WhatsApp number has been linked to your profile.`
                            });
                        } else {
                            functionResponse = JSON.stringify({
                                status: "not_found",
                                message: "No account found with that ID number. I've noted your details and a consultant will be in touch."
                            });
                        }
                    } else {
                        functionResponse = "Error: User context (contactId) is missing.";
                    }

                    console.log(`[OpenAI] Tool Response:`, functionResponse);

                    // Append tool output to history
                    messages.push({
                        tool_call_id: toolCall.id,
                        role: "tool",
                        content: functionResponse,
                    });
                }

                // 3. Loop: keep processing tool calls until the AI returns a text-only response
                const MAX_TOOL_ROUNDS = 5;
                for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
                    const followUp = await client.chat.completions.create({
                        model: 'gpt-4o-mini',
                        messages: messages,
                        tools: availableTools && availableTools.length > 0 ? availableTools : undefined,
                        ...(availableTools && availableTools.length > 0 ? { tool_choice: 'auto' as const } : {}),
                        max_tokens: 500,
                        temperature: 0.7,
                    });

                    const followUpMessage = followUp.choices[0]?.message;

                    if (!followUpMessage?.tool_calls || followUpMessage.tool_calls.length === 0) {
                        return followUpMessage?.content || "I found the data but couldn't summarize it.";
                    }

                    // More tool calls — execute them
                    messages.push(followUpMessage);
                    for (const toolCall of followUpMessage.tool_calls) {
                        const functionName = (toolCall as any).function.name;
                        let functionResponse = "No data found.";
                        console.log(`[OpenAI] Executing tool (round ${round + 2}): ${functionName}`);

                        if (contactId) {
                            if (functionName === 'get_task_types') {
                                const taskTypes = await dynamicsService.getTaskTypes();
                                functionResponse = taskTypes.length > 0
                                    ? JSON.stringify(taskTypes)
                                    : "No task types found.";
                            } else if (functionName === 'search_lead_by_name') {
                                const args = JSON.parse((toolCall as any).function.arguments || '{}');
                                const results = await dynamicsService.searchLeadByName(args.name, ownerFilter);
                                if (results.length > 0) {
                                    functionResponse = JSON.stringify(results);
                                } else {
                                    functionResponse = JSON.stringify({
                                        status: 'not_found',
                                        scope: ownerFilter ? 'owned_by_you' : 'all_leads',
                                        message: `No active leads assigned to you match "${args.name}". Ask the staff member what they'd like to do next, offering these three options:\n1. Check the spelling or give more details (full name, phone).\n2. See the full list of their leads (call get_my_leads).\n3. Create a new lead for this person (call create_lead — you'll need first name, last name, client_type, lead_type, and industry).\nPresent all three options and let them choose.`,
                                    });
                                }
                            } else if (functionName === 'create_task') {
                                const args = JSON.parse((toolCall as any).function.arguments || '{}');
                                const result = await dynamicsService.createTask({
                                    regardingId: args.client_or_lead,
                                    regardingType: args.entity_type,
                                    taskTypeId: args.task_type_id,
                                    taskTypeName: args.task_type_name,
                                    taxYear: args.tax_year,
                                    primaryRepId: contactId,
                                    description: args.description,
                                });
                                if (result.success) {
                                    functionResponse = JSON.stringify({
                                        status: "success",
                                        message: `Task "${args.task_type_name}" created successfully for tax year ${args.tax_year}.`
                                    });
                                } else {
                                    functionResponse = JSON.stringify({
                                        status: "error",
                                        message: `Failed to create task: ${result.error}`
                                    });
                                }
                            } else if (functionName === 'search_contact_by_name') {
                                const args = JSON.parse((toolCall as any).function.arguments || '{}');
                                const results = await dynamicsService.searchContactByName(args.name, ownerFilter);
                                functionResponse = results.length > 0
                                    ? JSON.stringify(results)
                                    : "No contacts found matching that name.";
                            } else if (functionName === 'get_my_leads') {
                                const data = await dynamicsService.getMyLeads(contactId);
                                functionResponse = data.length > 0
                                    ? JSON.stringify(data)
                                    : "No leads found assigned to you.";
                            } else if (functionName === 'get_my_clients') {
                                const data = await dynamicsService.getMyClients(contactId);
                                functionResponse = data.length > 0
                                    ? JSON.stringify(data)
                                    : "No clients found assigned to you.";
                            } else if (functionName === 'get_client_details') {
                                const args = JSON.parse((toolCall as any).function.arguments || '{}');
                                // Inline GUID-or-resolve pattern (resolveClientId is scoped
                                // to the first-round closure, not visible here).
                                const clientInput = (args.client || '').trim();
                                const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                                let targetId: string | null = null;
                                if (guidRegex.test(clientInput)) {
                                    targetId = clientInput;
                                } else if (clientInput) {
                                    const byPhone = await dynamicsService.getContactByPhone(clientInput);
                                    if (byPhone?.type === 'client') targetId = byPhone.id;
                                    else {
                                        const byName = await dynamicsService.searchContactByName(clientInput, ownerFilter);
                                        if (byName.length > 0) targetId = byName[0].contactid;
                                    }
                                }
                                if (targetId) {
                                    const details = await dynamicsService.getContactDetails(targetId);
                                    functionResponse = details ? JSON.stringify(details) : "Client found but could not load details.";
                                } else {
                                    functionResponse = "No client found matching that name or phone number.";
                                }
                            } else if (functionName === 'get_client_invoices') {
                                const args = JSON.parse((toolCall as any).function.arguments || '{}');
                                const clientInput = (args.client || '').trim();
                                const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                                let targetId: string | null = entityType === 'client' ? (contactId || null) : null;
                                let targetName: string | undefined;
                                if (entityType === 'user' && clientInput) {
                                    if (guidRegex.test(clientInput)) targetId = clientInput;
                                    else {
                                        const byPhone = await dynamicsService.getContactByPhone(clientInput);
                                        if (byPhone?.type === 'client') { targetId = byPhone.id; targetName = byPhone.fullname; }
                                        else {
                                            const byName = await dynamicsService.searchContactByName(clientInput, ownerFilter);
                                            if (byName.length > 0) { targetId = byName[0].contactid; targetName = byName[0].fullname; }
                                        }
                                    }
                                }
                                if (!targetId) {
                                    functionResponse = JSON.stringify({ error: 'not_found', message: `No client matched "${args.client}". Ask staff for a name, phone, or to call get_my_clients.` });
                                } else {
                                    const data = await dynamicsService.getClientInvoices(targetId);
                                    functionResponse = JSON.stringify({ client_id: targetId, client_name: targetName, invoices: data });
                                }
                            } else if (functionName === 'get_client_cases') {
                                const args = JSON.parse((toolCall as any).function.arguments || '{}');
                                const clientInput = (args.client || '').trim();
                                const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                                let targetId: string | null = entityType === 'client' ? (contactId || null) : null;
                                let targetName: string | undefined;
                                if (entityType === 'user' && clientInput) {
                                    if (guidRegex.test(clientInput)) targetId = clientInput;
                                    else {
                                        const byPhone = await dynamicsService.getContactByPhone(clientInput);
                                        if (byPhone?.type === 'client') { targetId = byPhone.id; targetName = byPhone.fullname; }
                                        else {
                                            const byName = await dynamicsService.searchContactByName(clientInput, ownerFilter);
                                            if (byName.length > 0) { targetId = byName[0].contactid; targetName = byName[0].fullname; }
                                        }
                                    }
                                }
                                if (!targetId) {
                                    functionResponse = JSON.stringify({ error: 'not_found', message: `No client matched "${args.client}".` });
                                } else {
                                    const data = await dynamicsService.getClientCases(targetId);
                                    functionResponse = JSON.stringify({ client_id: targetId, client_name: targetName, cases: data });
                                }
                            } else if (functionName === 'get_outstanding_balance') {
                                const args = JSON.parse((toolCall as any).function.arguments || '{}');
                                const clientInput = (args.client || '').trim();
                                const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                                let targetId: string | null = entityType === 'client' ? (contactId || null) : null;
                                let targetName: string | undefined;
                                if (entityType === 'user' && clientInput) {
                                    if (guidRegex.test(clientInput)) targetId = clientInput;
                                    else {
                                        const byPhone = await dynamicsService.getContactByPhone(clientInput);
                                        if (byPhone?.type === 'client') { targetId = byPhone.id; targetName = byPhone.fullname; }
                                        else {
                                            const byName = await dynamicsService.searchContactByName(clientInput, ownerFilter);
                                            if (byName.length > 0) { targetId = byName[0].contactid; targetName = byName[0].fullname; }
                                        }
                                    }
                                }
                                if (!targetId) {
                                    functionResponse = JSON.stringify({ error: 'not_found', message: `No client matched "${args.client}".` });
                                } else {
                                    const balance = await dynamicsService.getOpenInvoiceTotal(targetId);
                                    functionResponse = JSON.stringify({
                                        client_id: targetId,
                                        client_name: targetName,
                                        outstanding_amount: `R${balance.total.toFixed(2)}`,
                                        open_invoices: balance.count,
                                    });
                                }
                            } else if (functionName === 'get_case_by_name') {
                                const args = JSON.parse((toolCall as any).function.arguments || '{}');
                                const cases = await dynamicsService.searchCaseByName(args.case_name);
                                functionResponse = cases.length > 0
                                    ? JSON.stringify(cases)
                                    : "No cases found matching that name.";
                            } else if (functionName === 'get_invoice_pdf') {
                                const args = JSON.parse((toolCall as any).function.arguments || '{}');
                                const invoiceNum = args.invoice_number;
                                const invoice = await dynamicsService.getInvoiceByNumber(invoiceNum);
                                if (!invoice) {
                                    functionResponse = JSON.stringify({ status: 'error', message: `Invoice ${invoiceNum} not found.` });
                                } else {
                                    functionResponse = JSON.stringify({
                                        status: 'success',
                                        message: `Here's the invoice: [📄 Download ${invoiceNum}.pdf](http://localhost:3001/api/pdf/invoice/${invoiceNum})`,
                                        pdfLink: `http://localhost:3001/api/pdf/invoice/${invoiceNum}`,
                                    });
                                }
                            } else if (functionName === 'upload_letter_of_engagement') {
                                functionResponse = await handleUploadLoe(toolCall, phoneNumber, contactId);
                            } else if (functionName === 'send_invoice_pdf') {
                                functionResponse = await handleSendInvoicePdf(toolCall);
                            } else if (functionName === 'create_lead') {
                                functionResponse = await handleCreateLead(toolCall);
                            } else if (functionName === 'create_contact') {
                                functionResponse = await handleCreateContact(toolCall);
                            } else if (functionName === 'create_invoice') {
                                functionResponse = await handleCreateInvoice(toolCall);
                            } else if (functionName === 'get_industries') {
                                functionResponse = await handleGetIndustries(toolCall);
                            } else if (functionName === 'create_case') {
                                const args = JSON.parse((toolCall as any).function.arguments || '{}');
                                const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                                let targetContactId: string | null = null;
                                if (entityType === 'client') {
                                    targetContactId = contactId || null;
                                } else if (args.client) {
                                    const clientInput = args.client.trim();
                                    if (guidRegex.test(clientInput)) {
                                        targetContactId = clientInput;
                                    } else {
                                        const byPhone = await dynamicsService.getContactByPhone(clientInput);
                                        if (byPhone && byPhone.type === 'client') {
                                            targetContactId = byPhone.id;
                                        } else {
                                            const byName = await dynamicsService.searchContactByName(clientInput, ownerFilter);
                                            if (byName.length > 0) targetContactId = byName[0].contactid;
                                        }
                                    }
                                }
                                if (!targetContactId) {
                                    functionResponse = JSON.stringify({ status: "error", message: "Could not find a matching client." });
                                } else {
                                    const result = await dynamicsService.createCase(targetContactId, args.case_type, args.description, args.priority);
                                    functionResponse = result
                                        ? JSON.stringify({ status: "success", case_number: result.new_name || result.new_caseid, message: `Case ${result.new_name || result.new_caseid} created successfully.` })
                                        : JSON.stringify({ status: "error", message: "Failed to create the case in CRM." });
                                }
                            } else {
                                functionResponse = `Tool ${functionName} executed.`;
                            }
                        }

                        messages.push({
                            tool_call_id: toolCall.id,
                            role: "tool",
                            content: functionResponse,
                        });
                    }
                }
                return "I completed the requested actions but ran into too many steps. Please try again.";
            }

            return responseMessage?.content || 'Sorry, I could not generate a response.';

        } catch (error) {
            console.error('OpenAI API Error:', error);
            return 'I encountered an error while processing your request.';
        }
    }
    /**
     * Classify the user's current intent from the conversation.
     * Runs as a lightweight follow-up call after the main response.
     */
    async classifyIntent(
        userMessage: string,
        botResponse: string,
        previousIntent: string | null
    ): Promise<string> {
        const client = this.getClient();
        if (!client) return previousIntent || 'unknown';

        try {
            const completion = await client.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: `Classify the user's current intent from this conversation exchange. Return ONLY one of these labels, nothing else:
- general_tax_query (asking about tax rules, rates, deadlines, SARS procedures)
- invoice_inquiry (asking about their invoices, bills, payments)
- case_status (asking about their case, application, or ticket status)
- tax_number_request (asking for their tax reference number)
- consultant_callback (wants to speak to a human/consultant)
- document_upload (uploading or asking about documents)
- opt_out (wants to unsubscribe from WhatsApp)
- greeting (hello, hi, general chat)
- sign_up_inquiry (asking about signing up or becoming a client)
- complaint (unhappy, escalation, complaint)
- unknown (can't determine intent)

Previous intent was: ${previousIntent || 'none'}`
                    },
                    { role: 'user', content: userMessage },
                    { role: 'assistant', content: botResponse },
                ],
                max_tokens: 20,
                temperature: 0,
            });

            const intent = completion.choices[0]?.message?.content?.trim().toLowerCase() || 'unknown';
            return intent;
        } catch (error) {
            console.warn('[OpenAI] Intent classification failed:', error);
            return previousIntent || 'unknown';
        }
    }
}

export const openAIService = new OpenAIService();
