/**
 * Setup (Zoho-style). Without ?tab → a searchable grid of every setting the
 * role can open (components/admin/setup-home.tsx). With ?tab → that
 * setting's page: company · team · roles · audit · processes · outcomes &
 * fields · lead sources & import · telephony · webhooks · data · workspaces.
 * Everything is the CURRENT workspace's (RLS); switching workspace from the
 * avatar switches all of it. Each tab loads only its own data; editing
 * controls appear only for roles allowed to edit (lib/auth/rbac.ts).
 */
import type { Metadata } from "next";
import Link from "next/link";
import { desc } from "drizzle-orm";
import { requirePage } from "@/lib/auth/guard";
import { can, permissionMatrix } from "@/lib/auth/rbac";
import { SetupHome, type SetupGroup } from "@/components/admin/setup-home";
import { CompanyPanel, SampleDataPanel } from "@/components/admin/company-panel";
import { getCompany, TIMEZONES } from "@/lib/admin/company";
import { listAudit, loginActivity } from "@/lib/admin/audit-log";
import { sampleDataSummary } from "@/lib/admin/sample-data";
import { listApiKeys } from "@/lib/admin/api-keys";
import { ApiKeysPanel } from "@/components/admin/api-keys-panel";
import { publicBaseUrl } from "@/lib/config/env";
import type { Role } from "@/lib/db/schema";
import { Topbar } from "@/components/shell/topbar";
import { ProcessesPanel } from "@/components/admin/processes-panel";
import { TeamPanel } from "@/components/admin/team-panel";
import { OutcomesPanel } from "@/components/admin/outcomes-panel";
import { SourcesPanel, TelephonyPanel } from "@/components/admin/integrations-panel";
import { Tag } from "@/components/ui/primitives";
import { WorkspacesPanel } from "@/components/admin/workspaces-panel";
import { listWorkspaces } from "@/lib/platform-admin/workspaces";
import { listDispositions, listProcesses } from "@/lib/admin/processes";
import { listUsers } from "@/lib/admin/users";
import { listFields } from "@/lib/admin/custom-fields";
import { listSources } from "@/lib/admin/sources";
import { listImports } from "@/lib/imports/run";
import { ImportsPanel, type ImportRow } from "@/components/admin/imports-panel";
import { getTelephony } from "@/lib/admin/telephony";
import { webhookSubscriptions } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";

export const metadata: Metadata = { title: "Setup" };

const TABS = [
  { id: "company", label: "Company" },
  { id: "processes", label: "Processes" },
  { id: "team", label: "Team" },
  { id: "outcomes", label: "Outcomes & fields" },
  { id: "sources", label: "Lead sources" },
  { id: "telephony", label: "Telephony" },
  { id: "webhooks", label: "Webhooks" },
  { id: "api", label: "API keys" },
  { id: "roles", label: "Roles" },
  { id: "audit", label: "Audit log" },
  { id: "data", label: "Data" },
  { id: "workspaces", label: "Workspaces" },
] as const;

const ROLE_ORDER: Role[] = ["super_admin", "admin", "project_supervisor", "manager", "process_coordinator", "trainer", "client", "agent"];
const ROLE_LABEL: Record<Role, string> = { super_admin: "Super Admin", admin: "Admin", project_supervisor: "Supervisor", manager: "Manager", process_coordinator: "Coordinator", trainer: "Trainer", client: "Client", agent: "Agent" };
const ACTION_LABEL: Record<string, string> = { V: "view", C: "create", E: "edit", D: "delete", A: "approve", X: "export" };

