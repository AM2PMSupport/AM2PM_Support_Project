import { describe, expect, it, vi } from "vitest";

const { fakeRedis } = await import("./helpers/db");
const r = fakeRedis();
vi.mock("@/lib/redis/client", () => ({ redis: () => r }));
const { assertWebhookIpAllowed, countRejectedWebhook, countWebhookProbe, limitPerson, PERSON_RATE_PER_MIN, rateLimit, rejectedWebhooks } = await import("@/lib/http/rate-limit");

const req = (ip: string) => new Request("https://x.test/api/hooks/t/s", { headers: { "x-forwarded-for": `${ip}, 10.0.0.1` } });

describe("rate limits (SECURITY.md §2)", () => {
  it("allows up to the limit, then 429", async () => {
    for (let i = 0; i < 3; i++) await rateLimit("t:x:rl:test", 3, "per test");
    await expect(rateLimit("t:x:rl:test", 3, "per test")).rejects.toMatchObject({ status: 429, code: "rate_limited" });
  });

  it("one bucket per person, across workspaces' people", async () => {
    const a = { tenantId: "t1", actor: { userId: "u1" } };
    for (let i = 0; i < PERSON_RATE_PER_MIN; i++) await limitPerson(a);
    await expect(limitPerson(a)).rejects.toMatchObject({ status: 429 });
    await expect(limitPerson({ tenantId: "t1", actor: { userId: "u2" } })).resolves.toBeUndefined();
  });

  it("blocks an IP after 30 probes of unknown workspaces; other IPs unaffected", async () => {
    for (let i = 0; i < 30; i++) await countWebhookProbe(req("1.2.3.4"));
    await expect(assertWebhookIpAllowed(req("1.2.3.4"))).rejects.toMatchObject({ status: 429 });
    await expect(assertWebhookIpAllowed(req("5.6.7.8"))).resolves.toBeUndefined();
  });

  it("a stale key for a REAL workspace never blocks the provider's IP (2026-10-06 incident); it's counted for Setup", async () => {
    for (let i = 0; i < 100; i++) await countRejectedWebhook("t-a", "telephony:callerdesk");
    await expect(assertWebhookIpAllowed(req("9.9.9.9"))).resolves.toBeUndefined();
    const r = await rejectedWebhooks("t-a", "telephony:callerdesk");
    expect(r.today).toBe(100);
    expect(r.lastAt).toBeTruthy();
    expect((await rejectedWebhooks("t-b", "telephony:callerdesk")).today).toBe(0);
  });
});
