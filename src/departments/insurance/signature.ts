// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/signature.ts (commit fb95cdd). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5176 (TTTFG-5254 step 11): the default signing seam. Tina calls requestClaimSignature(claimId) at the end of
// the conversation, once every item is in or passed over (TTTFG-5196 moved it there from after the last form
// question). TTTFG-5192 fills the form and TTTFG-5196 sends the signing link; until both are wired in, this stub answers
// 'notAvailable', so the claim keeps its status and the closing line has no sign line.
//
// TTTFG-5192 owns the real implementation (signature-fill.ts) and swaps it in at merge. This file stays the default.
import type { RequestClaimSignature } from './contracts';

export const requestClaimSignature: RequestClaimSignature = async () => 'notAvailable';
