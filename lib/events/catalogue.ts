/**
 * Outbound event catalogue (DESIGN.md §6.1).
 *
 * These names are a public contract with client systems: add new events
 * freely, but never rename or change the meaning of an existing one.
 */
export const EVENT_TYPES = [
  "lead.created",
  "lead.assigned",
  "disposition.set",
  "lead.stage_changed",
  "lead.converted",
  "lead.lost",
  "callback.missed",
  "call.completed",
  "call.missed",
  "backup.completed",
  "backup.failed",
  "restore.completed",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** The JSON body POSTed to subscribers. `id` is stable so receivers can dedupe. */
export interface EventEnvelope {
  id: string;
  type: EventType;
  tenant: string;
  occurredAt: string;
  data: Record<string, unknown>;
}
