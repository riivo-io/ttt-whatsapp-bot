import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

export const verify = httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

    if (mode && token) {
        if (mode === "subscribe" && token === VERIFY_TOKEN) {
            console.log("WEBHOOK_VERIFIED");
            return new Response(challenge, { status: 200 });
        } else {
            console.error("Webhook verification failed: Invalid token");
            // Return 403 Forbidden
            return new Response("Forbidden", { status: 403 });
        }
    }
    // Return 400 Bad Request
    return new Response("Bad Request", { status: 400 });
});

export const message = httpAction(async (ctx, request) => {
    try {
        // Parse JSON body
        const body = await request.json();

        if (body.object === "whatsapp_business_account") {
            for (const entry of body.entry) {
                for (const change of entry.changes) {
                    const value = change.value;
                    if (value.messages && value.messages.length > 0) {
                        const message = value.messages[0];

                        // We support text, interactive, image, and document messages
                        const type = message.type;
                        if (type === "text" || type === "interactive" || type === "image" || type === "document") {
                            const from = message.from;
                            let messageBody = "";

                            if (type === "text") {
                                messageBody = message.text.body;
                            } else if (type === "interactive") {
                                if (message.interactive.type === "button_reply") {
                                    messageBody = message.interactive.button_reply.title;
                                } else if (message.interactive.type === "list_reply") {
                                    messageBody = message.interactive.list_reply.title;
                                }
                            } else if (type === "image") {
                                messageBody = message.image.caption || "Image uploaded";
                            } else if (type === "document") {
                                messageBody = message.document.caption || message.document.filename || "Document uploaded";
                            }

                            console.log(`[Meta] Msg from ${from} (${type}): ${messageBody}`);

                            // 1. Lookup Contact (Reuse logic)
                            const crmEntity = await ctx.runAction(internal.dynamics.getContactByPhone, { phoneNumber: from });

                            // If no contact/lead found, ask them to sign up
                            if (!crmEntity) {
                                console.log(`[Meta] Unknown user ${from}. Sending signup link.`);
                                await ctx.runAction(internal.dynamics.sendWhatsAppMessage, {
                                    to: from,
                                    message: "👋 Welcome to TTT! We don't have your number on record yet.\n\nPlease sign up here to get started: https://app.ttt-tax.co.za/signup\n\nOnce you've signed up, you can chat with me for tax help!"
                                });
                                return new Response("OK", { status: 200 });
                            }

                            if (crmEntity.type === 'contact' && !crmEntity.optIn) {
                                await ctx.runAction(internal.dynamics.updateWhatsAppOptIn, { contactId: crmEntity.id, optIn: true });
                            }

                            // 2. Handle Media Download & Upload
                            if (type === "image" || type === "document") {
                                const mediaId = type === "image" ? message.image.id : message.document.id;
                                const fileName = type === "image" ? "image.jpg" : (message.document.filename || "document.pdf");

                                console.log(`[Meta] Downloading media ${mediaId}...`);
                                const mediaData = await ctx.runAction(internal.dynamics.getMetaMediaUrl, { mediaId: mediaId });

                                if (mediaData && crmEntity) {
                                    await ctx.runAction(internal.dynamics.uploadDocument, {
                                        contactId: crmEntity.id,
                                        entityType: crmEntity.type,
                                        fileName: fileName,
                                        mimeType: mediaData.mimeType,
                                        base64Content: mediaData.buffer
                                    });
                                    // Send a specific confirmation for files
                                    await ctx.runAction(internal.dynamics.sendWhatsAppMessage, {
                                        to: from,
                                        message: `Thanks! I've saved your ${type} (${fileName}) to your profile.`
                                    });
                                    return new Response("OK", { status: 200 }); // Stop processing (don't send to AI for now)
                                }
                            }

                            // 3. Log Incoming (for text/interactive or logs)
                            await ctx.runAction(internal.dynamics.logMessage, {
                                contactId: crmEntity?.id,
                                entityType: crmEntity?.type,
                                messageContent: messageBody,
                                direction: 'Incoming',
                                phoneNumber: from
                            });

                            // 4. Get History & Generate AI Response (Only for text/interactive)
                            if (type === "text" || type === "interactive") {
                                let history: any[] = [];
                                if (crmEntity) {
                                    history = await ctx.runAction(internal.dynamics.getRecentMessages, { contactId: crmEntity.id });
                                }

                                const responseText = await ctx.runAction(internal.openai.generateResponse, {
                                    messageBody,
                                    contactId: crmEntity?.id,
                                    entityType: crmEntity?.type,
                                    phoneNumber: from,
                                    history: history
                                });

                                await ctx.runAction(internal.dynamics.sendWhatsAppMessage, {
                                    to: from,
                                    message: responseText
                                });

                                await ctx.runAction(internal.dynamics.logMessage, {
                                    contactId: crmEntity?.id,
                                    entityType: crmEntity?.type,
                                    messageContent: responseText,
                                    direction: 'Outgoing',
                                    phoneNumber: from
                                });
                            }
                        }
                    }
                }
            }
            return new Response("OK", { status: 200 });
        }
        return new Response("Not Found", { status: 404 });

    } catch (error: any) {
        console.error("Webhook Error:", error);
        return new Response("Internal Server Error", { status: 500 });
    }
});
