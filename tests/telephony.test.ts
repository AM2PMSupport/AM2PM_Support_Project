import { describe, expect, it } from "vitest";
import { nextInboundStatus, nextOutboundStatus } from "@/lib/telephony/state-machine";
import { afterEach, vi } from "vitest";
import { callerDeskAdapter, parseTime, resolveCustomerNumber } from "@/lib/providers/telephony/callerdesk/adapter";

// CallerDesk's documented Call Report sample (api.callerdesk.io, POST JSON), numbers anonymised.
const REPORT_OUT = {
  type: "call_report",
  SourceNumber: "09000000001", // leg A = agent (outgoing)
  DestinationNumber: "0806286123", // DID
  DialWhomNumber: "07652081234", // leg B = customer
  CallDuration: "26",
  coins: "2",
  Status: "ANSWER",
  StartTime: "2024-12-30 12:43:19",
  EndTime: "2024-12-30 12:43:45",
  CallSid: "8397472",
  CallRecordingUrl: "https://newcallrecords.callerdesk.io/outgoing/12_2024/x.wav",
  Direction: "WEBOBD",
  campid: "8397411",
  TalkDuration: "2",
  call_group: "",
  receiver_name: "Aniket",
  error_code: "0",
  LegA_Picked_time: "2024-12-30 12:43:27",
  LegB_Start_time: "2024-12-30 12:43:28",
  LegB_Picked_time: "2024-12-30 12:43:43",
  key_press: "",
  hangup_cause: "ANSWER(16-customer)",
  Uniqueid: "8397472",
};

describe("outbound click-to-call state machine", () => {
  it("moves forward through the happy path", () => {
    expect(nextOutboundStatus("initiated", "agent_ringing")).toBe("agent_ringing");
    expect(nextOutboundStatus("agent_ringing", "customer_ringing")).toBe("customer_ringing");
    expect(nextOutboundStatus("customer_ringing", "answered")).toBe("answered");
    expect(nextOutboundStatus("answered", "completed")).toBe("completed");
  });

  it("never moves backwards or out of a terminal state", () => {
    expect(nextOutboundStatus("answered", "customer_ringing")).toBeNull();
    expect(nextOutboundStatus("completed", "answered")).toBeNull();
    expect(nextOutboundStatus("failed", "completed")).toBeNull();
  });

  it("ignores duplicates", () => {
    expect(nextOutboundStatus("answered", "answered")).toBeNull();
  });

  it("lets a late real result correct the sweeper's 'unknown'", () => {
    expect(nextOutboundStatus("unknown", "completed")).toBe("completed");
    expect(nextOutboundStatus("unknown", "agent_ringing")).toBeNull();
  });
});

describe("inbound state machine", () => {
  it("ringing → answered → completed", () => {
    expect(nextInboundStatus("ringing", "answered")).toBe("answered");
    expect(nextInboundStatus("answered", "completed")).toBe("completed");
  });

  it("a call that ends without being answered is missed", () => {
    expect(nextInboundStatus("ringing", "completed")).toBe("missed");
    expect(nextInboundStatus("ringing", "no_answer")).toBe("missed");
  });

  it("missed is final", () => {
    expect(nextInboundStatus("missed", "answered")).toBeNull();
  });
});

