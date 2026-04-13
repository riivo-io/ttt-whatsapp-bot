export interface CrmEntity {
    id: string;
    type: 'client' | 'lead' | 'user';
    fullname: string;
    optIn?: boolean;
}

export interface CallbackRequest {
    entityId: string;
    entityType: 'client' | 'lead' | 'user';
    phoneNumber: string;
    reason?: string;
    createdAt: string;
}

export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
}