/** The Setup home grid, filtered to what this role may open. */
function setupGroups(role: Role): SetupGroup[] {
  const t = (tab: string) => `/admin?tab=${tab}`;
  const groups: SetupGroup[] = [
    {
      title: "General",
      icon: "general",
      items: [
        can(role, "config", "V") && { label: "Company settings", href: t("company"), hint: "Name, timezone, currency" },
        can(role, "users", "V") && { label: "Users", href: t("team"), hint: "People, roles, phones, process access" },
        role === "super_admin" && { label: "Workspaces", href: t("workspaces"), hint: "Client organisations · create, suspend" },
      ].filter(Boolean) as SetupGroup["items"],
    },
    {
      title: "Security control",
      icon: "security",
      items: [
        can(role, "users", "V") && { label: "Roles & permissions", href: t("roles"), hint: "What each role can see and do" },
        can(role, "audit", "V") && { label: "Audit log", href: t("audit"), hint: "Who changed what, when" },
        can(role, "audit", "V") && { label: "Login history", href: `${t("audit")}#logins`, hint: "Last sign-in per person" },
        { label: "Single sign-on & 2FA", hint: "Google sign-in, TOTP", planned: "Phase 3" },
      ].filter(Boolean) as SetupGroup["items"],
    },
    {
      title: "Channels",
      icon: "channels",
      items: [
        { label: "Telephony (CallerDesk)", href: t("telephony"), hint: "Click-to-call, DIDs, call webhooks" },
        can(role, "import_sources", "V") && { label: "Lead sources & webforms", href: t("sources"), hint: "Meta, website, IndiaMART, Justdial, API" },
        can(role, "webhooks", "V") && { label: "Outbound webhooks", href: t("webhooks"), hint: "Send converted leads to client CRMs" },
        can(role, "integrations", "C") && { label: "API keys (REST & GraphQL)", href: t("api"), hint: "Keys for integrations; acts as you, read or write" },
        { label: "WhatsApp & email", hint: "Templates, consent", planned: "Phase 2" },
      ].filter(Boolean) as SetupGroup["items"],
    },
    {
      title: "Customization",
      icon: "custom",
      items: [
        { label: "Processes & pipelines", href: t("processes"), hint: "Stages, won stage, dedupe rule" },
        { label: "Outcomes & fields", href: t("outcomes"), hint: "Call dispositions, custom lead fields" },
      ],
    },
    {
      title: "Automation",
      icon: "automation",
      items: [
        { label: "Assignment rules", href: t("processes"), hint: "Equal, percentage, ratio, quota, hours" },
        { label: "Callback reminders & SLA", href: t("processes"), hint: "Runs every 5 min · per-process SLA minutes" },
        { label: "Workflows", hint: "If this, then that", planned: "Phase 2" },
      ],
    },
    {
      title: "Data administration",
      icon: "data",
      items: [
        can(role, "import_sources", "V") && { label: "Import", href: `${t("sources")}#import`, hint: "CSV / Excel, dedupe + auto-assign" },
        can(role, "leads", "X") && { label: "Export", href: "/leads", hint: "Leads → Export (current filter as CSV)" },
        can(role, "config", "V") && { label: "Remove sample data", href: t("data"), hint: "Delete the demo process and its leads" },
        { label: "Data backup", hint: "Nightly per-client encrypted backup", planned: "Phase 1 · next" },
      ].filter(Boolean) as SetupGroup["items"],
    },
    {
      title: "Training",
      icon: "training",
      items: [{ label: "Training & LMS", hint: "Courses, scripts, certification — per workspace", planned: "Phase 4" }],
    },
  ];
  return groups.filter((g) => g.items.length);
}
type TabId = (typeof TABS)[number]["id"];