describe("CallerDesk adapter", () => {
  it("recovers the customer when the source leg switched to the agent (crmv7 resolveCustomerPhone_)", () => {
    const payload = { SourceNumber: "9811111111", DestinationNumber: "9822222222" };
    // Agent is 9822222222, so the customer is the other leg.
    expect(resolveCustomerNumber(payload, new Set(["9822222222"]))).toBe("9811111111");
  });

  it("parses CallerDesk's documented outgoing Call Report: legs, campid, durations, IST time, recording", () => {
    const [ev, rec] = callerDeskAdapter.parseWebhook(REPORT_OUT, { registeredDids: ["0806286123"] });
    expect(ev).toMatchObject({
      kind: "completed",
      direction: "outbound",
      providerCallId: "8397411", // campid — what click-to-call returned
      agentNumber: "9000000001",
      customerNumber: "7652081234",
      did: "0806286123",
      durationSec: 26,
      talkSec: 2,
      hangupBy: "customer",
    });
    expect(ev!.at.toISOString()).toBe("2024-12-30T07:13:45.000Z"); // 12:43:45 IST
    expect(rec!.kind).toBe("recording_ready");
  });

  it("outgoing results from the leg times: agent never picked / customer didn't / busy", () => {
    const k = (over: Record<string, string>) => callerDeskAdapter.parseWebhook({ ...REPORT_OUT, CallRecordingUrl: "", ...over }, { registeredDids: [] })[0]!.kind;
    expect(k({ Status: "CANCEL", LegA_Picked_time: "", LegB_Start_time: "", LegB_Picked_time: "" })).toBe("agent_no_answer");
    expect(k({ Status: "NOANSWER", LegB_Picked_time: "" })).toBe("no_answer");
    expect(k({ Status: "BUSY", LegB_Picked_time: "" })).toBe("busy");
  });

  it("parses an incoming (IVR) call report as GET query params: caller = SourceNumber, agent = DialWhomNumber", () => {
    const q = new URL("https://x/?SourceNumber=9811126123&DestinationNumber=1206851234&DialWhomNumber=08595911234&CallDuration=210&coins=4&Status=ANSWER&StartTime=2020-04-09n13:46:56&EndTime=2020-04-09n13:50:26&CallSid=1586420216.71&CallRecordingUrl=https://callrecords.callerdesk.io/0/x.wav&Direction=IVR&campid=&TalkDuration=200");
    const [ev] = callerDeskAdapter.parseWebhook(Object.fromEntries(q.searchParams), { registeredDids: ["01206851234"] });
    expect(ev).toMatchObject({ kind: "completed", direction: "inbound", customerNumber: "9811126123", agentNumber: "8595911234", providerCallId: "1586420216.71", did: "01206851234", talkSec: 200 });
    expect(ev!.at.toISOString()).toBe("2020-04-09T08:20:26.000Z");
    const [missed] = callerDeskAdapter.parseWebhook({ ...Object.fromEntries(q.searchParams), Status: "NOANSWER", DialWhomNumber: "" }, { registeredDids: [] });
    expect(missed!.kind).toBe("missed");
  });

  it("live call events move the call along", () => {
    const [ev] = callerDeskAdapter.parseWebhook({ SourceNumber: "9000000001", DialWhomNumber: "7652081234", Status: "Ringing", Direction: "WEBOBD", CallSid: "1" }, { registeredDids: [] });
    expect(ev).toMatchObject({ kind: "customer_ringing", agentNumber: "9000000001", customerNumber: "7652081234" });
  });

  it("reads IST timestamps without a zone as +05:30", () => {
    expect(parseTime("2024-03-20 12:23:15").toISOString()).toBe("2024-03-20T06:53:15.000Z");
  });

  it("parses an inbound IVR missed call and restores the DID's leading 0", () => {
    const events = callerDeskAdapter.parseWebhook(
      { "Call Direction": "IVR", call_status: "NOANSWER", SourceNumber: "+91 98111 11111", did: "7971544878", call_id: "abc" },
      { registeredDids: ["07971544878"] },
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "missed", direction: "inbound", did: "07971544878", customerNumber: "9811111111", providerCallId: "abc" });
  });

  it("adds a recording_ready event for https recording URLs only", () => {
    const withRec = callerDeskAdapter.parseWebhook(
      { call_status: "completed", calling_party_b: "9811111111", recording_url: "https://rec.example/a.mp3" },
      { registeredDids: [] },
    );
    expect(withRec.map((e) => e.kind)).toEqual(["completed", "recording_ready"]);
    const insecure = callerDeskAdapter.parseWebhook(
      { call_status: "completed", calling_party_b: "9811111111", recording_url: "http://rec.example/a.mp3" },
      { registeredDids: [] },
    );
    expect(insecure.map((e) => e.kind)).toEqual(["completed"]);
  });

  it("ignores status words it does not understand", () => {
    expect(callerDeskAdapter.parseWebhook({ call_status: "whatever" }, { registeredDids: [] })).toEqual([]);
  });

  it("verifies the webhook ?key= against the tenant secret", async () => {
    const ok = new Request("https://crm.example/api/hooks/t/telephony/callerdesk?key=s3cret", { method: "POST" });
    const bad = new Request("https://crm.example/api/hooks/t/telephony/callerdesk?key=nope", { method: "POST" });
    expect(await callerDeskAdapter.verifyWebhook(ok, "", "s3cret")).toBe(true);
    expect(await callerDeskAdapter.verifyWebhook(bad, "", "s3cret")).toBe(false);
    expect(await callerDeskAdapter.verifyWebhook(ok, "", undefined)).toBe(false);
  });

  it("accepts the secret in the URL path (current form) and rejects a wrong one", async () => {
    const secret = "AbCdEfGhIjKlMnOp_qrs-tuv";
    const ok = new Request(`https://crm.example/api/hooks/t/telephony/callerdesk/${secret}`, { method: "POST" });
    const bad = new Request("https://crm.example/api/hooks/t/telephony/callerdesk/AbCdEfGhIjKlMnOp_qrs-XXX", { method: "POST" });
    expect(await callerDeskAdapter.verifyWebhook(ok, "", secret)).toBe(true);
    expect(await callerDeskAdapter.verifyWebhook(bad, "", secret)).toBe(false);
  });

  it("GET with CallerDesk appending '?…' to our '?key=' URL still verifies and parses", async () => {
    const { parseWebhookBody } = await import("@/lib/webhooks/receive");
    const req = new Request("https://crm.example/api/hooks/t/telephony/callerdesk?key=s3cret?SourceNumber=9811126123&Status=ANSWER&Direction=IVR&DialWhomNumber=08595911234");
    expect(await callerDeskAdapter.verifyWebhook(req, "", "s3cret")).toBe(true);
    const body = parseWebhookBody(req, "");
    expect(body).toMatchObject({ SourceNumber: "9811126123", Status: "ANSWER", Direction: "IVR" });
    expect("key" in body).toBe(false);
  });
});

describe("CallerDesk click-to-call request", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("sends the documented params (incl. mandatory call_from_did=1) and keeps campid as the call id", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ type: "success", message: "Call to Customer Initiate Successfully..", campid: 3494119, callerid: "1204760000" }));
    });
    const r = await callerDeskAdapter.clickToCall({ agentNumber: "+919000000001", customerNumber: "+917652081234", callerId: "08069241234", correlationId: "c1" }, { authCode: "AUTH" });
    expect(r).toEqual({ ok: true, providerCallId: "3494119" });
    const u = new URL(seen[0]!);
    expect(u.origin + u.pathname).toBe("https://app.callerdesk.io/api/click_to_call_v2");
    expect(Object.fromEntries(u.searchParams)).toEqual({ authcode: "AUTH", calling_party_a: "9000000001", calling_party_b: "7652081234", deskphone: "08069241234", call_from_did: "1" });
  });
});
