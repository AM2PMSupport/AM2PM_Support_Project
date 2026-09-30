/**
 * Call status transitions (DESIGN.md §5.2). Pure functions.
 *
 * Webhooks can arrive late, twice, or out of order. These rules make applying
 * them idempotent and monotonic: a call never moves backwards (a late
 * "customer_ringing" cannot undo "answered"), and terminal states are final —
 * except "unknown", which the stuck-call sweeper sets and a late real webhook
 * may still correct.
 *
 *   outbound: initiated → agent_ringing → customer_ringing → answered → completed
 *                          └→ agent_no_answer      └→ busy | no_answer | failed
 *   inbound:  ringing → answered → completed        └→ missed
 */
import type { InboundCallStatus, OutboundCallStatus } from "@/lib/db/schema";
import type { CallEventKind } from "@/lib/telephony/types";

const OUTBOUND_RANK: Record<OutboundCallStatus, number> = {
  initiated: 0,
  agent_ringing: 1,
  customer_ringing: 2,
  answered: 3,
  // Terminal states share the top rank.
  agent_no_answer: 9,
  busy: 9,
  no_answer: 9,
  failed: 9,
  completed: 9,
  unknown: 8, // sweeper verdict; a late real terminal event may overwrite it
};

const OUTBOUND_EVENT_TO_STATUS: Partial<Record<CallEventKind, OutboundCallStatus>> = {
  agent_ringing: "agent_ringing",
  agent_answered: "agent_ringing", // agent picked up; customer leg not yet ringing
  agent_no_answer: "agent_no_answer",
  customer_ringing: "customer_ringing",
  answered: "answered",
  busy: "busy",
  no_answer: "no_answer",
  failed: "failed",
  completed: "completed",
};

export const OUTBOUND_TERMINAL: ReadonlySet<OutboundCallStatus> = new Set([
  "agent_no_answer",
  "busy",
  "no_answer",
  "failed",
  "completed",
  "unknown",
]);

/** New outbound status after an event, or null when the event must be ignored. */
export function nextOutboundStatus(current: OutboundCallStatus, event: CallEventKind): OutboundCallStatus | null {
  const target = OUTBOUND_EVENT_TO_STATUS[event];
  if (!target || target === current) return null;
  if (current === "unknown") return OUTBOUND_RANK[target] >= OUTBOUND_RANK.answered ? target : null;
  if (OUTBOUND_RANK[current] === 9) return null; // terminal
  return OUTBOUND_RANK[target] > OUTBOUND_RANK[current] ? target : null;
}

const INBOUND_RANK: Record<InboundCallStatus, number> = { ringing: 0, answered: 1, missed: 9, completed: 9 };

const INBOUND_EVENT_TO_STATUS: Partial<Record<CallEventKind, InboundCallStatus>> = {
  agent_ringing: "ringing",
  customer_ringing: "ringing",
  agent_answered: "answered",
  answered: "answered",
  missed: "missed",
  no_answer: "missed",
  agent_no_answer: "missed",
  busy: "missed",
  failed: "missed",
  completed: "completed",
};

export function nextInboundStatus(current: InboundCallStatus, event: CallEventKind): InboundCallStatus | null {
  const target = INBOUND_EVENT_TO_STATUS[event];
  if (!target || target === current || INBOUND_RANK[current] === 9) return null;
  // A "completed" call that was never answered is really a missed call.
  if (target === "completed" && current === "ringing") return "missed";
  return INBOUND_RANK[target] > INBOUND_RANK[current] ? target : null;
}

/** Did the customer actually talk to the agent? (counts as an attempt + needs disposition) */
export function wasConnected(status: string): boolean {
  return status === "answered" || status === "completed";
}
