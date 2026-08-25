/**
 * Money formatting for everything Tina says out loud.
 *
 * TTT bills, refunds and rewards in one currency: South African rands. The
 * model, however, only ever sees whatever a tool result hands it — and when
 * that is a bare number (Dynamics returns money fields unformatted) it is free
 * to pick a symbol, which is how a client came to be quoted a dollar amount.
 *
 * So the rand is attached HERE, at the seam, before any amount reaches the
 * model or a client. Formatting is deliberately locale-independent: the ICU
 * `en-ZA` locale renders 1234.5 as "1 234,50" (narrow space, comma decimal),
 * which varies with the Node build's ICU data and reads oddly on WhatsApp.
 *
 * No side-effecting imports — unit-testable in isolation.
 */

/**
 * Format an amount as rands: `R1,234.56`. Always two decimals, comma
 * thousands separators, no space after the R.
 */
export function formatZar(amount: number): string {
    if (!Number.isFinite(amount)) return 'R0.00';
    const negative = amount < 0;
    const [whole, cents] = Math.abs(amount).toFixed(2).split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${negative ? '-' : ''}R${grouped}.${cents}`;
}
