import { describe, expect, it } from "vitest";
import { nextInboundStatus, nextOutboundStatus } from "@/lib/telephony/state-machine";
import { callerDeskAdapter, resolveCustomerNumber } from "@/lib/providers/telephony/callerdesk/adapter";

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
});
