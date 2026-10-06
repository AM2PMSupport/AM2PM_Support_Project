import { describe, expect, it } from "vitest";
import { renderDigest, type DigestData } from "@/lib/notifications/digest-render";

const base: DigestData = {
  workspace: "EduAPex",
  recipient: "Priya",
  day: "2026-10-05",
  scope: "your processes",
  yesterday: { leadsIn: 40, reached: 30, won: 5, lost: 3, dialled: 120, connected: 60, callbacksDue: 10, callbacksOnTime: 8 },
  today: { callbacksDue: 12, overdue: 2, unassigned: 4, neverCalled: 6 },
  outcomes: [{ label: "Interested", count: 9 }],
  hotLeads: [{ name: "Asha <script>alert(1)</script>", owner: null, stage: "Hot", nextCallback: "6 Oct, 11:00" }],
  url: "https://crm.example.test",
};

describe("renderDigest", () => {
  it("subject sums up yesterday and today's alerts", () => {
    expect(renderDigest(base).subject).toBe("EduAPex · Mon, 5 Oct: 40 leads, 5 won · 2 overdue callbacks · 4 unassigned");
    expect(renderDigest({ ...base, today: { ...base.today, overdue: 0, unassigned: 0 } }).subject).toBe("EduAPex · Mon, 5 Oct: 40 leads, 5 won");
  });

  it("escapes customer data and includes the numbers in HTML and text", () => {
    const { html, text } = renderDigest(base);
    expect(html).not.toContain("<script>");
    expect(html).toContain("Asha &lt;script&gt;");
    expect(html).toContain("75% reached");
    expect(html).toContain("/reports?period=yesterday");
    expect(text).toContain("Calls 120 (50% connected)");
    expect(text).toContain("Callbacks on time 80% (8/10)");
    expect(text).toContain("Unassigned");
  });
});
