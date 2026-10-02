import { describe, expect, it } from "vitest";
import { generatePassword, hashPassword, verifyPassword } from "@/lib/auth/password";
import { createToken, readToken, SESSION_TTL_SECONDS } from "@/lib/auth/token";

describe("password hashing", () => {
  it("verifies the right password and rejects a wrong one", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("correct horse batterY", h)).toBe(false);
  });

  it("salts: the same password hashes differently", async () => {
    expect(await hashPassword("same password 123")).not.toBe(await hashPassword("same password 123"));
  });

  it("rejects short passwords and missing/garbled hashes", async () => {
    await expect(hashPassword("short")).rejects.toThrow();
    expect(await verifyPassword("anything at all", null)).toBe(false);
    expect(await verifyPassword("anything at all", "md5$abc")).toBe(false);
  });

  it("generates strong passwords with every character class", () => {
    for (let i = 0; i < 20; i++) {
      const p = generatePassword();
      expect(p).toHaveLength(20);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[2-9]/);
      expect(p).toMatch(/[@#%+=?!]/);
      expect(p).not.toMatch(/[0O1lI]/);
    }
  });
});

describe("session tokens", () => {
  const secret = "test-secret-not-real";
  const payload = { aid: "a1", uid: "u1", tid: "t1", slug: "am2pm", tz: "Asia/Kolkata", role: "agent" as const, name: "Test" };

  it("round-trips a valid token", () => {
    expect(readToken(createToken(payload, secret), secret)).toMatchObject(payload);
  });

  it("rejects tampering and the wrong secret", () => {
    const t = createToken(payload, secret);
    const [data, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload, role: "super_admin", exp: 9e9 })).toString("base64url");
    expect(readToken(`${forged}.${sig}`, secret)).toBeNull();
    expect(readToken(`${data}.${sig}x`, secret)).toBeNull();
    expect(readToken(t, "other-secret")).toBeNull();
    expect(readToken("garbage", secret)).toBeNull();
  });

  it("rejects a cookie from before logins became accounts (no aid)", () => {
    const { aid: _aid, ...old } = payload;
    void _aid;
    expect(readToken(createToken(old as typeof payload, secret), secret)).toBeNull();
  });

  it("expires after the session TTL", () => {
    const now = Date.now();
    const t = createToken(payload, secret, now);
    expect(readToken(t, secret, now + (SESSION_TTL_SECONDS - 5) * 1000)).not.toBeNull();
    expect(readToken(t, secret, now + (SESSION_TTL_SECONDS + 5) * 1000)).toBeNull();
  });
});
