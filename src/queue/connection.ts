import { ServiceBusClient } from '@azure/service-bus';

// Single ServiceBusClient shared across all senders and processors. Unlike
// the previous Upstash setup (which needed one ioredis connection per
// Queue/Worker to avoid mid-stream ECONNRESET), the AMQP transport
// multiplexes senders/receivers over a single connection — sharing is the
// recommended pattern.

let cachedClient: ServiceBusClient | null = null;

export function getServiceBusClient(): ServiceBusClient {
    if (cachedClient) return cachedClient;
    const conn = process.env.SERVICE_BUS_CONNECTION_STRING;
    if (!conn) {
        throw new Error(
            'SERVICE_BUS_CONNECTION_STRING is not set — the queue cannot connect to Azure Service Bus.'
        );
    }
    cachedClient = new ServiceBusClient(conn);
    return cachedClient;
}

export async function closeServiceBusClient(): Promise<void> {
    if (cachedClient) {
        await cachedClient.close();
        cachedClient = null;
    }
}
