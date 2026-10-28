// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/gate.ts (commit ba38887). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5168 AC 9: the claim-outcome rule of the policy gate (SPEC-04 "Policy gate", SPEC-05 "What Tina may and may
// not do"). Tina never says a claim is accepted, approved, paid or settled: that is the insurer's decision and the
// broker's message. The rule checks Tina's outbound text after it is generated, because a prompt instruction alone
// does not hold on every run ("Code enforces the gate, not only the prompt").
//
// It errs towards blocking. A blocked reply costs a holding line and a Follow-up for the broker; a reply that
// promises a payout costs TTT a complaint. A rejection ("your claim was not approved") is blocked too: a person tells
// the client about a rejection (SPEC-04 user story 42). A conditional clause ("whether it's approved is the
// insurer's decision", "once the insurer has approved it, your broker will tell you") states no outcome and passes.

/** Sent instead of a blocked reply. Fixed text, never generated. */
export const HOLDING_LINE = 'Thanks for your message. The person handling your claim will update you on its progress.';

const OUTCOME = '(?:accepted|approved|paid(?: out)?|settled|successful|declined|rejected|repudiated)';
const BE = "(?:is|was|has been|have been|had been|will be|would be|should be|'s been|'ll be|got|gets|been|being)";
const SUBJECT = '(?:claim|it|this|that)';
const PAYER =
  "(?:we|they|the insurer|your insurer|insurers?|the insurance company|TTT|Hybrid|Discovery(?: Insure)?|Momentum|Santam|OUTsurance|Old Mutual|King Price|MiWay|Hollard|Bryte|Dial Direct|Budget Insurance)";

