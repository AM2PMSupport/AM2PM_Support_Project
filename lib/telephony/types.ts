/**
 * Telephony adapter contract (DESIGN.md §5.1).
 *
 * The CRM uses API click-to-call ONLY — no SIP, PBX, WebRTC or browser audio
 * (RULE.md §6.1). A provider therefore needs exactly three capabilities:
 *
 *   clickToCall   ask the provider to ring the agent's phone, then the
 *                 customer, and bridge them (outbound)
 *   verifyWebhook prove a webhook really came from the provider
 *   parseWebhook  turn the provider's payload into NormalisedCallEvents
 *                 (inbound AND outbound calls)
 *
 * Adding MyOperator or Exotel = one new folder under
 * lib/providers/telephony/ implementing this interface + one line in
 * lib/telephony/registry.ts. Nothing else in the CRM changes.
 */

export interface ClickToCallInput {
  /** Agent's registered phone (leg A). Provider-specific format applied by the adapter. */
  agentNumber: string;
  /** Customer phone (leg B). */
  customerNumber: string;
  /** DID shown to the customer, exactly as registered. */
  callerId: string;
  /** Our interaction id; passed to the provider when it supports a custom field. */
  correlationId: string;
}

export type ClickToCallResult =
  | { ok: true; providerCallId?: string }
  /** `code` is stable for our UI; `message` is safe to show the agent. */
  | { ok: false; code: string; message: string };

export type CallEventKind =
  | "agent_ringing"
  | "agent_answered"
  | "agent_no_answer"
  | "customer_ringing"
  | "answered"
  | "busy"
  | "no_answer"
  | "failed"
  | "completed"
  | "missed"
  | "recording_ready";

export interface NormalisedCallEvent {
  kind: CallEventKind;
  direction: "inbound" | "outbound";
  providerCallId?: string;
  correlationId?: string;
  /** DID involved (dialled number for inbound, caller ID for outbound). */
  did: string;
  customerNumber: string;
  agentNumber?: string;
  at: Date;
  durationSec?: number;
  talkSec?: number;
  recordingUrl?: string;
  hangupBy?: "agent" | "customer" | "system";
}

export interface ProviderCredentials {
  /** Decrypted at call time from integrations.credentialsEnc; never logged. */
  [key: string]: string;
}

export interface TelephonyAdapter {
  readonly name: string;
  clickToCall(input: ClickToCallInput, creds: ProviderCredentials): Promise<ClickToCallResult>;
  verifyWebhook(req: Request, rawBody: string, secret: string | undefined): Promise<boolean>;
  parseWebhook(payload: Record<string, unknown>, ctx: { registeredDids: string[] }): NormalisedCallEvent[];
}
