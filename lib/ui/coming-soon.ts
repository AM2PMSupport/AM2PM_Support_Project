/**
 * Coming-soon modules — showcase screens for what is planned but not built
 * (owner request 2026-10-05). One entry per module: where it sits in the plan
 * (WORKPHASE.md phase + TASK.md ids), what it will do, and a PREVIEW made of
 * fictional sample data so clients and the team can see the shape of it.
 * Nothing here reads or writes real data. Pure data, no I/O.
 *
 * When a module ships: build its real screen, remove it from this list, and
 * update WORKPHASE.md / TASK.md as usual.
 */
export type SoonIcon = "reports" | "campaigns" | "workflows" | "attendance" | "employees" | "billing" | "portal" | "training" | "backups" | "aiqa" | "connectors";

export interface SoonModule {
  slug: string;
  title: string;
  icon: SoonIcon;
  /** One line for the hub card. */
  tagline: string;
  /** Plan position, e.g. "Phase 2 · T2.18–T2.29". */
  plan: string;
  /** Who it is for (roles). */
  forWho: string;
  features: string[];
  preview: {
    kpis: { label: string; value: string; note?: string }[];
    table: { title: string; columns: string[]; rows: string[][] };
    side: { title: string; items: { label: string; value: string }[] };
  };
}

