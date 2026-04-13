"use node";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import OpenAI from 'openai';

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

**Tax Guidelines**:
- Always be professional and courteous
- When recommending professional help, mention that *our team at TTT* can assist (e.g., "One of our tax practitioners at TTT can help you with this" or "For personalized advice, our TTT consultants are available to assist")
- Do NOT say "consult a registered tax practitioner" - instead, promote TTT's services`;

// Tool Definitions
const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
        type: "function",
        function: {
            name: "get_client_invoices",
            description: "ONLY use this when the user explicitly asks for *their* invoices, *my* bill, or payment status. Do not use for general tax questions.",
            parameters: { type: "object", properties: {}, required: [] },
        },
    },
    {
        type: "function",
        function: {
            name: "get_client_cases",
            description: "ONLY use this when the user explicitly asks for *their* case status, *my* application, or tickets. Do not use for general year-based queries.",
            parameters: { type: "object", properties: {}, required: [] },
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
                    invoice_number: { type: "string", description: "The invoice number (e.g. INV123)" }
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
            parameters: { type: "object", properties: {}, required: [] },
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
                    reason: { type: "string", description: "Optional reason" }
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
            parameters: { type: "object", properties: {}, required: [] },
        },
    }
];

export const generateResponse = internalAction({
    args: {
        messageBody: v.string(),
        contactId: v.optional(v.string()),
        entityType: v.optional(v.string()), // 'contact' or 'lead'
        phoneNumber: v.string(),
        history: v.array(v.object({ role: v.string(), content: v.string() }))
    },
    handler: async (ctx, args) => {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

        const openai = new OpenAI({ apiKey });

        // Cast history roles properly
        const history = args.history.map(h => ({
            role: h.role as 'user' | 'assistant',
            content: h.content
        }));

        const systemPrompt = `Current Date: ${new Date().toDateString()}\n${BASE_SYSTEM_PROMPT}`;
        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: 'system', content: systemPrompt },
            ...history,
            { role: 'user', content: args.messageBody }
        ];

        // 1. First Call
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages,
            tools: args.contactId ? TOOLS : undefined,
            tool_choice: args.contactId ? 'auto' : undefined,
            max_tokens: 500,
            temperature: 0.7,
        });

        const responseMessage = completion.choices[0]?.message;

        if (responseMessage?.tool_calls) {
            messages.push(responseMessage);

            for (const toolCall of responseMessage.tool_calls) {
                const functionName = (toolCall as any).function.name;
                const toolArgs = JSON.parse((toolCall as any).function.arguments || '{}');
                let functionResponse = "No data found.";

                console.log(`[OpenAI] Executing tool: ${functionName}`);

                if (args.contactId) {
                    if (functionName === 'get_client_invoices') {
                        const data = await ctx.runAction(internal.dynamics.getClientInvoices, { contactId: args.contactId });
                        functionResponse = JSON.stringify(data);
                    } else if (functionName === 'get_client_cases') {
                        const data = await ctx.runAction(internal.dynamics.getClientCases, { contactId: args.contactId });
                        functionResponse = JSON.stringify(data);
                    } else if (functionName === 'get_invoice_pdf') {
                        const invoice = await ctx.runAction(internal.dynamics.getInvoiceByNumber, { invoiceNumber: toolArgs.invoice_number });
                        if (invoice) {
                            // For now, we don't have the PDF generation route migrated perfectly yet, 
                            // but we can just say "found it" or similar, or point to a placeholder.
                            // Simulating success for text response.
                            functionResponse = JSON.stringify({
                                status: "success",
                                message: `Invoice ${invoice.new_name} found. (PDF download not set up on Convex yet)`
                            });
                        } else {
                            functionResponse = JSON.stringify({ status: "error", message: "Invoice not found." });
                        }
                    } else if (functionName === 'get_tax_number') {
                        const taxNum = await ctx.runAction(internal.dynamics.getContactTaxNumber, { contactId: args.contactId });
                        functionResponse = taxNum ? `Tax Number: ${taxNum}` : "Not found.";
                    } else if (functionName === 'request_consultant_callback') {
                        const success = await ctx.runAction(internal.dynamics.createCallbackRequest, {
                            contactId: args.contactId,
                            entityType: args.entityType || 'contact',
                            phoneNumber: args.phoneNumber,
                            reason: toolArgs.reason
                        });
                        functionResponse = success ? JSON.stringify({ status: "success", message: "Callback requested." }) : JSON.stringify({ status: "error" });
                    } else if (functionName === 'opt_out_whatsapp') {
                        const success = await ctx.runAction(internal.dynamics.updateWhatsAppOptIn, {
                            contactId: args.contactId,
                            optIn: false
                        });
                        functionResponse = success ? "Opt-out successful." : "Failed to opt-out.";
                    }
                }

                messages.push({
                    tool_call_id: toolCall.id,
                    role: "tool",
                    content: functionResponse,
                });
            }

            // 2. Second Call
            const secondResponse = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: messages,
            });
            return secondResponse.choices[0]?.message?.content || "No response generated.";
        }

        return responseMessage?.content || "No response generated.";
    },
});