const RULES: RegExp[] = [
  // "your claim has been approved", "it will be paid", "the claim is not approved", "claim was rejected"
  new RegExp(`\\b${SUBJECT}\\b[^.?!\\n]{0,30}?\\b${BE}\\s+(?:not\\s+|now\\s+|already\\s+|fully\\s+)?${OUTCOME}\\b`, 'gi'),
  // "it's approved", "the claim's been paid"
  new RegExp(`\\b${SUBJECT}'s\\s+(?:been\\s+|now\\s+|already\\s+|not\\s+)?${OUTCOME}\\b`, 'gi'),
  // "they've approved your claim", "the insurer will pay you", "Discovery has accepted"
  new RegExp(`\\b${PAYER}\\s*(?:will|'ll|have|'ve|has|had|are going to|is going to)\\s+(?:now\\s+|already\\s+)?(?:approve|approved|accept|accepted|pay|paid|settle|settled|pay out|paid out)\\b`, 'gi'),
  // "you will be paid", "you'll receive your payout", "you'll get the money"
  /\byou(?:'ll| will| are going to)\s+(?:be paid|be reimbursed|receive (?:your |the |a )?(?:payment|payout|settlement|money)|get (?:your |the |a )?(?:payment|payout|settlement|money))\b/gi,
  // "approved claim", "claim approval", "your payout", "payout of R5 000"
  /\b(?:claim approval|approved claim|your payout|payout of)\b/gi,
];

/** A clause that only describes what may happen ("whether", "if", "once" before the match) states no outcome. */
const CONDITIONAL = /\b(?:whether|if|once|when|until|unless|before|after)\b/i;

function conditional(text: string, at: number): boolean {
  const clauseStart = Math.max(text.lastIndexOf('.', at - 1), text.lastIndexOf('?', at - 1), text.lastIndexOf('!', at - 1), text.lastIndexOf('\n', at - 1), text.lastIndexOf(',', at - 1));
  return CONDITIONAL.test(text.slice(clauseStart + 1, at));
}

export type GateRule = 'claim-outcome' | 'claim-risk';
export type GateResult = { ok: true; text: string } | { ok: false; text: string; rule: GateRule; matched: string };

export function claimOutcomeGate(text: string): GateResult {
  const flat = text.replace(/[’‘]/g, "'");
  for (const rule of RULES) {
    for (const m of flat.matchAll(rule)) {
      if (!conditional(flat, m.index)) return { ok: false, text: HOLDING_LINE, rule: 'claim-outcome', matched: m[0] };
    }
  }
  return { ok: true, text };
}

// TTTFG-5176 (TTTFG-5254 step 7): the claim-risk rule. Tina never says or implies that a claim is at risk, late, may be
// rejected or may not be covered. Whether a late claim is still covered is the insurer's call and the broker's
// conversation, and TTT's claims guide and TCF forbid a message that threatens the claim. The notification deadline
// note and the duty of disclosure are fixed templates for this reason; this rule catches a generated reply (a
// rephrased question, an answer to the client) that slips through.
//
// No conditional exception here, unlike the claim-outcome rule. A condition is exactly how the threat is usually
// phrased ("if you report it late, your claim may be rejected"), so no clause shape is safe. A neutral sentence about
// who decides ("whether it's covered is the insurer's decision") never matches, because every rule below needs a
// negative, a modal of loss or a lateness word. Errs towards blocking: a blocked reply costs a holding line and a
// Follow-up; a threatening one costs TTT a complaint.

const LOSS = '(?:rejected|declined|repudiated|refused|denied|voided|turned down|cancell?ed|invalidated)';
const MAY = "(?:may|might|could|can|will|would|'ll|is likely to|are likely to|risks? being|at risk of being)";

const RISK_RULES: RegExp[] = [
  // "your claim is at risk", "this could jeopardise your claim", "put your claim in jeopardy"
  /\bat risk\b|\bjeopard\w*|\bin danger of\b/gi,
  // "it may be rejected", "your claim could be declined", "might not be paid"
  new RegExp(`\\b${MAY}\\s+(?:not\\s+|still\\s+|then\\s+|well\\s+)?(?:be\\s+)?${LOSS}\\b`, 'gi'),
  new RegExp(`\\b${MAY}\\s+not\\s+be\\s+paid(?: out)?\\b`, 'gi'),
  // "they could reject your claim", "the insurer may refuse it"
  new RegExp(`\\b${MAY}\\s+(?:\\w+\\s+)?(?:reject|decline|repudiate|refuse|deny|void|cancel|invalidate)\\s+(?:your|the|this|it|that)\\b`, 'gi'),
  // "your claim was rejected", "the claim gets declined", "this claim is void". Only "your/the/this claim": a form may
  // ask about the client's history ("Have you ever had a claim rejected?"), and that question must reach the client.
  new RegExp(`\\b(?:your|the|this)\\s+(?:claim|cover)\\b[^.?!\\n]{0,30}?\\b(?:${LOSS}|void|invalid|forfeited|lapsed|prejudiced|compromised)\\b`, 'gi'),
  // "you're not covered", "it won't be covered", "may not be covered", "no longer covered"
  /\b(?:not|n't|never|no longer)\s+(?:be\s+|being\s+|been\s+|fully\s+|still\s+|yet\s+)?covered\b/gi,
  // "you could lose your cover", "no cover", "the insurer may not pay", "won't cover it"
  /\blos(?:e|ing|t)\s+(?:your\s+|the\s+|this\s+)?(?:cover|claim|payout)\b|\bno\s+(?:longer\s+)?cover\b/gi,
  /\b(?:may|might|could|will|would)\s+not\s+(?:cover|pay)\b|\b(?:won't|wont|can't|cannot|doesn't|don't|didn't)\s+(?:cover|pay(?: out)?)\b/gi,
  // "the claim is late", "you reported it too late", "a late claim", "late notification"
  /\b(?:is|was|are|were|'s|'re|been|being|be|too|very|so|reported|reporting|notified|notifying|submitted|sent|claimed|claiming)\s+late\b(?!\s+(?:at night|in the (?:day|evening|afternoon)))/gi,
  /\blate\s+(?:claim|notification|notice|report(?:ing)?|submission)\b/gi,
  // "you've missed the deadline", "outside the notification period", "the deadline has passed", "time-barred"
  /\b(?:missed|past|passed|over|outside|beyond|exceeded?|after)\s+(?:the\s+|your\s+|its\s+|their\s+)?(?:deadline|notification period|time limit|reporting period|cut-?off)\b/gi,
  /\b(?:deadline|time limit|notification period)\s+(?:has|had|is|was)\s+(?:already\s+)?(?:passed|expired|over|gone)\b/gi,
  /\boverdue\b|\bout of time\b|\btime-?barred\b/gi,
  // "this could affect your claim", "it may harm your claim", "a problem with your claim"
  /\b(?:affect|harm|hurt|damage|weaken|prejudice|compromise|endanger|risk)\w*\s+(?:your|the|this)\s+claim\b|\bproblem\s+with\s+(?:your|the|this)\s+claim\b/gi,
];

export function claimRiskGate(text: string): GateResult {
  const flat = text.replace(/[’‘]/g, "'");
  for (const rule of RISK_RULES) {
    const m = rule.exec(flat);
    rule.lastIndex = 0;
    if (m) return { ok: false, text: HOLDING_LINE, rule: 'claim-risk', matched: m[0] };
  }
  return { ok: true, text };
}

/** Every outbound Tina claim text: the claim-outcome rule, then the claim-risk rule. */
export function claimGate(text: string): GateResult {
  const outcome = claimOutcomeGate(text);
  return outcome.ok ? claimRiskGate(text) : outcome;
}