export const SOON_MODULES: SoonModule[] = [
  {
    slug: "campaigns",
    title: "WhatsApp & email campaigns",
    icon: "campaigns",
    tagline: "Templates, broadcasts and follow-ups to consented contacts — DNC always respected.",
    plan: "Phase 2 · T2.14–T2.17",
    forWho: "Admins, managers",
    features: [
      "WhatsApp templates synced from Interakt; send one-to-one from the console or as a broadcast",
      "Email campaigns through Brevo / Resend with unsubscribe links",
      "Consent captured per contact and channel; Do-Not-Call blocks every channel",
      "Delivery, read and reply tracking on the lead timeline",
      "Audience from any saved Leads filter",
    ],
    preview: {
      kpis: [
        { label: "Sent (30 days)", value: "12,940" },
        { label: "Delivered", value: "97.8%" },
        { label: "Read", value: "71%" },
        { label: "Replies", value: "1,206" },
      ],
      table: {
        title: "Recent campaigns",
        columns: ["Campaign", "Channel", "Audience", "Sent", "Read"],
        rows: [["Diwali offer", "WhatsApp", "Hot leads · Sales", "2,410", "78%"], ["Webinar reminder", "Email", "Interested · Edu", "1,820", "44%"], ["Callback nudge", "WhatsApp", "No answer x3", "960", "69%"]],
      },
      side: { title: "Templates", items: [{ label: "Welcome", value: "Approved" }, { label: "Callback booked", value: "Approved" }, { label: "Price list", value: "Pending" }] },
    },
  },
  {
    slug: "workflows",
    title: "Workflows",
    icon: "workflows",
    tagline: "If this, then that — automate follow-ups, assignment and alerts without code.",
    plan: "Phase 2 · workflow engine",
    forWho: "Admins",
    features: [
      "Triggers: lead created, stage changed, outcome saved, callback missed, no activity for N days",
      "Conditions on any field, source, process or custom field",
      "Actions: send WhatsApp/email, reassign, change stage, create callback, notify, call a webhook",
      "Run history with the reason each step ran or was skipped",
    ],
    preview: {
      kpis: [
        { label: "Active workflows", value: "9" },
        { label: "Runs today", value: "1,384" },
        { label: "Success", value: "99.6%" },
        { label: "Time saved", value: "~14 h/day" },
      ],
      table: {
        title: "Workflows",
        columns: ["Name", "Trigger", "Actions", "Runs (7d)", "Status"],
        rows: [["Hot lead → manager", "Stage = Hot", "Notify + reassign", "212", "On"], ["Missed callback rescue", "Callback missed", "WhatsApp + new callback", "96", "On"], ["Stale lead recycle", "No activity 3 days", "Reassign", "430", "On"]],
      },
      side: { title: "Last runs", items: [{ label: "Hot lead → manager", value: "2 min ago" }, { label: "Stale lead recycle", value: "6 min ago" }, { label: "Welcome WhatsApp", value: "9 min ago" }] },
    },
  },
  {
    slug: "employees",
    title: "Employees (HR)",
    icon: "employees",
    tagline: "Employee profiles, documents and leave — for the HR role.",
    plan: "Phase 1 · T1.49",
    forWho: "HR, admins",
    features: [
      "Profile per person: joining date, employee code, team, manager, position",
      "Documents (ID, offer letter, agreements) stored privately",
      "Leave balances and requests (from Jibble when connected)",
      "Exit checklist: disable logins in every workspace at once",
    ],
    preview: {
      kpis: [
        { label: "Employees", value: "142" },
        { label: "Joined this month", value: "9" },
        { label: "On leave today", value: "6" },
        { label: "Documents pending", value: "11" },
      ],
      table: {
        title: "Directory",
        columns: ["Name", "Code", "Team", "Manager", "Joined"],
        rows: [["Asha R.", "AM-1042", "Sales A", "Priya D.", "Mar 2025"], ["Vikram S.", "AM-1077", "Sales B", "Priya D.", "Jun 2025"], ["Neha K.", "AM-1103", "Support", "Imran H.", "Aug 2026"]],
      },
      side: { title: "Upcoming", items: [{ label: "Probation ends", value: "3" }, { label: "Work anniversaries", value: "5" }, { label: "Exits", value: "1" }] },
    },
  },
  {
    slug: "billing",
    title: "Billing & invoices",
    icon: "billing",
    tagline: "Bill each client by seats, hours or outcomes — for the Accounts role.",
    plan: "Phase 1 · T1.50",
    forWho: "Accounts, admins",
    features: [
      "Billing plans per client: per seat, per billable hour (Jibble) or per converted lead",
      "Monthly invoice drafts with GST, approve and send",
      "Payments received and outstanding per client",
      "Usage report attached to each invoice",
    ],
    preview: {
      kpis: [
        { label: "Billed this month", value: "₹18.6 L" },
        { label: "Collected", value: "₹14.2 L" },
        { label: "Outstanding", value: "₹4.4 L" },
        { label: "Invoices due", value: "7" },
      ],
      table: {
        title: "Invoices · October",
        columns: ["Client", "Basis", "Amount", "Status"],
        rows: [["Client A", "32 seats", "₹4,80,000", "Paid"], ["Client B", "1,240 h", "₹3,72,000", "Sent"], ["Client C", "310 conversions", "₹2,17,000", "Draft"]],
      },
      side: { title: "Ageing", items: [{ label: "0–30 days", value: "₹3.1 L" }, { label: "31–60 days", value: "₹0.9 L" }, { label: "60+ days", value: "₹0.4 L" }] },
    },
  },
  {
    slug: "portal",
    title: "Client portal",
    icon: "portal",
    tagline: "Clients log in to see their own leads, calls, recordings and reports.",
    plan: "Phase 3 · T3.5",
    forWho: "Client users",
    features: [
      "Read-only view of the client's processes, leads and outcomes",
      "Call recordings and transcripts (if allowed by contract)",
      "Daily / weekly performance reports and downloads",
      "Raise a request or feedback on a lead",
    ],
    preview: {
      kpis: [
        { label: "Leads handled", value: "2,104" },
        { label: "Contacted", value: "96%" },
        { label: "Interested", value: "412" },
        { label: "Won", value: "131" },
      ],
      table: {
        title: "Latest outcomes",
        columns: ["Lead", "Source", "Outcome", "When"],
        rows: [["Lead #20431", "Meta Ads", "Interested", "10 min ago"], ["Lead #20428", "Website", "Callback tomorrow", "24 min ago"], ["Lead #20419", "IndiaMART", "Won", "1 h ago"]],
      },
      side: { title: "This week", items: [{ label: "Calls made", value: "6,320" }, { label: "Avg talk time", value: "3m 12s" }, { label: "Recordings", value: "4,880" }] },
    },
  },
  {
    slug: "training",
    title: "Training & LMS",
    icon: "training",
    tagline: "Courses, call scripts and certification per workspace — for trainers.",
    plan: "Phase 4",
    forWho: "Trainers, agents",
    features: [
      "Courses and quizzes per client process",
      "Call scripts and objection handling in the console",
      "Certification before an agent gets live leads",
      "Best-call recordings library",
    ],
    preview: {
      kpis: [
        { label: "Courses", value: "14" },
        { label: "Certified agents", value: "51 / 56" },
        { label: "Avg score", value: "86%" },
        { label: "Hours learned", value: "312" },
      ],
      table: {
        title: "Courses",
        columns: ["Course", "Process", "Enrolled", "Completion"],
        rows: [["Product basics", "Sales", "56", "100%"], ["Objection handling", "Sales", "48", "82%"], ["Compliance & DNC", "All", "56", "96%"]],
      },
      side: { title: "Due this week", items: [{ label: "New joiners", value: "4" }, { label: "Re-certification", value: "7" }] },
    },
  },
  {
    slug: "backups",
    title: "Backups & security",
    icon: "backups",
    tagline: "Nightly encrypted per-client backups, 2FA and IP allow-lists.",
    plan: "Phase 1–3 · T1.43–T1.44, T3.x",
    forWho: "Super Admins, admins",
    features: [
      "Nightly encrypted snapshot per client to a separate store",
      "Two-person restore and a weekly restore test",
      "Two-factor sign-in (TOTP) and IP allow-list per workspace",
      "Data retention and erasure requests (DPDP)",
    ],
    preview: {
      kpis: [
        { label: "Last backup", value: "01:42 IST" },
        { label: "Snapshots kept", value: "30" },
        { label: "Last restore test", value: "Passed" },
        { label: "2FA enabled", value: "88%" },
      ],
      table: {
        title: "Snapshots",
        columns: ["Workspace", "Taken", "Size", "Verified"],
        rows: [["Client A", "Today 01:31", "184 MB", "Yes"], ["Client B", "Today 01:36", "96 MB", "Yes"], ["Client C", "Today 01:42", "212 MB", "Yes"]],
      },
      side: { title: "Security", items: [{ label: "IP allow-list", value: "On" }, { label: "Failed sign-ins (24h)", value: "3" }] },
    },
  },
  {
    slug: "connectors",
    title: "Lead connectors",
    icon: "connectors",
    tagline: "Meta Lead Ads, Google Ads, IndiaMART and Justdial straight into the CRM.",
    plan: "Phase 2 · T2.1–T2.4",
    forWho: "Admins",
    features: [
      "Connect a Meta page or Google Ads account per client in two clicks",
      "IndiaMART / Justdial pull every 15 minutes with de-duplication",
      "Field mapping to custom fields; leads auto-assigned on arrival",
      "Per-source health: last lead, errors, volume",
    ],
    preview: {
      kpis: [
        { label: "Connected sources", value: "11" },
        { label: "Leads today", value: "386" },
        { label: "Duplicates merged", value: "41" },
        { label: "Errors", value: "0" },
      ],
      table: {
        title: "Sources",
        columns: ["Source", "Client", "Last lead", "Today"],
        rows: [["Meta Lead Ads", "Client A", "2 min ago", "142"], ["Google Ads", "Client B", "9 min ago", "61"], ["IndiaMART", "Client C", "14 min ago", "88"]],
      },
      side: { title: "Health", items: [{ label: "All sources", value: "OK" }, { label: "Next IndiaMART pull", value: "6 min" }] },
    },
  },
  {
    slug: "ai-qa",
    title: "AI call quality",
    icon: "aiqa",
    tagline: "Every recording transcribed and scored — coaching notes for each agent.",
    plan: "Phase 4",
    forWho: "Supervisors, trainers, auditors",
    features: [
      "Transcripts for recorded calls (Hindi, English, Hinglish)",
      "Scorecards: greeting, script adherence, objection handling, compliance",
      "Flag risky calls (abusive language, missing disclosures)",
      "Coaching suggestions per agent, trend over time",
    ],
    preview: {
      kpis: [
        { label: "Calls scored", value: "3,912" },
        { label: "Avg score", value: "78 / 100" },
        { label: "Flagged", value: "14" },
        { label: "Coaching sessions", value: "22" },
      ],
      table: {
        title: "Lowest scores this week",
        columns: ["Agent", "Calls", "Score", "Top gap"],
        rows: [["Agent 12", "184", "61", "Objection handling"], ["Agent 07", "201", "66", "Greeting"], ["Agent 19", "156", "68", "Disclosure"]],
      },
      side: { title: "Flags", items: [{ label: "Missing disclosure", value: "9" }, { label: "Long hold", value: "5" }] },
    },
  },
];

export function soonModule(slug: string): SoonModule | undefined {
  return SOON_MODULES.find((m) => m.slug === slug);
}
