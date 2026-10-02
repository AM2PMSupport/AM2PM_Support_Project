/** QStash rejects ":" in deduplication ids (400 in production) — enqueue normalises them. */
import { describe, expect, it } from "vitest";
import { dedupeId } from "@/lib/queue/qstash";

describe("dedupeId", () => {
  it("replaces characters QStash rejects, keeps ids stable", () => {
    expect(dedupeId("assign:3f2a-uuid")).toBe("assign-3f2a-uuid");
    expect(dedupeId("import:b1:500")).toBe("import-b1-500");
    expect(dedupeId(undefined)).toBeUndefined();
  });
});
