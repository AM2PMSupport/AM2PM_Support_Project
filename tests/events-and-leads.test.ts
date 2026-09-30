import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { signPayload, verifySignature } from "@/lib/events/signature";
import { subscriptionMatches } from "@/lib/events/outbox";
import { decrypt, encrypt } from "@/lib/crypto";
import { normaliseLead } from "@/lib/leads/normalise";
import { dedupeValue } from "@/lib/leads/create";
import { redact } from "@/lib/log";

beforeAll(() => {
  process.env.MASTER_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.CRON_SECRET = "test-cron-secret-123456";
});

describe("outbound webhook signature", () => {
  const body = JSON.stringify({ id: "evt_1", type: "lead.converted" });

  it("round-trips", () => {
    const header = signPayload("secret", body, 1_790_812_345);
    expect(verifySignature("secret", body, header, 1_790_812_345)).toBe(true);
  });

  it("rejects a tampered body, wrong secret, or stale timestamp", () => {
    const header = signPayload("secret", body, 1_000);
    expect(verifySignature("secret", body + " ", header, 1_000)).toBe(false);
    expect(verifySignature("other", body, header, 1_000)).toBe(false);
    expect(verifySignature("secret", body, header, 1_000 + 301)).toBe(false);
    expect(verifySignature("secret", body, null, 1_000)).toBe(false);
  });
});

describe("subscription filters", () => {
  const p1 = "11111111-1111-4111-8111-111111111111";
  const ev = { eventType: "lead.converted", payload: { processId: p1, stage: "Won" } };

  it("matches on event type and optional process/stage filters", () => {
    expect(subscriptionMatches({ events: ["lead.converted"], filters: {} }, ev)).toBe(true);
    expect(subscriptionMatches({ events: ["lead.created"], filters: {} }, ev)).toBe(false);
    expect(subscriptionMatches({ events: ["lead.converted"], filters: { processIds: [p1] } }, ev)).toBe(true);
    expect(subscriptionMatches({ events: ["lead.converted"], filters: { processIds: ["22222222-2222-4222-8222-222222222222"] } }, ev)).toBe(false);
    expect(subscriptionMatches({ events: ["lead.converted"], filters: { stages: ["Hot"] } }, ev)).toBe(false);
  });
});

describe("crypto", () => {
  it("encrypts and decrypts with AES-256-GCM; ciphertext differs every time", () => {
    const a = encrypt('{"authCode":"x"}');
    const b = encrypt('{"authCode":"x"}');
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe('{"authCode":"x"}');
  });

  it("detects tampering", () => {
    const parts = encrypt("hello").split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decrypt(parts.join("."))).toThrow();
  });
});

describe("lead normalisation", () => {
  it("maps fields, puts the rest in custom, and builds phoneKey + E.164", () => {
    const res = normaliseLead(
      { full_name: " Rahul S ", phone_number: "098111 11111", city: "Pune", utm: "diwali" },
      { full_name: "name", phone_number: "phone", city: "custom.city" },
    );
    expect(res).toEqual({
      ok: true,
      lead: { name: "Rahul S", phoneE164: "+919811111111", phoneKey: "9811111111", email: undefined, custom: { city: "Pune", utm: "diwali" } },
    });
  });

  it("guesses common field names when no map is set", () => {
    const res = normaliseLead({ Mobile: "9811111111", Email: "A@B.COM" });
    expect(res.ok && res.lead.phoneKey).toBe("9811111111");
    expect(res.ok && res.lead.email).toBe("a@b.com");
  });

  it("rejects a lead with neither a valid mobile nor an email", () => {
    expect(normaliseLead({ phone: "12345" })).toEqual({ ok: false, reason: "no valid phone or email" });
  });

  it("dedupe value follows the process rule", () => {
    const lead = { phoneKey: "9811111111", email: "a@b.com", custom: { pan: " ABCDE1234F " } };
    expect(dedupeValue({ dedupeField: "phoneKey" }, lead)).toBe("9811111111");
    expect(dedupeValue({ dedupeField: "email" }, lead)).toBe("a@b.com");
    expect(dedupeValue({ dedupeField: "pan" }, lead)).toBe("abcde1234f");
    expect(dedupeValue({ dedupeField: "email" }, { custom: {} })).toBeNull();
  });
});

describe("log redaction", () => {
  it("masks sensitive keys and phone-like digit runs", () => {
    expect(redact({ phone: "9811111111", note: "call 9811111111 now", nested: { token: "abc" } })).toEqual({
      phone: "[redacted]",
      note: "call ****1111 now",
      nested: { token: "[redacted]" },
    });
  });
});
