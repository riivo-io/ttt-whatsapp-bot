import OpenAI from 'openai';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { dynamicsService } from './dynamics.service';
import { pdfService, InvoiceData } from './pdf.service';
import { hasPendingUpload, savePendingUpload } from '../routes/upload.route';

dotenv.config();

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
            description: "Use this when the user asks for a COPY or PDF of a specific invoice. Requires an invoice number.",
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
            description: "Use when a staff member asks to see their clients, client list, or who they manage. Returns contacts assigned to them.",
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
            description: "Get a specific client's full profile: name, phone, email, ID number, tax number. For staff to look up any client's details.",
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
            description: "Create a new lead (prospect) in the CRM. Gather the lead's first name, last name, and phone number before calling. Optionally collect email and department interest.",
            parameters: {
                type: "object",
                properties: {
                    first_name: { type: "string", description: "Lead's first name" },
                    last_name: { type: "string", description: "Lead's last name" },
                    phone: { type: "string", description: "Lead's phone number" },
                    email: { type: "string", description: "Lead's email address (optional)" },
                    department: {
                        type: "string",
                        enum: ["Insurance", "Tax", "Accounting", "Financial Planning"],
                        description: "Which service they're interested in (optional)"
                    },
                    notes: { type: "string", description: "Any additional notes (optional)" }
                },
                required: ["first_name", "last_name", "phone"],
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
            description: "Search for a lead by name. Use when staff needs to find a lead to link a task or other record to.",
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

    async generateResponse(userMessage: string, contactId?: string, phoneNumber?: string, history: { role: 'user' | 'assistant', content: string }[] = [], entityType?: 'client' | 'lead' | 'user'): Promise<string> {
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

            let roleContext = '';
            if (entityType === 'client') {
                roleContext = `\n\n**User Role: CLIENT**\nThis is a registered TTT client. They have full access to their invoices, cases, tax number, consultant callbacks, and opt-out. Address them as a valued client.${isFirstMessage ? `\n\nIn your introduction, let them know you can help with:\n- Viewing their invoices and outstanding balance\n- Checking the status of their tax cases\n- Looking up their tax number\n- Requesting a callback from their consultant\n- Uploading documents (IRP5s, bank statements, etc.)\n- Referring a friend or family member to TTT` : ''}`;
            } else if (entityType === 'lead') {
                roleContext = `\n\n**User Role: LEAD (Prospective Client)**\nThis is a prospective client (lead) in the onboarding pipeline. They are NOT yet a TTT client.\n\n**CRITICAL RULE: Do NOT answer any tax questions, give tax advice, or provide tax information.** If they ask tax-related questions, politely let them know that tax assistance is available to registered TTT clients, and encourage them to complete their onboarding to become a client. Direct them to sign up at ${process.env.SIGNUP_URL || 'https://app.ttt-tax.co.za/signup'} if needed.\n\nWhat you CAN do for leads:\n- Help them upload onboarding documents (ID, payslips, bank statements, tax certificates)\n- Answer questions about the onboarding process and what documents are needed\n- Explain what TTT offers and the benefits of becoming a client\n- Encourage them to complete their sign-up${isFirstMessage ? `\n\nIn your introduction, welcome them to TTT, let them know you're here to help them get set up, and list what you can assist with. Also mention that once they become a registered client, they'll unlock full access to invoice lookups, case tracking, consultant callbacks, and more.` : ''}`;
            } else if (entityType === 'user') {
                roleContext = `\n\n**User Role: TTT STAFF**\nThis is an internal TTT staff member. Treat them as a colleague. They have elevated access to look up clients, view cases, create cases, create leads, and create tasks.\n\n**Creating Tasks**:\n- When a staff member asks to create a task, first ask for:\n  1. Which client or lead it's for (then use search_contact_by_name or search_lead_by_name to resolve their ID)\n  2. The task type (call get_task_types to show available options)\n  3. The tax year (e.g. 2025)\n  4. Any notes/description (optional)\n- The primary representative is automatically set to the staff member.\n- Only call create_task once ALL required fields are gathered.${isFirstMessage ? `\n\nIn your introduction, greet them as a colleague and let them know you can help with:\n- Searching for clients by name or phone number\n- Viewing any client's invoices and cases\n- Creating new cases for clients\n- Creating new tasks for clients or leads\n- Creating new leads (prospects)\n- Uploading documents on behalf of clients` : ''}`;
            } else {
                roleContext = `\n\n**User Role: UNKNOWN**\nThis person's phone number was not found in our system. Greet them warmly and ask them to provide their 13-digit South African ID number so you can look them up using verify_identity. If they can't be found by ID number, let them know a consultant will be in touch, or they can sign up at https://app.ttt-tax.co.za/signup`;
            }

            roleContext += firstMessageInstruction;

            const systemPrompt = `Current Date: ${currentDate}\n${BASE_SYSTEM_PROMPT}${roleContext}`;

            const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
                { role: 'system', content: systemPrompt },
                ...history, // Prepend conversation history
                { role: 'user', content: userMessage },
            ];

            // Filter tools by role
            const clientTools = ['get_my_details', 'get_client_invoices', 'get_client_cases', 'get_invoice_pdf', 'get_tax_number', 'get_outstanding_balance', 'request_consultant_callback', 'opt_out_whatsapp', 'refer_friend', 'save_document'];
            const staffTools = ['get_my_clients', 'get_client_details', 'get_client_invoices', 'get_client_cases', 'get_case_by_name', 'get_outstanding_balance', 'search_contact_by_name', 'create_case', 'create_lead', 'save_document', 'create_task', 'get_task_types', 'search_lead_by_name'];
            const leadTools = ['save_document'];
            const unknownTools = ['verify_identity'];

            // If there's a pending file upload, tell the AI to classify it
            if (phoneNumber && hasPendingUpload(phoneNumber)) {
                roleContext += `\n\n**PENDING DOCUMENT**: The user has uploaded a file. Ask them what type of document it is: ID Document, Payslip, Bank Statement, Tax Certificate, or Other.${entityType === 'user' ? ' Also ask which client this document is for.' : ''} Then call save_document with the doc_type${entityType === 'user' ? ' and client' : ''}.`;
            }

            let availableTools: typeof TOOLS | undefined;
            if (contactId && entityType === 'client') {
                availableTools = TOOLS.filter(t => clientTools.includes((t as any).function.name));
            } else if (entityType === 'user') {
                availableTools = TOOLS.filter(t => staffTools.includes((t as any).function.name));
            } else if (entityType === 'lead') {
                availableTools = TOOLS.filter(t => leadTools.includes((t as any).function.name));
            } else {
                // Unknown users
                availableTools = TOOLS.filter(t => unknownTools.includes((t as any).function.name));
            }

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

                // Execute each tool call
                for (const toolCall of responseMessage.tool_calls) {
                    // Cast to any to avoid TS union type issues with CustomToolCall
                    const functionName = (toolCall as any).function.name;
                    let functionResponse = "No data found.";

                    console.log(`[OpenAI] Executing tool: ${functionName}`);

                    // Helper: resolve a client name/phone to a contact GUID
                    const resolveClientId = async (clientInput?: string): Promise<string | null> => {
                        if (!clientInput) return null;
                        const input = clientInput.trim();
                        const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                        if (guidRegex.test(input)) return input;
                        // Try phone first
                        const byPhone = await dynamicsService.getContactByPhone(input);
                        if (byPhone?.type === 'client') return byPhone.id;
                        // Try name
                        const byName = await dynamicsService.searchContactByName(input);
                        if (byName.length > 0) return byName[0].contactid;
                        return null;
                    };

                    if (contactId) {
                        if (functionName === 'get_my_details') {
                            const details = await dynamicsService.getContactDetails(contactId);
                            functionResponse = details ? JSON.stringify(details) : "I couldn't retrieve your details at this time.";
                        } else if (functionName === 'get_client_invoices') {
                            const args = JSON.parse((toolCall as any).function.arguments || '{}');
                            // Staff: resolve client param. Clients: use own ID.
                            let targetId = contactId;
                            if (entityType === 'user' && args.client) {
                                const resolved = await resolveClientId(args.client);
                                targetId = resolved || contactId;
                            }
                            const data = await dynamicsService.getClientInvoices(targetId);
                            functionResponse = JSON.stringify(data);
                        } else if (functionName === 'get_client_cases') {
                            const args = JSON.parse((toolCall as any).function.arguments || '{}');
                            if (entityType === 'user' && args.client) {
                                // Staff looking up a specific client's cases
                                const resolved = await resolveClientId(args.client);
                                const data = resolved
                                    ? await dynamicsService.getClientCases(resolved)
                                    : [];
                                functionResponse = resolved
                                    ? JSON.stringify(data)
                                    : "Could not find that client.";
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
                                // Map Dynamics data to InvoiceData
                                const invoiceData: InvoiceData = {
                                    invoiceNumber: invoice.new_name,
                                    invoiceDate: new Date(invoice.createdon).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' }),
                                    consultantName: invoice.riivo_consultantfullname || '',
                                    customerFullname: invoice.riivo_customerfullname || '',
                                    customerStreet: invoice.riivo_customerstreet || '',
                                    customerSuburb: invoice.riivo_customersuburb || '',
                                    customerProvince: invoice.riivo_customerprovince || '',
                                    customerCity: invoice.riivo_customercity || '',
                                    customerCountry: invoice.riivo_customercountry || '',
                                    customerPostalCode: invoice.riivo_customerponumber || '',
                                    customerVatNumber: invoice.riivo_customervatnumber || '',
                                    consultantCompany: invoice.riivo_consultantcompany || '',
                                    consultantStreet: invoice.riivo_consultantstreet || '',
                                    consultantSuburb: invoice.riivo_consultantsuburb || '',
                                    consultantProvince: invoice.riivo_consultantprovince || '',
                                    consultantCity: invoice.riivo_consultantcity || '',
                                    consultantCountry: invoice.riivo_consultantcountry || '',
                                    consultantPostalCode: invoice.riivo_consultantponumber || '',
                                    consultantVatNumber: invoice.riivo_consultantvatnumber || '',
                                    sarsReimbursement: invoice.ttt_sarsreimbursement || 0,
                                    subtotal: invoice.ttt_totalwithinterest || 0,
                                    vatAmount: invoice.riivo_vattotal || 0,
                                    totalInclVat: invoice.riivo_totalinclvat || 0,
                                    accountHolderName: invoice.icon_accountholdername || '',
                                    bankName: invoice.icon_bank || '',
                                    accountNumber: invoice.icon_accountnumber || '',
                                    accountType: invoice.icon_accounttype || '',
                                    branchNumber: invoice.icon_branchnumber || ''
                                };

                                // Return a download link - the PDF route will handle generation on-demand
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
                                        const byName = await dynamicsService.searchContactByName(clientInput);
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
                        } else if (functionName === 'search_contact_by_name') {
                            const args = JSON.parse((toolCall as any).function.arguments || '{}');
                            const results = await dynamicsService.searchContactByName(args.name);
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
                            if (entityType === 'user' && args.client) {
                                const resolved = await resolveClientId(args.client);
                                targetId = resolved || contactId;
                            }
                            const balance = await dynamicsService.getOpenInvoiceTotal(targetId);
                            functionResponse = JSON.stringify({
                                outstanding_amount: `R${balance.total.toFixed(2)}`,
                                open_invoices: balance.count
                            });
                        } else if (functionName === 'create_lead') {
                            const args = JSON.parse((toolCall as any).function.arguments || '{}');
                            const result = await dynamicsService.createLead({
                                firstName: args.first_name,
                                lastName: args.last_name,
                                phone: args.phone,
                                email: args.email,
                                department: args.department,
                                notes: args.notes,
                            });
                            if (result) {
                                functionResponse = JSON.stringify({
                                    status: "success",
                                    lead_id: result.new_leadid,
                                    message: `Lead ${args.first_name} ${args.last_name} created successfully.`
                                });
                            } else {
                                functionResponse = JSON.stringify({ status: "error", message: "Failed to create the lead." });
                            }
                        } else if (functionName === 'get_task_types') {
                            const taskTypes = await dynamicsService.getTaskTypes();
                            functionResponse = taskTypes.length > 0
                                ? JSON.stringify(taskTypes)
                                : "No task types found.";
                        } else if (functionName === 'search_lead_by_name') {
                            const args = JSON.parse((toolCall as any).function.arguments || '{}');
                            const results = await dynamicsService.searchLeadByName(args.name);
                            functionResponse = results.length > 0
                                ? JSON.stringify(results)
                                : "No leads found matching that name.";
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
                            const result = await dynamicsService.createLead({
                                firstName,
                                lastName,
                                phone: args.friend_phone,
                                email: args.friend_email,
                                department: args.service,
                                notes: `Referred by existing client. Interested in: ${args.service || 'Not specified'}`,
                                referredByContactId: contactId,
                            });
                            if (result) {
                                functionResponse = JSON.stringify({
                                    status: "success",
                                    message: `${args.friend_name}'s details have been passed to our ${args.service || ''} team. We'll be in touch with them shortly.`
                                });
                            } else {
                                functionResponse = JSON.stringify({ status: "error", message: "Failed to create the referral." });
                            }
                        } else if (functionName === 'save_document') {
                            const args = JSON.parse((toolCall as any).function.arguments || '{}');
                            if (!phoneNumber || !hasPendingUpload(phoneNumber)) {
                                functionResponse = JSON.stringify({ status: "error", message: "No pending document upload found. Ask the user to upload a file first." });
                            } else {
                                // Resolve which entity to attach the doc to
                                let targetEntity: any = null;
                                if (entityType === 'user' && args.client) {
                                    const resolved = await resolveClientId(args.client);
                                    if (resolved) {
                                        targetEntity = { id: resolved, type: 'client' };
                                    }
                                } else if (entityType === 'client' && contactId) {
                                    targetEntity = { id: contactId, type: 'client' };
                                } else if (entityType === 'lead' && contactId) {
                                    targetEntity = { id: contactId, type: 'lead' };
                                }

                                if (!targetEntity) {
                                    functionResponse = JSON.stringify({ status: "error", message: "Could not determine which client to attach the document to." });
                                } else {
                                    const result = await savePendingUpload(phoneNumber, args.doc_type, targetEntity);
                                    if (result.success) {
                                        functionResponse = JSON.stringify({
                                            status: "success",
                                            message: `Your ${args.doc_type.toLowerCase()} has been saved to ${entityType === 'user' ? 'the client\'s' : 'your'} profile and attached to ${entityType === 'user' ? 'their' : 'your'} record. ${entityType === 'client' ? 'Your consultant has been notified.' : ''}`
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
                                const results = await dynamicsService.searchLeadByName(args.name);
                                functionResponse = results.length > 0
                                    ? JSON.stringify(results)
                                    : "No leads found matching that name.";
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
                                const results = await dynamicsService.searchContactByName(args.name);
                                functionResponse = results.length > 0
                                    ? JSON.stringify(results)
                                    : "No contacts found matching that name.";
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
                                            const byName = await dynamicsService.searchContactByName(clientInput);
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
