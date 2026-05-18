import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context for an inbound WhatsApp message. The webhook controller
 * stores the inbound `metadata.phone_number_id` here at the entry point so
 * downstream outbound sends route through the same number the user messaged,
 * even when we have multiple WhatsApp numbers under one WABA.
 *
 * Outside of an inbound webhook (cron, email relay, scripts) the store is
 * undefined and outbound paths fall back to META_PHONE_NUMBER_ID.
 */
type MessageContext = {
    phoneNumberId: string;
};

export const messageContextStorage = new AsyncLocalStorage<MessageContext>();

export function getActivePhoneNumberId(): string | undefined {
    return messageContextStorage.getStore()?.phoneNumberId;
}
