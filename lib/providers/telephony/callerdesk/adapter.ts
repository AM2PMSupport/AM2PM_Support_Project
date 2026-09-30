/**
 * CallerDesk telephony adapter — API click-to-call + call webhooks.
 *
 * Ported from crmv7.gs (MEMORIE.md §6):
 *   - click-to-call endpoint `click_to_call_v2` (GET); numbers are sent as
 *     10 digits WITHOUT country code; the DID keeps its leading 0.
 *   - caller-leg recovery: once a call bridges, CallerDesk may report the
 *     agent's number as the source; `resolveCustomerNumber` prefers the
 *     customer-side fields and falls back to "the number that is not the
 *     agent" (crmv7 resolveCustomerPhone_).
 *
 * VERIFY BEFORE GO-LIVE (TASK.md T0.7 / T0.9): query-parameter and webhook
 * field names below come from crmv7 and are not yet checked against
 * CallerDesk's current API docs or real payload samples. Keep every
 * CallerDesk-specific name inside this file so fixing one is a one-line change.
 */
import { safeEqualHex, sha256Hex } from "@/lib/crypto";
import { canonicalDid, digitsOnly, toTenDigits } from "@/lib/phone/phone";
import type {
  CallEventKind,
  ClickToCallInput,
  ClickToCallResult,
  NormalisedCallEvent,
  ProviderCredentials,
  TelephonyAdapter,
} from "@/lib/telephony/types";

const CLICK_TO_CALL_URL = "https://app.callerdesk.io/api/click_to_call_v2";
const TIMEOUT_MS = 8_000;

/** First non-empty string among the given payload fields. */
function field(p: Record<string, unknown>, ...names: string[]): string {
  for (const n of names) {
    const v = p[n];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

/** Provider timestamp, or "now" when missing/unparseable. */
function parseTime(v: string): Date {
  const t = v ? new Date(v) : new Date();
  return Number.isNaN(t.getTime()) ? new Date() : t;
}

/** Map CallerDesk status words to our event kinds. Unknown words → undefined (ignored). */
function statusToKind(raw: string, direction: "inbound" | "outbound"): CallEventKind | undefined {
  const s = raw.toLowerCase();
  if (/no.?answer|not.?answered|noanswer/.test(s)) return direction === "inbound" ? "missed" : "no_answer";
  if (/missed/.test(s)) return "missed";
  if (/busy/.test(s)) return "busy";
  if (/fail|cancel|reject/.test(s)) return "failed";
  if (/answered|connected|bridged/.test(s)) return "answered";
  if (/complete|ended|hangup|call_report/.test(s)) return "completed";
  if (/ring|transferring|initiat/.test(s)) return "customer_ringing";
  return undefined;
}

/** crmv7 resolveCustomerPhone_: pick the leg that is NOT the agent. */
export function resolveCustomerNumber(p: Record<string, unknown>, agentNumbers: ReadonlySet<string> = new Set()): string {
  const candidates = [
    field(p, "customer_number", "cparty_number", "calling_party_b"),
    field(p, "DestinationNumber", "dst", "to"),
    field(p, "SourceNumber", "calling_party_a", "src", "from"),
    field(p, "DialWhomNumber"),
  ]
    .map(toTenDigits)
    .filter((n) => n.length === 10);
  return candidates.find((n) => !agentNumbers.has(n)) ?? candidates[0] ?? "";
}

export const callerDeskAdapter: TelephonyAdapter = {
  name: "callerdesk",

  async clickToCall(input: ClickToCallInput, creds: ProviderCredentials): Promise<ClickToCallResult> {
    const authCode = creds.authCode;
    if (!authCode) return { ok: false, code: "not_configured", message: "CallerDesk is not configured for this client." };

    const params = new URLSearchParams({
      authcode: authCode,
      calling_party_a: toTenDigits(input.agentNumber), // agent phone rings first
      calling_party_b: toTenDigits(input.customerNumber), // then the customer
      deskphone: input.callerId, // DID as registered (leading 0 kept)
      // Correlation: CallerDesk may echo custom params in webhooks (to verify, T0.9).
      custom_field: input.correlationId,
    });

    let res: Response;
    try {
      res = await fetch(`${CLICK_TO_CALL_URL}?${params.toString()}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      return { ok: false, code: "provider_unreachable", message: "Could not reach CallerDesk. Try again in a moment." };
    }
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* non-JSON error page */
    }

    const type = field(body, "type", "status").toLowerCase();
    if (res.ok && (type === "success" || type === "true" || body.status === true)) {
      return { ok: true, providerCallId: field(body, "call_id", "callid", "unique_id") || undefined };
    }

    // Translate known errors into messages an agent can act on.
    const message = field(body, "message", "error") || `HTTP ${res.status}`;
    if (/deskphone/i.test(message)) return { ok: false, code: "invalid_did", message: "The caller-ID number (DID) is not valid for this account." };
    if (/balance|credit/i.test(message)) return { ok: false, code: "no_balance", message: "Calling balance is low. Tell your admin." };
    if (/auth/i.test(message)) return { ok: false, code: "auth_failed", message: "CallerDesk rejected the account credentials." };
    return { ok: false, code: "provider_error", message: `CallerDesk: ${message}` };
  },

  /**
   * CallerDesk webhooks carry no signature we can rely on, so each tenant's
   * webhook URL includes a secret `?key=` (shown once to the admin). We
   * compare hashes in constant time.
   */
  async verifyWebhook(req: Request, _rawBody: string, secret: string | undefined): Promise<boolean> {
    if (!secret) return false;
    const key = new URL(req.url).searchParams.get("key") ?? "";
    return safeEqualHex(sha256Hex(key), sha256Hex(secret));
  },

  parseWebhook(p: Record<string, unknown>, ctx: { registeredDids: string[] }): NormalisedCallEvent[] {
    const rawDirection = field(p, "Call Direction", "call_direction", "direction", "type").toLowerCase();
    const direction: "inbound" | "outbound" = /ivr|inbound|incoming/.test(rawDirection) ? "inbound" : "outbound";

    const kind = statusToKind(field(p, "call_status", "CallStatus", "status", "event", "Status"), direction);
    if (!kind) return [];

    const agentNumber = toTenDigits(field(p, "agent_number", "AgentNumber", "calling_party_a", "answered_by")) || undefined;
    const events: NormalisedCallEvent[] = [
      {
        kind,
        direction,
        providerCallId: field(p, "call_id", "callid", "unique_id", "CallSid") || undefined,
        correlationId: field(p, "custom_field", "correlation_id") || undefined,
        did: canonicalDid(field(p, "did", "DID", "deskphone", "virtual_number"), ctx.registeredDids),
        customerNumber: resolveCustomerNumber(p, new Set(agentNumber ? [agentNumber] : [])),
        agentNumber,
        at: parseTime(field(p, "end_time", "start_time", "timestamp")),
        durationSec: Number(digitsOnly(field(p, "total_duration", "duration"))) || undefined,
        talkSec: Number(digitsOnly(field(p, "talk_duration", "billsec"))) || undefined,
        hangupBy: undefined,
      },
    ];

    const recordingUrl = field(p, "recording_url", "RecordingUrl", "file_url");
    if (recordingUrl.startsWith("https://")) {
      events.push({ ...events[0]!, kind: "recording_ready", recordingUrl });
    }
    return events;
  },
};