export default async function SetupPage({ searchParams }: { searchParams: Promise<{ tab?: string; process?: string; cursor?: string }> }) {
  const ctx = await requirePage("admin");
  const sp = await searchParams;
  const role = ctx.actor.role;
  const tab = TABS.find((t) => t.id === sp.tab)?.id as TabId | undefined;
  if (!tab) {
    return (
      <div className="flex min-h-dvh flex-col">
        <Topbar title="Setup" subtitle={`Workspace · ${ctx.tenantName}`} />
        <div className="px-6 py-6">
          <SetupHome groups={setupGroups(role)} workspace={ctx.tenantName} />
        </div>
      </div>
    );
  }
  // Tab data that doesn't depend on the process list starts in parallel with it.
  const [processes, users, sources, imports, telephony] = await Promise.all([
    listProcesses(ctx),
    tab === "team" && can(role, "users", "V") ? listUsers(ctx) : null,
    tab === "sources" && can(role, "import_sources", "V") ? listSources(ctx) : null,
    tab === "sources" && can(role, "import_sources", "V") ? listImports(ctx) : null,
    tab === "telephony" ? getTelephony(ctx) : null,
  ]);
  const procOptions = processes.map((p) => ({ id: p.id, name: p.name }));

  let body: React.ReactNode = null;
  if (tab === "api") {
    body = can(role, "integrations", "C") ? <ApiKeysPanel rows={await listApiKeys(ctx)} baseUrl={publicBaseUrl()} timeZone={ctx.timezone} /> : <NoAccess />;
  } else if (tab === "company") {
    body = can(role, "config", "V") ? <CompanyPanel company={await getCompany(ctx)} timezones={TIMEZONES} canEdit={can(role, "config", "E")} /> : <NoAccess />;
  } else if (tab === "data") {
    body = can(role, "config", "V") ? <SampleDataPanel summary={await sampleDataSummary(ctx)} canEdit={can(role, "config", "E")} /> : <NoAccess />;
  } else if (tab === "roles") {
    body = can(role, "users", "V") ? (
      <div className="flex flex-col gap-3">
        <p className="max-w-[720px] text-[12.5px] leading-relaxed text-ink-3">
          Fixed roles (DESIGN.md §7). V view · C create · E edit · D delete · A approve · X export. Agents see only their own leads; supervisors, managers and coordinators see the processes they’re mapped to; admins see the whole workspace. A person can hold a different role in each workspace.
        </p>
        <div className="panel overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-rule text-left text-ink-3">
                <th className="px-4 py-2.5 font-medium">Area</th>
                {ROLE_ORDER.map((r) => <th key={r} className={`px-3 py-2.5 font-medium ${r === role ? "text-ink" : ""}`}>{ROLE_LABEL[r]}</th>)}
              </tr>
            </thead>
            <tbody>
              {permissionMatrix().map(({ module, grants }) => (
                <tr key={module} className="border-b border-rule last:border-b-0">
                  <td className="px-4 py-2.5 font-medium capitalize">{module.replace(/_/g, " ")}</td>
                  {ROLE_ORDER.map((r) => (
                    <td key={r} className={`px-3 py-2.5 font-mono tnum ${r === role ? "bg-teal/10" : ""}`} title={(grants[r] ?? "").split("").map((c) => ACTION_LABEL[c]).join(", ") || "no access"}>
                      {grants[r] ?? <span className="text-ink-4">–</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    ) : (
      <NoAccess />
    );
  } else if (tab === "audit") {
    if (!can(role, "audit", "V")) body = <NoAccess />;
    else {
      const [log, logins] = await Promise.all([listAudit(ctx, sp.cursor), loginActivity(ctx)]);
      const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: ctx.timezone });
      body = (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <section className="panel overflow-hidden">
            <div className="border-b border-rule px-4 py-3 text-[13.5px] font-semibold">Audit log</div>
            <table className="w-full text-[12.5px]">
              <tbody>
                {log.items.map((a) => (
                  <tr key={a.id} className="border-b border-rule last:border-b-0 align-top">
                    <td className="px-4 py-2.5 font-mono text-[11.5px] whitespace-nowrap text-ink-3 tnum">{when(a.at)}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">{a.who ?? <span className="text-ink-4">system</span>}</td>
                    <td className="px-3 py-2.5"><span className="font-mono text-[12px]">{a.action}</span>{a.after && <div className="mt-0.5 max-w-[420px] truncate font-mono text-[11px] text-ink-4">{a.after}</div>}</td>
                  </tr>
                ))}
                {!log.items.length && <tr><td className="px-4 py-6 text-ink-3">Nothing recorded yet.</td></tr>}
              </tbody>
            </table>
            {log.nextCursor && (
              <div className="border-t border-rule px-4 py-2.5 text-right">
                <Link href={`/admin?tab=audit&cursor=${encodeURIComponent(log.nextCursor)}`} className="text-[12.5px] font-medium text-teal-ink hover:underline">Older →</Link>
              </div>
            )}
          </section>
          <section id="logins" className="panel overflow-hidden">
            <div className="border-b border-rule px-4 py-3 text-[13.5px] font-semibold">Login history</div>
            <ul>
              {logins.map((u) => (
                <li key={u.email} className="flex items-center justify-between gap-3 border-b border-rule px-4 py-2.5 text-[12.5px] last:border-b-0">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{u.name}</span>
                    <span className="block truncate text-[11.5px] text-ink-4">{ROLE_LABEL[u.role]} · {u.email}{u.status !== "active" ? ` · ${u.status}` : ""}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[11.5px] text-ink-3 tnum">{u.lastLoginAt ? when(u.lastLoginAt) : "never"}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      );
    }
  } else if (tab === "processes") {
    body = <ProcessesPanel rows={processes} canEdit={can(role, "config", "E")} />;
  } else if (tab === "team") {
    body = can(role, "users", "V") ? <TeamPanel rows={users ?? []} processes={procOptions} canEdit={can(role, "users", "E")} /> : <NoAccess />;
  } else if (tab === "outcomes") {
    const processId = sp.process && processes.some((p) => p.id === sp.process) ? sp.process : (processes[0]?.id ?? null);
    const [outcomes, fields] = await Promise.all([processId ? listDispositions(ctx, processId) : Promise.resolve([]), listFields(ctx, processId)]);
    body = (
      <OutcomesPanel
        processes={procOptions}
        processId={processId}
        outcomes={outcomes}
        fields={fields}
        canEdit={can(role, "config", "E")}
      />
    );
  } else if (tab === "sources") {
    body = can(role, "import_sources", "V") ? (
      <div className="flex flex-col gap-6">
        <SourcesPanel rows={sources ?? []} processes={procOptions} canEdit={can(role, "import_sources", "C")} />
        <ImportsPanel
          initial={(imports ?? []).map((b) => ({ ...b, createdAt: b.createdAt.toISOString() })) as ImportRow[]}
          processes={procOptions}
          tenantId={ctx.tenantId}
          timeZone={ctx.timezone}
          canEdit={can(role, "import_sources", "C")}
        />
      </div>
    ) : (
      <NoAccess />
    );
  } else if (tab === "telephony") {
    body = <TelephonyPanel data={telephony!} processes={procOptions} canEdit={can(role, "integrations", "C")} />;
  } else if (tab === "workspaces") {
    body = role === "super_admin" ? <WorkspacesPanel rows={await listWorkspaces(ctx)} currentId={ctx.tenantId} /> : <NoAccess />;
  } else {
    const subs = can(role, "webhooks", "V")
      ? await withTenant(ctx, (tx) => tx.select().from(webhookSubscriptions).orderBy(desc(webhookSubscriptions.createdAt)))
      : null;
    body = subs ? (
      <div className="flex flex-col gap-3">
        <p className="max-w-[640px] text-[12.5px] leading-relaxed text-ink-3">
          Signed with HMAC-SHA256 (<span className="font-mono">X-AM2PM-Signature</span>), retried for 24 hours, paused after a day of failures (API.md §4).
          Adding endpoints from this screen arrives in Phase 2 (T2.9).
        </p>
        <div className="panel divide-y divide-rule">
          {subs.map((w) => (
            <div key={w.id} className="flex items-center gap-3 px-4 py-3">
              <span className={`h-2 w-2 rounded-full ${w.isActive ? (w.failingSince ? "bg-ember" : "bg-moss") : "bg-ink-4"}`} />
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{w.url}</span>
              {w.events.map((e) => <Tag key={e}>{e}</Tag>)}
            </div>
          ))}
          {subs.length === 0 && <p className="px-4 py-6 text-[13px] text-ink-3">No webhook endpoints yet.</p>}
        </div>
      </div>
    ) : (
      <NoAccess />
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <Topbar title="Setup" subtitle={`Workspace · ${ctx.tenantName}`} />
      <div className="border-b border-rule bg-paper px-6">
        <nav className="flex gap-1 overflow-x-auto" aria-label="Setup sections">
          <Link href="/admin" className="relative px-3 py-3 text-[13px] font-medium whitespace-nowrap text-teal-ink hover:underline">← All settings</Link>
          {TABS.filter((t) => (t.id !== "workspaces" || role === "super_admin") && (t.id !== "audit" || can(role, "audit", "V")) && (t.id !== "api" || can(role, "integrations", "C"))).map((t) => (
            <Link
              key={t.id}
              href={`/admin?tab=${t.id}`}
              className={`relative px-3 py-3 text-[13px] font-medium whitespace-nowrap transition ${tab === t.id ? "text-ink" : "text-ink-3 hover:text-ink"}`}
            >
              {t.label}
              {tab === t.id && <span className="absolute inset-x-3 bottom-0 h-[2px] bg-ink" />}
            </Link>
          ))}
        </nav>
      </div>
      <div className="px-6 py-6">{body}</div>
    </div>
  );
}

function NoAccess() {
  return <p className="panel p-6 text-[13px] text-ink-3">Your role can&apos;t view this section.</p>;
}
