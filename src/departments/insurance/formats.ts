// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/formats.ts (commit 05d65be). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-4830: answers that don't look right. A phone number with a digit too many, an email address without its "@" or
// an ID number with a wrong check digit is almost always a typo, and on a claim form it means the insurer can't reach a
// witness or match a driver. Tina points it out once, in plain words, and asks again; followon.ts decides what happens.
//
// The format comes from the question's key, which every claim form config (TTTFG-5172) names the same way: `…Phone`,
// `…IdNumber`, `…Email`, and a contact question that asks for "phone number and email address". Only free-text
// questions are checked, and only what the client actually typed as a number or an address: "no", "don't know" and a
// passport number (letters as well as digits) pass, so no question becomes impossible to answer.
//
// Pure. South African numbers are the norm; a number starting with "+" and another country code is accepted at any
// usual length (8 to 15 digits).
import type { QuestionItem } from './contracts';

export type AnswerFormat = 'phone' | 'email' | 'sa-id' | 'contact';

/** The format a free-text question's answer should have, from its key (group entries `<key>.<n>` included). */
export function formatOf(item: Pick<QuestionItem, 'key' | 'kind' | 'answerType' | 'prompt'>): AnswerFormat | undefined {
  if (item.kind !== 'question' || item.answerType !== 'text') return undefined;
  const key = item.key.replace(/\.\d+$/, '');
  if (/IdNumber$/.test(key)) return 'sa-id';
  if (/Phone$/.test(key)) return 'phone';
  if (/Email$/i.test(key)) return 'email';
  if (/phone number/i.test(item.prompt) && /email/i.test(item.prompt)) return 'contact';
  return undefined;
}

const AGAIN = 'Could you check it and send it again?';
const EXAMPLE = 'like 082 123 4567';

/** What is wrong with one phone number as typed, or null. */
export function phoneProblem(typed: string): string | null {
  const digits = typed.replace(/\D/g, '');
  if (!digits) return null;
  const plus = typed.trim().startsWith('+');
  if (plus && !digits.startsWith('27')) {
    return digits.length >= 8 && digits.length <= 15 ? null : `That number has ${digits.length} digits, which doesn't look like a phone number. ${AGAIN}`;
  }
  if (digits.startsWith('27') && (plus || digits.length >= 11)) {
    const n = digits.length - 2;
    return n === 9 ? null : `That number has ${n} digits after the 27. A South African number has 9 after the 27, or 10 starting with 0 (${EXAMPLE}). ${AGAIN}`;
  }
  if (!digits.startsWith('0')) return `A South African phone number starts with 0 and has 10 digits, ${EXAMPLE}. ${AGAIN}`;
  if (digits.length !== 10) return `That number has ${digits.length} digits. A South African phone number has 10, ${EXAMPLE}. ${AGAIN}`;
  return null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/;

/** What is wrong with one email address as typed, or null. */
export function emailProblem(typed: string): string | null {
  const t = typed.trim().replace(/[.,;]+$/, '');
  if (!t.includes('@')) {
    // "clive.gmail.com": an address with the @ left out. Words ("no", "don't have one") aren't an address at all.
    return /^[^\s]+\.[a-z]{2,}$/i.test(t) && /[a-z]/i.test(t) && !/\s/.test(t) ? `That email address is missing the "@" (it should look like name@example.co.za). ${AGAIN}` : null;
  }
  return EMAIL.test(t) ? null : `That email address doesn't look complete. It should look like name@example.co.za. ${AGAIN}`;
}

/** The Luhn check South African ID numbers carry in their last digit. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** What is wrong with an ID number as typed, or null. Letters mean a passport number: not checked. */
export function idProblem(typed: string): string | null {
  const t = typed.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(t)) return null;
  if (t.length !== 13) return `That ID number has ${t.length} digits. A South African ID number has 13. ${AGAIN}`;
  const mm = Number(t.slice(2, 4));
  const dd = Number(t.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || !luhn(t)) return `That ID number doesn't look right: one of the digits seems to be off. ${AGAIN}`;
  return null;
}

/** Phone numbers inside free text: a run of digits (spaces, dashes and brackets allowed) at least 7 digits long. */
const PHONE_IN_TEXT = /\+?\(?\d[\d\s()-]{5,}\d/g;

/** What is wrong with the answer to this question, in words for the client, or null when it's fine (or not checked). */
export function formatProblem(item: Pick<QuestionItem, 'key' | 'kind' | 'answerType' | 'prompt'>, value: unknown): string | null {
  const format = formatOf(item);
  if (!format || typeof value !== 'string') return null;
  switch (format) {
    case 'phone':
      return phoneProblem(value);
    case 'email':
      return emailProblem(value);
    case 'sa-id':
      return idProblem(value);
    case 'contact': {
      for (const token of value.split(/[\s,;]+/).filter((x) => x.includes('@'))) {
        const p = emailProblem(token);
        if (p) return p;
      }
      for (const run of value.replace(/\S+@\S+/g, ' ').match(PHONE_IN_TEXT) ?? []) {
        const p = phoneProblem(run);
        if (p) return p;
      }
      return null;
    }
  }
}
