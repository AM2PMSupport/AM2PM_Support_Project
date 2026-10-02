/**
 * CallerDesk telephony adapter — API click-to-call + call webhooks.
 *
 * Checked against CallerDesk's published API docs (https://api.callerdesk.io,
 * Postman collection, read 2026-10-02):
 *
 *   Click-to-call  GET https://app.callerdesk.io/api/click_to_call_v2
 *     calling_party_a  agent (rings first)      calling_party_b  customer
 *     deskphone        DID as registered (leading 0)
 *     authcode         API key                  call_from_did    always "1" (mandatory)
 *     → {"type":"success","message":"…","campid":3494xx9,"callerid":"…"}
 *     `campid` is the call's id; the call report echoes it for OUTGOING calls.
 *
 *   Webhooks (CallerDesk → Settings → Webhook; GET query string or POST JSON)
 *     Call Report (end of call): type="call_report", SourceNumber,
 *       DestinationNumber (the DID/VN), DialWhomNumber, CallDuration,
 *       TalkDuration, Status (ANSWER, BUSY, CANCEL, NOANSWER, …), StartTime,
 *       EndTime ("yyyy-mm-dd hh:mm:ss", IST), CallSid, Uniqueid, campid,
 *       CallRecordingUrl, Direction (IVR = incoming, WEBOBD = outgoing),
 *       receiver_name, error_code, hangup_cause ("ANSWER(16-customer)"),
 *       LegA_Picked_time, LegB_Start_time, LegB_Picked_time.
 *     Live Call (during the call): SourceNumber, DestinationNumber,
 *       DialWhomNumber, Status, StartTime, CallSid, Direction, call_group.
 *
 *   Legs: OUTGOING (WEBOBD) SourceNumber = leg A = agent, DialWhomNumber =
 *   leg B = customer. INCOMING (IVR) SourceNumber = caller, DialWhomNumber =
 *   the agent who answered. Numbers may carry a leading 0 → last 10 digits.
 *
 * Older crmv7 field names are kept as fallbacks. Keep every CallerDesk-specific
 * name inside this file so fixing one is a one-line change.
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
const CALL_LIST_URL = "https://app.callerdesk.io/api/call_list_v2"; // Call Report API (POST form, 25 rows/page)
const TIMEOUT_MS = 8_000;

/** First non-empty string among the given payload fields. */
function field(p: Record<string, unknown>, ...names: string[]): string {
  for (const n of names) {
    const v = p[n];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

/**
 * CallerDesk times are "yyyy-mm-dd hh:mm:ss" in IST with no zone (GET samples
 * sometimes show "2020-04-09n13:46:56"). Read them as +05:30, not as UTC.
 */
export function parseTime(v: string): Date {
  const m = /^(\d{4}-\d{2}-\d{2})[ Tn](\d{2}:\d{2}:\d{2})$/.exec(v.trim());
  const t = m ? new Date(`${m[1]}T${m[2]}+05:30`) : v ? new Date(v) : new Date();
  return Number.isNaN(t.getTime()) ? new Date() : t;
}

/** Map CallerDesk status words to our event kinds. Unknown words → undefined (ignored). */
function statusToKind(raw: string, direction: "inbound" | "outbound"): CallEventKind | undefined {
  const s = raw.toLowerCase();
  if (/no.?answer|not.?answered|noanswer/.test(s)) return direction === "inbound" ? "missed" : "no_answer";
  if (/missed/.test(s)) return "missed";
  if (/busy/.test(s)) return "busy";
  if (/fail|cancel|reject/.test(s)) return "failed";
  if (/^answer$|answered|connected|bridged|picked|talking/.test(s)) return "answered";
  if (/complete|ended|hangup|call_report/.test(s)) return "completed";
  if (/ring|transferring|initiat/.test(s)) return "customer_ringing";
  return undefined;
}

/**
 * End-of-call result from a Call Report. Outgoing calls use the leg times:
 * agent never picked → agent_no_answer; customer never picked → busy /
 * no_answer; both picked → completed. Incoming: ANSWER → completed, else missed.
 */
function reportKind(p: Record<string, unknown>, status: string, direction: "inbound" | "outbound"): CallEventKind | undefined {
  const s = status.toLowerCase();
  const answered = /^answer/.test(s) || /answered|connected/.test(s);
  if (direction === "inbound") return answered ? "completed" : "missed";
  const legA = !!field(p, "LegA_Picked_time"); // agent picked up
  const legB = !!field(p, "LegB_Picked_time"); // customer picked up
  if (answered || (legA && legB)) return "completed";
  if (!legA) return "agent_no_answer"; // the agent's phone never answered
  if (/busy|engaged/.test(s)) return "busy";
  if (/fail|error|reject|congestion/.test(s)) return "failed";
  return "no_answer"; // agent answered, customer didn't (CANCEL / NOANSWER)
}

/** In-call progress from a Live Call webhook (or older status words). */
function liveKind(status: string, direction: "inbound" | "outbound"): CallEventKind | undefined {
  return statusToKind(status, direction);
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

/**
 * The secret a webhook request presents: path form …/callerdesk/<secret>
 * (survives providers that drop or rewrite query strings on POST), else
 * `?key=` — tolerating a provider appending "?a=1" to it (key="SECRET?a=1").
 */
export function presentedWebhookKey(req: Request): string {
  const url = new URL(req.url);
  const inPath = /\/telephony\/callerdesk\/([A-Za-z0-9_-]{16,})\/?$/.exec(url.pathname)?.[1];
  return inPath ?? (url.searchParams.get("key") ?? "").split("?")[0]!;
}

/** "0000-00-00 00:00:00" (never happened) → "". */
const realTime = (v: unknown) => {
  const t = typeof v === "string" ? v.trim() : "";
  return t && !t.startsWith("0000") ? t : "";
};

/**
 * Call Report API row → the same shape as a Call Report webhook, so ONE parser
 * (parseWebhook) handles both. Row fields per docs: caller_num, member_num,
 * deskphone, sid_id, file, startdatetime, enddatetime, total_duration,
 * talk_duration, callresult, callstatus, Flow_type (IVR/WEBOBD), Leg* times.
 * For both directions member_num = our agent and caller_num = the customer.
 */
export function callListRowToReport(r: Record<string, unknown>): Record<string, unknown> {
  const outbound = String(r.Flow_type ?? "").toUpperCase() !== "IVR";
  const agent = String(r.member_num ?? "");
  const customer = String(r.caller_num ?? "");
  return {
    type: "call_report",
    Direction: outbound ? "WEBOBD" : "IVR",
    SourceNumber: outbound ? agent : customer,
    DialWhomNumber: outbound ? customer : agent,
    DestinationNumber: String(r.deskphone ?? ""),
    CallSid: String(r.sid_id ?? r.id ?? ""),
    Status: String(r.callstatus || r.callresult || ""),
    StartTime: realTime(r.startdatetime),
    EndTime: realTime(r.enddatetime) || realTime(r.call_date),
    CallDuration: String(r.total_duration ?? ""),
    TalkDuration: String(r.talk_duration ?? ""),
    CallRecordingUrl: String(r.file ?? ""),
    LegA_Picked_time: realTime(r.LegA_Picked_time),
    LegB_Start_time: realTime(r.LegB_Start_time),
    LegB_Picked_time: realTime(r.LegB_Picked_time),
    receiver_name: String(r.member_name ?? ""),
  };
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
      call_from_did: "1", // mandatory per CallerDesk docs
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
      // `campid` comes back again in the call report of this outgoing call.
      return { ok: true, providerCallId: field(body, "campid", "call_id", "callid", "unique_id") || undefined };
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
   * webhook URL carries a secret (shown once to the admin) — in the PATH
   * (…/telephony/callerdesk/<secret>, current) or as `?key=` (older URLs).
   * We compare hashes in constant time.
   */
  async verifyWebhook(req: Request, _rawBody: string, secret: string | undefined): Promise<boolean> {
    if (!secret) return false;
    const key = presentedWebhookKey(req);
    return safeEqualHex(sha256Hex(key), sha256Hex(secret));
  },

  parseWebhook(p: Record<string, unknown>, ctx: { registeredDids: string[] }): NormalisedCallEvent[] {
    const rawDirection = field(p, "Direction", "Call Direction", "call_direction", "direction").toLowerCase();
    const direction: "inbound" | "outbound" = /ivr|inbound|incoming/.test(rawDirection) ? "inbound" : "outbound";
    const status = field(p, "Status", "call_status", "CallStatus", "status", "event");
    const isReport = field(p, "type").toLowerCase() === "call_report" || !!field(p, "EndTime", "CallDuration", "end_time");

    // Who is who (see header): outgoing → Source = agent, DialWhom = customer; incoming → reverse.
    const source = toTenDigits(field(p, "SourceNumber", "calling_party_a", "src", "from"));
    const dialWhom = toTenDigits(field(p, "DialWhomNumber", "calling_party_b", "dst", "to"));
    const explicitAgent = toTenDigits(field(p, "agent_number", "AgentNumber", "answered_by"));
    let agentNumber: string | undefined;
    let customerNumber: string;
    if (direction === "outbound") {
      agentNumber = explicitAgent || source || undefined;
      customerNumber = field(p, "customer_number", "cparty_number") ? toTenDigits(field(p, "customer_number", "cparty_number")) : dialWhom || resolveCustomerNumber(p, new Set(agentNumber ? [agentNumber] : []));
    } else {
      agentNumber = explicitAgent || dialWhom || undefined;
      customerNumber = source || resolveCustomerNumber(p, new Set(agentNumber ? [agentNumber] : []));
    }

    const kind = isReport ? reportKind(p, status, direction) : liveKind(status, direction);
    if (!kind) return [];

    const hangup = field(p, "hangup_cause").toLowerCase();
    const events: NormalisedCallEvent[] = [
      {
        kind,
        direction,
        // Outgoing: campid (returned by click-to-call). Incoming: CallSid / Uniqueid.
        providerCallId: (direction === "outbound" ? field(p, "campid") : "") || field(p, "CallSid", "Uniqueid", "call_id", "callid", "unique_id") || undefined,
        correlationId: field(p, "custom_field", "correlation_id") || undefined,
        did: canonicalDid(field(p, "DestinationNumber", "did", "DID", "deskphone", "virtual_number"), ctx.registeredDids),
        customerNumber,
        agentNumber,
        at: parseTime(field(p, "EndTime", "end_time", "LegB_Picked_time", "StartTime", "start_time", "timestamp")),
        durationSec: Number(digitsOnly(field(p, "CallDuration", "total_duration", "duration"))) || undefined,
        talkSec: Number(digitsOnly(field(p, "TalkDuration", "talk_duration", "billsec"))) || undefined,
        hangupBy: /customer/.test(hangup) ? "customer" : /agent|member/.test(hangup) ? "agent" : undefined,
      },
    ];

    const recordingUrl = field(p, "CallRecordingUrl", "recording_url", "RecordingUrl", "file_url");
    if (recordingUrl.startsWith("https://")) {
      events.push({ ...events[0]!, kind: "recording_ready", recordingUrl });
    }
    return events;
  },

  async fetchCallReportPage(creds: ProviderCredentials, q: { date: string; page: number }) {
    if (!creds.authCode) return { rows: [], lastPage: true };
    const form = new FormData();
    form.set("authcode", creds.authCode);
    form.set("start_date", q.date);
    form.set("end_date", q.date);
    form.set("current_page", String(q.page));
    form.set("per_page", "25");
    const res = await fetch(CALL_LIST_URL, { method: "POST", body: form, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`CallerDesk call report: non-JSON response (HTTP ${res.status})`);
    }
    if (field(body, "type").toLowerCase() !== "success") {
      // No calls that day comes back as an error type on some accounts.
      if (/no.?record|not.?found|no.?data/i.test(field(body, "message"))) return { rows: [], lastPage: true };
      throw new Error(`CallerDesk call report: ${field(body, "message", "error") || `HTTP ${res.status}`}`);
    }
    const result = Array.isArray(body.result) ? (body.result as Record<string, unknown>[]) : [];
    const total = Number(body.total ?? 0);
    return { rows: result.map(callListRowToReport), lastPage: result.length < 25 || q.page * 25 >= total };
  },
};
