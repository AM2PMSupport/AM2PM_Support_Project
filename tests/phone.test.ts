import { describe, expect, it } from "vitest";
import { canonicalDid, isValidMobile10, maskPhone, phoneKey, toE164, toTenDigits } from "@/lib/phone/phone";

describe("phone rules ported from crmv7", () => {
  it("phoneKey keeps the last 10 digits, empty when too short", () => {
    expect(phoneKey("+91 98765-43210")).toBe("9876543210");
    expect(phoneKey("09876543210")).toBe("9876543210");
    expect(phoneKey("12345")).toBe("");
    expect(phoneKey(null)).toBe("");
  });

  it("toTenDigits returns short numbers unchanged", () => {
    expect(toTenDigits("98765")).toBe("98765");
  });

  it("isValidMobile10 accepts Indian mobiles starting 6-9", () => {
    expect(isValidMobile10("9876543210")).toBe(true);
    expect(isValidMobile10("5876543210")).toBe(false);
    expect(isValidMobile10("987654321")).toBe(false);
  });

  it("toE164 handles 10-digit, trunk-0, 00 and country-code forms", () => {
    expect(toE164("9876543210")).toBe("+919876543210");
    expect(toE164("09876543210")).toBe("+919876543210");
    expect(toE164("00919876543210")).toBe("+919876543210");
    expect(toE164("+1 415 555 0100")).toBe("+14155550100");
    expect(toE164("123")).toBeNull();
  });

  it("canonicalDid restores the registered leading 0 (CallerDesk 'Invalid Deskphone')", () => {
    expect(canonicalDid("7971544878", ["07971544878", "08012345678"])).toBe("07971544878");
    expect(canonicalDid("9999999999", ["07971544878"])).toBe("9999999999");
  });

  it("maskPhone keeps only the last 4 digits", () => {
    expect(maskPhone("+919876543210")).toBe("XXXXXXXX3210");
  });
});
