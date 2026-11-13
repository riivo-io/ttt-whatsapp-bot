// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/roadside-turn.ts (commit e7a8dfa). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5299: what the host calls for roadside help. One message in: a known client (roadside.ts) or an unknown number
// (roadside-unknown.ts), first message or a reply. The state the host keeps says which.
import type { Conversation } from './claim';
import { roadsideClientReply, roadsideForClient, type RoadsidePorts, type RoadsideResult, type RoadsideState } from './roadside';
import type { RoadsideRoute } from './roadside-intent';
import { roadsideFromUnknown, roadsideFromUnknownReply } from './roadside-unknown';

/** The first roadside message. `contact`: the client Tina resolved from the WhatsApp number; null for an unknown number. */
export function roadsideStart(
  ports: RoadsidePorts, conv: Conversation, contact: { id: string; firstName: string } | null, route: RoadsideRoute, text: string, now: Date,
): Promise<RoadsideResult> {
  return contact ? roadsideForClient(ports, conv, contact, route, text, now) : roadsideFromUnknown(ports, conv, route, text, now);
}

/** The next message in a roadside conversation the host kept. */
export function roadsideReply(ports: RoadsidePorts, conv: Conversation, state: RoadsideState, text: string, now: Date): Promise<RoadsideResult> {
  return state.contactId ? roadsideClientReply(ports, conv, state, text, now) : roadsideFromUnknownReply(ports, conv, state, text, now);
}

/** A stored conversation is roadside's (the host keeps it where it keeps the claim walkthrough). */
export const isRoadside = (state: unknown): state is RoadsideState => !!state && typeof state === 'object' && (state as { roadside?: unknown }).roadside === true;
