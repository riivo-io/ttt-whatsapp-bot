/**
 * A WhatsApp template's URL button, as Meta's send call takes it: the template is registered with a URL that ends in one variable
 * ("https://<host>/claim-form/{{1}}"), and each send gives that variable's value, so the button opens the whole link.
 * `index` is the button's place among the template's buttons (the first is 0).
 */
export function urlButtonComponent(index: number, text: string): { type: 'button'; sub_type: 'url'; index: string; parameters: { type: 'text'; text: string }[] } {
    return { type: 'button', sub_type: 'url', index: String(index), parameters: [{ type: 'text', text }] };
}
