// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/signature.ts (commit 0f9ac1f). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5176 (TTTFG-5254 step 11): the default signing seam. Tina calls requestClaimSignature(claimId) once the last
// form question is answered. TTTFG-5192 fills the form and TTTFG-5196 sends the signing link; until both are wired in,
// this stub answers 'notAvailable', so the claim keeps its status and Tina moves straight on to the evidence.
//
// TTTFG-5192 owns the real implementation (signature-fill.ts) and swaps it in at merge. This file stays the default.
import type { RequestClaimSignature } from './contracts';

export const requestClaimSignature: RequestClaimSignature = async () => 'notAvailable';
