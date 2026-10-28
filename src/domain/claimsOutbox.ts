/**
 * TTTFG-4830 (claims demo, 28 Oct 2026): one message per client message, and taps instead of typing.
 *
 * A turn of the claims package may say several things in a row: a voice note said back, then the next questions; the
 * acknowledgement, then the first question; the closing line, then the signing link. Sent one by one they arrive as two
 * or three messages back to back. The outbox keeps them until the turn is over and sends them joined, a blank line
 * apart, as one message. It starts a new message only where the joined text would pass `maxChars`, so the client never
 * has to tap "Read more" or scroll a whole screen (CLAIMS_MESSAGE_MAX_CHARS; 0 sends each part on its own, as before).
 *
 * A part that asks one closed question carries its `choices` (claim.ts Choice). They go as WhatsApp reply buttons (up
 * to three short ones) or a list (up to ten); otherwise as numbered lines under the text, which the client answers by
 * typing. A tap comes back with the choice's id, `claims:` and what the tap says, which Tina reads as if typed.
 *
 * Pure: the sends are injected.
 */
import type { Choice } from '../departments/insurance/claim';

export interface OutPart { text: string; choices?: Choice[] }

/**
 * CLAIMS_MESSAGE_MAX_CHARS: how long one message may get before the rest goes in the next one. Default 700, about half
 * a phone screen; 0 sends every part on its own.
 */
export function messageMaxChars(raw: string | undefined, fallback = 700): number {
    const n = raw === undefined || raw.trim() === '' ? fallback : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * One turn's parts as the messages that go out, in order. A part is joined to the one before while the two fit in
 * `maxChars`. A part with choices ends its message, so its buttons stay under the question they answer.
 */
export function joinParts(parts: readonly OutPart[], maxChars: number): OutPart[] {
    const out: OutPart[] = [];
    for (const p of parts) {
        const last = out.at(-1);
        const joined = last ? `${last.text}\n\n${p.text}` : '';
        if (last && !last.choices?.length && maxChars > 0 && joined.length <= maxChars) {
            out[out.length - 1] = { text: joined, ...(p.choices?.length ? { choices: p.choices } : {}) };
        } else {
            out.push(p.choices?.length ? { text: p.text, choices: p.choices } : { text: p.text });
        }
    }
    return out;
}

/** Keeps what a turn says, per recipient, until flush() sends it joined (joinParts). */
export function outbox(send: (to: string, m: OutPart) => Promise<void>, maxChars: number) {
    const queue: { to: string; part: OutPart }[] = [];
    return {
        push(to: string, part: OutPart): void {
            queue.push({ to, part });
        },
        async flush(): Promise<void> {
            const pending = queue.splice(0);
            for (const to of [...new Set(pending.map((p) => p.to))]) {
                for (const m of joinParts(pending.filter((p) => p.to === to).map((p) => p.part), maxChars)) await send(to, m);
            }
        },
    };
}

/** Meta's limits for interactive messages (Cloud API). */
const BUTTONS = 3;
const BUTTON_TITLE = 20;
const BUTTON_BODY = 1024;
const ROWS = 10;
const ROW_TITLE = 24;
const ROW_DESCRIPTION = 72;
const LIST_BODY = 4096;
const ID = 200;
export const LIST_BUTTON = 'Choose one';

/** The prefix of a claims choice's id, so a tap on one is told apart from Tina's other buttons. */
export const CHOICE_ID = 'claims:';
export const choiceId = (c: Choice) => `${CHOICE_ID}${c.reply ?? c.title}`.slice(0, ID);
/** What a tap on a claims choice says, or null for any other tap (or a typed message). */
export const tappedText = (interactiveId: string | undefined): string | null =>
    interactiveId?.startsWith(CHOICE_ID) ? interactiveId.slice(CHOICE_ID.length) : null;

/** A title cut to `max` at a word, with "…". */
function cut(t: string, max: number): string {
    if (t.length <= max) return t;
    const room = t.slice(0, max - 1);
    const word = room.lastIndexOf(' ');
    return `${(word > max / 2 ? room.slice(0, word) : room).replace(/[\s,.;:-]+$/, '')}…`;
}

export type Interactive =
    | { type: 'button'; body: { text: string }; action: { buttons: { type: 'reply'; reply: { id: string; title: string } }[] } }
    | { type: 'list'; body: { text: string }; action: { button: string; sections: { title: string; rows: { id: string; title: string; description?: string }[] }[] } };

/**
 * The WhatsApp message for a text and its choices: reply buttons for up to three titles that fit a button, else a list
 * for up to ten (a long title cut, with the whole of it as the row's description). Null when neither fits: the choices
 * go as numbered lines (withChoiceLines).
 */
export function interactiveFor(text: string, choices: readonly Choice[]): Interactive | null {
    if (!choices.length) return null;
    if (choices.length <= BUTTONS && text.length <= BUTTON_BODY && choices.every((c) => c.title.length <= BUTTON_TITLE)) {
        return { type: 'button', body: { text }, action: { buttons: choices.map((c) => ({ type: 'reply', reply: { id: choiceId(c), title: c.title } })) } };
    }
    if (choices.length > ROWS || text.length > LIST_BODY) return null;
    const rows = choices.map((c) => {
        const title = cut(c.title, ROW_TITLE);
        const description = c.description ?? (title === c.title ? undefined : c.title);
        return { id: choiceId(c), title, ...(description ? { description: cut(description, ROW_DESCRIPTION) } : {}) };
    });
    return { type: 'list', body: { text }, action: { button: LIST_BUTTON, sections: [{ title: LIST_BUTTON, rows }] } };
}

/** The choices as numbered lines under the text, when they can't be buttons or a list. */
export const withChoiceLines = (text: string, choices: readonly Choice[]) =>
    `${text}\n\n${choices.map((c, i) => `${i + 1}. ${c.title}${c.description ? ` (${c.description})` : ''}`).join('\n')}`;

/** How a message with choices is written in the conversation log: the text, then what could be tapped. */
export const loggedText = (m: OutPart) => (m.choices?.length ? `${m.text}\n[${m.choices.map((c) => c.title).join(' | ')}]` : m.text);
