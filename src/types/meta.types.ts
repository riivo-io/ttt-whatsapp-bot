export interface MetaButton {
    type: 'reply';
    reply: {
        id: string;
        title: string;
    };
}

export interface MetaListSection {
    title: string;
    rows: {
        id: string;
        title: string;
        description?: string;
    }[];
}

export interface MetaInteractivePayload {
    type: 'button' | 'list';
    body: {
        text: string;
    };
    action: {
        buttons?: MetaButton[];
        button?: string;
        sections?: MetaListSection[];
    };
}
