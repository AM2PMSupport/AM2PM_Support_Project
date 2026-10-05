/**
 * Postgres schema (Neon) — the single source of truth for tables, foreign
 * keys and indexes (DESIGN.md §2). `npm run db:generate` turns changes here
 * into a SQL migration in drizzle/; never edit tables by hand in Neon.
 *
 * Conventions
 * - Primary keys are UUIDs (`gen_random_uuid()`).
 * - Every tenant-scoped table has `tenant_id`. Its DEFAULT reads the
 *   transaction setting `app.tenant_id`, so inserts made inside withTenant()
 *   are stamped automatically; row-level security (drizzle/0001_rls.sql)
 *   makes rows of other tenants invisible and unwritable (RULE.md §1).
 * - Every tenant-scoped index starts with tenant_id.
 * - Relations are real foreign keys. JSONB is used only for data whose shape
 *   varies per client: custom fields, source payloads, settings.
 * - Timestamps are `timestamptz` (UTC); the UI converts to tenant timezone.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ------------------------------------------------------------------ helpers

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);

/** Filled from the transaction's app.tenant_id (set by withTenant). */
const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .default(sql`current_setting('app.tenant_id', true)::uuid`)
    .references(() => tenants.id, { onDelete: "cascade" });

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

// ------------------------------------------------------------------ JSON shapes

export type Role =
  | "super_admin"
  | "admin"
  | "project_supervisor"
  | "manager"
  | "process_coordinator"
  | "trainer"
  | "client"
  | "agent"
  // Added 2026-10-05 (MEMORIE.md): HR = employee profiles, Auditor = process
  // audit (read-only), Accounts = billing.
  | "hr"
  | "auditor"
  | "accounts";

export type AssignmentMethod = "equal" | "percentage" | "ratio" | "number" | "load" | "skill";

export interface WorkingHours {
  /** 0 = Sunday … 6 = Saturday, tenant timezone. */
  days: number[];
  /** "HH:mm", 24h, tenant timezone. */
  start: string;
  end: string;
}

export interface AssignmentConfig {
  method: AssignmentMethod;
  /** Restrict to these user ids; empty/absent = every agent mapped to the process. */
  pool?: string[];
  sticky: boolean;
  workingHours?: WorkingHours;
  slaMinutes: number;
  recycleHours?: number;
  /** Lead custom fields whose values must be in the agent's skills ("skill" method). */
  skillFields?: string[];
}

export type LeadSourceKind =
  | "web_form"
  | "meta_ads"
  | "google_ads"
  | "indiamart"
  | "justdial"
  | "csv"
  | "sheet"
  | "api"
  | "inbound_call"
  | "manual";

export interface LeadSourceInfo {
  kind: LeadSourceKind;
  sourceId?: string;
  batchId?: string;
  campaign?: string;
  adId?: string;
  formId?: string;
}

export type OutboundCallStatus =
  | "initiated"
  | "agent_ringing"
  | "agent_no_answer"
  | "customer_ringing"
  | "answered"
  | "busy"
  | "no_answer"
  | "failed"
  | "completed"
  | "unknown";

export type InboundCallStatus = "ringing" | "answered" | "missed" | "completed";

// ------------------------------------------------------------------ platform

/** Client organisations (and AM2PM itself). Global table: no tenant_id. */
export const tenants = pgTable("tenants", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  status: text("status").$type<"active" | "trial" | "suspended" | "closed">().notNull().default("active"),
  timezone: text("timezone").notNull().default("Asia/Kolkata"),
  currency: text("currency").notNull().default("INR"),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
});

/**
 * A person's ONE login across workspaces (Zoho-style org switching).
 * Platform-level: no tenant_id, and the RLS role app_rls has NO access
 * (drizzle/0007) — only lib/platform-admin reads or writes it. Each
 * workspace membership is a `users` row pointing here (role per workspace).
 */
export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    /** Always stored lower-cased. */
    email: text("email").notNull(),
    /** scrypt hash (lib/auth/password.ts). Null = cannot sign in yet. */
    passwordHash: text("password_hash"),
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    /** Workspace to open after sign-in (the last one used). */
    lastTenantId: uuid("last_tenant_id").references(() => tenants.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [uniqueIndex("accounts_email").on(t.email)],
);

export const users = pgTable(
  "users",
  {
    id: id(),
    tenantId: tenantId(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    role: text("role").$type<Role>().notNull(),
    /** Phone that rings for click-to-call and inbound calls (never a SIP URI). */
    agentPhoneE164: text("agent_phone_e164"),
    agentPhone10: text("agent_phone_10"),
    agentPhoneVerifiedAt: timestamp("agent_phone_verified_at", { withTimezone: true }),
    providerAgentId: text("provider_agent_id"),
    /** Outbound caller-ID DID, exactly as registered (leading 0 kept). */
    did: text("did"),
    shareWeight: integer("share_weight").notNull().default(1),
    skills: text("skills").array().notNull().default(sql`'{}'::text[]`),
    maxOpenLeads: integer("max_open_leads").notNull().default(50),
    openLeads: integer("open_leads").notNull().default(0),
    dailyQuota: integer("daily_quota"),
    isAvailable: boolean("is_available").notNull().default(false),
    status: text("status").$type<"active" | "inactive" | "locked">().notNull().default("active"),
    /** The person's login (accounts). One membership per workspace. */
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    /** @deprecated Moved to accounts.password_hash in 0007; kept until the column is dropped. */
    passwordHash: text("password_hash"),
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("users_tenant_email").on(t.tenantId, t.email),
    // One membership per person per workspace; "my workspaces" lookup.
    uniqueIndex("users_tenant_account").on(t.tenantId, t.accountId),
    index("users_account").on(t.accountId),
    // Sign-in looks a user up by email before the tenant is known (platform-level).
    index("users_email").on(t.email),
    // Inbound calls: find the agent whose phone answered.
    index("users_tenant_phone10").on(t.tenantId, t.agentPhone10),
  ],
);

/** A campaign / line of business for one client. */
export const processes = pgTable(
  "processes",
  {
    id: id(),
    tenantId: tenantId(),
    clientTenantId: uuid("client_tenant_id").references(() => tenants.id),
    name: text("name").notNull(),
    stages: text("stages").array().notNull().default(sql`'{New}'::text[]`),
    wonStage: text("won_stage").notNull().default("Won"),
    assignment: jsonb("assignment").$type<AssignmentConfig>().notNull(),
    /** "phoneKey" | "email" | a custom field key. */
    dedupeField: text("dedupe_field").notNull().default("phoneKey"),
    reEnquiryDays: integer("re_enquiry_days"),
    status: text("status").$type<"active" | "paused" | "closed">().notNull().default("active"),
    ...timestamps,
  },
  (t) => [index("processes_tenant_status").on(t.tenantId, t.status)],
);

/** M:N users ↔ processes. Mapping an agent here grants access to that process's leads. */
export const userProcesses = pgTable(
  "user_processes",
  {
    tenantId: tenantId(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    processId: uuid("process_id").notNull().references(() => processes.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.processId] }), index("user_processes_process").on(t.tenantId, t.processId)],
);

export const integrations = pgTable(
  "integrations",
  {
    id: id(),
    tenantId: tenantId(),
    kind: text("kind").$type<"telephony" | "whatsapp" | "email">().notNull(),
    provider: text("provider").notNull(),
    /** AES-256-GCM ciphertext (lib/crypto). Never returned by the API. */
    credentialsEnc: text("credentials_enc").notNull(),
    webhookSecretEnc: text("webhook_secret_enc"),
    config: jsonb("config")
      .$type<{ rateLimitPerMin?: number; routingLookup?: { enabled: boolean; timeoutMs: number } }>()
      .notNull()
      .default({}),
    status: text("status").$type<"active" | "paused" | "error">().notNull().default("active"),
    ...timestamps,
  },
  (t) => [uniqueIndex("integrations_tenant_kind_provider").on(t.tenantId, t.kind, t.provider)],
);

/** Client phone numbers (DIDs). Every inbound DID maps to exactly one process. */
export const telephonyDids = pgTable(
  "telephony_dids",
  {
    id: id(),
    tenantId: tenantId(),
    integrationId: uuid("integration_id").notNull().references(() => integrations.id, { onDelete: "cascade" }),
    /** As registered with the provider (keep the leading 0 for CallerDesk). */
    number: text("number").notNull(),
    /** Last 10 digits, for matching webhook values. */
    number10: text("number_10").notNull(),
    processId: uuid("process_id").notNull().references(() => processes.id),
    direction: text("direction").$type<"inbound" | "outbound" | "both">().notNull().default("both"),
    defaultForOutbound: boolean("default_for_outbound").notNull().default(false),
  },
  (t) => [uniqueIndex("dids_tenant_number10").on(t.tenantId, t.number10)],
);

// ------------------------------------------------------------------ leads

export const contacts = pgTable(
  "contacts",
  {
    id: id(),
    tenantId: tenantId(),
    name: text("name"),
    phoneE164: text("phone_e164"),
    /** Last 10 digits — dedupe / lookup key (crmv7 phoneKey). */
    phoneKey: text("phone_key"),
    /** Second mobile ("Mobile 2"): callable from Leads/console, matched on inbound calls and search. */
    altPhoneE164: text("alt_phone_e164"),
    altPhoneKey: text("alt_phone_key"),
    email: text("email"),
    consent: jsonb("consent")
      .$type<Partial<Record<"whatsapp" | "email" | "sms", { optedIn: boolean; at: string; source: string }>>>()
      .notNull()
      .default({}),
    dnc: boolean("dnc").notNull().default(false),
    custom: jsonb("custom").$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [
    // Exact lookups: inbound caller → contact, dedupe, email match.
    index("contacts_tenant_phone").on(t.tenantId, t.phoneKey),
    index("contacts_tenant_alt_phone").on(t.tenantId, t.altPhoneKey),
    index("contacts_tenant_email").on(t.tenantId, t.email),
    // Search (ILIKE '%…%'): trigram GIN, tenant-first via btree_gin (drizzle/0002).
    index("contacts_search_name").using("gin", t.tenantId, t.name.op("gin_trgm_ops")),
    index("contacts_search_phone").using("gin", t.tenantId, t.phoneKey.op("gin_trgm_ops")),
    index("contacts_search_alt_phone").using("gin", t.tenantId, t.altPhoneKey.op("gin_trgm_ops")),
    index("contacts_search_email").using("gin", t.tenantId, t.email.op("gin_trgm_ops")),
  ],
);

export const importSources = pgTable(
  "import_sources",
  {
    id: id(),
    tenantId: tenantId(),
    kind: text("kind").$type<LeadSourceKind>().notNull(),
    processId: uuid("process_id").notNull().references(() => processes.id),
    /** Source field → CRM field, e.g. { phone_number: "phone", city: "custom.city" }. */
    fieldMap: jsonb("field_map").$type<Record<string, string>>().notNull().default({}),
    /** SHA-256 of the source key; the key itself is shown once. */
    secretHash: text("secret_hash").notNull(),
    status: text("status").$type<"active" | "paused" | "error">().notNull().default("active"),
    lastLeadAt: timestamp("last_lead_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("import_sources_tenant_process").on(t.tenantId, t.processId)],
);

export const leads = pgTable(
  "leads",
  {
    id: id(),
    tenantId: tenantId(),
    processId: uuid("process_id").notNull().references(() => processes.id),
    contactId: uuid("contact_id").notNull().references(() => contacts.id),
    source: jsonb("source").$type<LeadSourceInfo>().notNull(),
    importSourceId: uuid("import_source_id").references(() => importSources.id, { onDelete: "set null" }),
    stage: text("stage").notNull(),
    status: text("status").$type<"open" | "won" | "lost" | "dnc">().notNull().default("open"),
    assignedTo: uuid("assigned_to").references(() => users.id, { onDelete: "set null" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastDisposition: jsonb("last_disposition").$type<{ code: string; label: string; category: string; at: string }>(),
    lastInteractionAt: timestamp("last_interaction_at", { withTimezone: true }),
    nextCallbackAt: timestamp("next_callback_at", { withTimezone: true }),
    /** When supervisors were told this lead breached its unassigned SLA (once per lead; lib/platform-admin/reminders.ts). */
    slaAlertedAt: timestamp("sla_alerted_at", { withTimezone: true }),
    lastEnquiryAt: timestamp("last_enquiry_at", { withTimezone: true }).notNull().defaultNow(),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    /** Dedupe value (phone key, email or custom field) — unique among ACTIVE leads of a process. */
    dedupeKey: text("dedupe_key").notNull(),
    /** false frees the dedupe key (closed + re-enquiry window passed). */
    isActive: boolean("is_active").notNull().default(true),
    /** Recycle bin: set by Delete (is_active goes false too); cleared by Restore. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by"),
    custom: jsonb("custom").$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [
    index("leads_recycle_bin").on(t.tenantId, t.deletedAt).where(sql`${t.deletedAt} is not null`),
    // Dedupe: racing imports cannot create two active leads (ON CONFLICT → merge).
    uniqueIndex("leads_dedupe_active").on(t.tenantId, t.processId, t.dedupeKey).where(sql`${t.isActive}`),
    index("leads_owner_callback").on(t.tenantId, t.assignedTo, t.nextCallbackAt),
    index("leads_process_stage").on(t.tenantId, t.processId, t.stage),
    index("leads_contact").on(t.tenantId, t.contactId),
    index("leads_unassigned").on(t.tenantId, t.createdAt).where(sql`${t.assignedTo} is null and ${t.status} = 'open'`),
    index("leads_custom_gin").using("gin", t.custom),
    // Agent workload / nightly recount: open leads per owner (cross-tenant join on assigned_to).
    index("leads_open_by_owner").on(t.assignedTo).where(sql`${t.status} = 'open'`),
  ],
);

export const leadEvents = pgTable(
  "lead_events",
  {
    id: id(),
    tenantId: tenantId(),
    leadId: uuid("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
    type: text("type")
      .$type<"created" | "merged" | "assigned" | "reassigned" | "stage_changed" | "disposition_set" | "callback_set" | "converted" | "lost" | "restored" | "edited" | "deleted">()
      .notNull(),
    actor: jsonb("actor").$type<{ kind: "user" | "system" | "source"; id?: string; name?: string }>().notNull(),
    before: jsonb("before").$type<Record<string, unknown>>(),
    after: jsonb("after").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("lead_events_lead").on(t.tenantId, t.leadId, t.createdAt)],
);

/** Per-process assignment state. Locked FOR UPDATE while assigning. */
export const assignmentState = pgTable("assignment_state", {
  processId: uuid("process_id")
    .primaryKey()
    .references(() => processes.id, { onDelete: "cascade" }),
  tenantId: tenantId(),
  seq: integer("seq").notNull().default(0),
  /** Smooth weighted round-robin running weights, by user id. */
  smoothWeights: jsonb("smooth_weights").$type<Record<string, number>>().notNull().default({}),
  /** Tenant-local "YYYY-MM-DD" the daily counts belong to. */
  day: text("day").notNull().default(""),
  dailyCounts: jsonb("daily_counts").$type<Record<string, number>>().notNull().default({}),
  updatedAt: timestamps.updatedAt,
});

// ------------------------------------------------------------------ activity

export const interactions = pgTable(
  "interactions",
  {
    id: id(),
    tenantId: tenantId(),
    type: text("type").$type<"call" | "whatsapp" | "email" | "sms" | "note">().notNull(),
    direction: text("direction").$type<"inbound" | "outbound">().notNull(),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    processId: uuid("process_id").references(() => processes.id),
    agentId: uuid("agent_id").references(() => users.id, { onDelete: "set null" }),
    /** Snapshot so history keeps the name if the user is renamed. */
    agentName: text("agent_name"),
    status: text("status").$type<OutboundCallStatus | InboundCallStatus | string>().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSec: integer("duration_sec"),
    talkSec: integer("talk_sec"),
    // --- call fields (click-to-call / inbound; no SIP) ---
    provider: text("provider"),
    providerCallId: text("provider_call_id"),
    /** Our id sent to the provider so webhooks can be matched. */
    correlationId: text("correlation_id"),
    did: text("did"),
    agentNumber: text("agent_number"),
    customerNumber: text("customer_number"),
    hangupBy: text("hangup_by"),
    endReason: text("end_reason"),
    /** Provider URL; copied to Blob/R2, never shown to users. */
    recordingUrl: text("recording_url"),
    recordingKey: text("recording_key"),
    // --- wrap-up ---
    disposition: jsonb("disposition").$type<{ code: string; label: string; category: string; subKey?: string }>(),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("interactions_correlation").on(t.tenantId, t.correlationId).where(sql`${t.correlationId} is not null`),
    uniqueIndex("interactions_provider_call")
      .on(t.tenantId, t.provider, t.providerCallId)
      .where(sql`${t.providerCallId} is not null`),
    index("interactions_lead").on(t.tenantId, t.leadId, t.startedAt),
    // Calls log: all calls newest first, and an agent's own calls.
    index("interactions_calls").on(t.tenantId, t.startedAt).where(sql`${t.type} = 'call'`),
    index("interactions_agent_calls").on(t.tenantId, t.agentId, t.startedAt).where(sql`${t.type} = 'call'`),
    // Quick call lookup: caller history / screen-pop by customer number.
    index("interactions_customer").on(t.tenantId, t.customerNumber, t.startedAt),
    // Webhook fallback match: this agent's latest call to this customer.
    index("interactions_agent_customer").on(t.tenantId, t.agentNumber, t.customerNumber, t.startedAt),
    index("interactions_agent").on(t.tenantId, t.agentId, t.startedAt),
    index("interactions_process").on(t.tenantId, t.processId, t.startedAt),
    // Stuck-call sweeper (platform-wide).
    index("interactions_initiated").on(t.startedAt).where(sql`${t.status} = 'initiated'`),
  ],
);

export const dispositions = pgTable(
  "dispositions",
  {
    id: id(),
    tenantId: tenantId(),
    processId: uuid("process_id").references(() => processes.id, { onDelete: "cascade" }),
    /** Immutable; labels may change. */
    code: text("code").notNull(),
    label: text("label").notNull(),
    category: text("category").$type<"positive" | "negative" | "neutral" | "callback" | "dnc" | "converted">().notNull(),
    actions: jsonb("actions").$type<Record<string, unknown>>().notNull().default({}),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [uniqueIndex("dispositions_code").on(t.tenantId, t.processId, t.code)],
);

export const callbacks = pgTable(
  "callbacks",
  {
    id: id(),
    tenantId: tenantId(),
    leadId: uuid("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
    assignedTo: uuid("assigned_to").references(() => users.id, { onDelete: "set null" }),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    channel: text("channel").$type<"call" | "whatsapp" | "email">().notNull().default("call"),
    status: text("status").$type<"pending" | "done" | "missed" | "escalated" | "cancelled">().notNull().default("pending"),
    /** e.g. "missed_call" (max one per lead per day) or "agent". */
    reason: text("reason").notNull(),
    /** Tenant-local day, used to enforce one missed-call callback per lead per day. */
    day: text("day"),
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    escalatedTo: uuid("escalated_to").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    index("callbacks_due").on(t.tenantId, t.status, t.dueAt),
    index("callbacks_owner").on(t.tenantId, t.assignedTo, t.status, t.dueAt),
    // Reminder cron (platform-wide): pending callbacks by due time.
    index("callbacks_pending_due").on(t.dueAt).where(sql`${t.status} = 'pending'`),
    uniqueIndex("callbacks_missed_once_a_day").on(t.tenantId, t.leadId, t.day).where(sql`${t.reason} = 'missed_call'`),
  ],
);

// ------------------------------------------------------------------ events

/** Raw inbound webhooks (idempotency, debugging, replay). Purged after 60 days. */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: id(),
    tenantId: tenantId(),
    source: text("source").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<"received" | "processing" | "done" | "failed" | "dead">().notNull().default("received"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("webhook_events_idem").on(t.tenantId, t.source, t.idempotencyKey),
    index("webhook_events_created").on(t.createdAt),
    // Stuck-webhook sweep: only the few still "received", not two days of processed rows.
    index("webhook_events_received").on(t.createdAt).where(sql`${t.status} = 'received'`),
  ],
);

/** Transactional outbox. Purged 30 days after publish. */
export const outbox = pgTable(
  "outbox",
  {
    id: id(),
    tenantId: tenantId(),
    eventType: text("event_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("outbox_unpublished").on(t.createdAt).where(sql`${t.publishedAt} is null`)],
);

export const webhookSubscriptions = pgTable(
  "webhook_subscriptions",
  {
    id: id(),
    tenantId: tenantId(),
    url: text("url").notNull(),
    events: text("events").array().notNull(),
    filters: jsonb("filters").$type<{ processIds?: string[]; stages?: string[] }>().notNull().default({}),
    secretEnc: text("secret_enc").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    failingSince: timestamp("failing_since", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("webhook_subscriptions_active").on(t.tenantId, t.isActive)],
);

/** One row per event per subscription. `event_id` has no FK: outbox rows are purged sooner. */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: id(),
    tenantId: tenantId(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => webhookSubscriptions.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").notNull(),
    eventType: text("event_type").notNull(),
    status: text("status").$type<"pending" | "delivered" | "failed" | "dead">().notNull(),
    attempts: jsonb("attempts").$type<{ at: string; responseCode?: number; ms: number; error?: string }[]>().notNull().default([]),
    ...timestamps,
  },
  (t) => [uniqueIndex("webhook_deliveries_sub_event").on(t.subscriptionId, t.eventId), index("webhook_deliveries_created").on(t.createdAt)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    tenantId: tenantId(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: uuid("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_logs_tenant_created").on(t.tenantId, t.createdAt), index("audit_logs_entity").on(t.tenantId, t.entity, t.entityId)],
);

// ------------------------------------------------------------------ Phase 1 additions

/** Teams of agents under a leader, per process. Members live in team_members. */
export const teams = pgTable(
  "teams",
  {
    id: id(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    processId: uuid("process_id").references(() => processes.id, { onDelete: "set null" }),
    leaderId: uuid("leader_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [uniqueIndex("teams_tenant_name").on(t.tenantId, t.name)],
);

export const teamMembers = pgTable(
  "team_members",
  {
    tenantId: tenantId(),
    teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] }), index("team_members_user").on(t.tenantId, t.userId)],
);

export type CustomFieldType = "text" | "number" | "dropdown" | "multiselect" | "date" | "boolean" | "phone" | "email";

/** Per-tenant (optionally per-process) custom field definitions; values live in `custom` JSONB. */
export const customFieldDefinitions = pgTable(
  "custom_field_definitions",
  {
    id: id(),
    tenantId: tenantId(),
    entity: text("entity").$type<"lead" | "contact">().notNull(),
    processId: uuid("process_id").references(() => processes.id, { onDelete: "cascade" }),
    /** Immutable machine key, stored inside `custom`. */
    key: text("key").notNull(),
    label: text("label").notNull(),
    type: text("type").$type<CustomFieldType>().notNull(),
    options: text("options").array().notNull().default(sql`'{}'::text[]`),
    required: boolean("required").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [unique("custom_fields_key").on(t.tenantId, t.entity, t.processId, t.key).nullsNotDistinct()],
);

/** In-app notifications: callback due, missed call, lead re-enquired, SLA breach, digest. */
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"callback_due" | "callback_missed" | "lead_merged" | "sla_breach" | "lead_assigned" | "missed_call" | "system">().notNull(),
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
    /** Dedupe key so a reminder is created once (e.g. "cb-due:<callbackId>"). */
    dedupeKey: text("dedupe_key"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notifications_inbox").on(t.tenantId, t.userId, t.readAt, t.createdAt),
    uniqueIndex("notifications_dedupe").on(t.tenantId, t.dedupeKey).where(sql`${t.dedupeKey} is not null`),
  ],
);

/**
 * API keys for the REST + GraphQL API (T2.5): integrations and client CRMs.
 * A key acts AS the user who created it (same role, scope and audit trail).
 * Only the SHA-256 of the key is stored; the key is shown once. `prefix` is
 * the first characters, kept to recognise a key in the list.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    /** "read" = GET + GraphQL queries; "write" = also creates/updates/deletes. */
    scope: text("scope").$type<"read" | "write">().notNull().default("read"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("api_keys_hash").on(t.keyHash), index("api_keys_tenant").on(t.tenantId, t.createdAt)],
);

/**
 * Per-workspace edits to the role permission matrix (Setup → Roles). Only
 * cells that differ from the defaults in lib/auth/rbac.ts are stored; a
 * missing row means "default". `actions` is a subset of "VCEDAXI" in that
 * order. Super Admin's grants are fixed and never stored here. Edited only
 * by a Super Admin (lib/admin/roles.ts).
 */
export const rolePermissions = pgTable(
  "role_permissions",
  {
    tenantId: tenantId(),
    role: text("role").$type<Role>().notNull(),
    module: text("module").notNull(),
    actions: text("actions").notNull(),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.role, t.module] })],
);

/**
 * Saved list filters ("Meta leads", "My overdue callbacks"). Personal, or
 * shared with the whole workspace. `query` is the Leads screen's URL
 * search params (validated by lib/leads/list.ts on use).
 */
export const savedViews = pgTable(
  "saved_views",
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    module: text("module").$type<"leads">().notNull().default("leads"),
    name: text("name").notNull(),
    query: jsonb("query").$type<Record<string, string>>().notNull().default({}),
    shared: boolean("shared").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("saved_views_owner").on(t.tenantId, t.module, t.userId)],
);

/** One CSV upload or scheduled sheet pull. */
export const importBatches = pgTable(
  "import_batches",
  {
    id: id(),
    tenantId: tenantId(),
    sourceId: uuid("source_id").references(() => importSources.id, { onDelete: "set null" }),
    processId: uuid("process_id").notNull().references(() => processes.id),
    fileName: text("file_name"),
    fileKey: text("file_key"),
    total: integer("total").notNull().default(0),
    inserted: integer("inserted").notNull().default(0),
    merged: integer("merged").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    /** First 200 row errors: [{ row, reason }]. */
    errors: jsonb("errors").$type<{ row: number; reason: string }[]>().notNull().default([]),
    status: text("status").$type<"queued" | "running" | "done" | "failed">().notNull().default("queued"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("import_batches_recent").on(t.tenantId, t.createdAt)],
);

/** Per-tenant backup schedule and retention (ARCHITECTURE.md §7). */
export const backupPolicies = pgTable("backup_policies", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .default(sql`current_setting('app.tenant_id', true)::uuid`)
    .references(() => tenants.id, { onDelete: "cascade" }),
  keepDaily: integer("keep_daily").notNull().default(7),
  keepWeekly: integer("keep_weekly").notNull().default(4),
  keepMonthly: integer("keep_monthly").notNull().default(3),
  allowClientDownload: boolean("allow_client_download").notNull().default(false),
  updatedAt: timestamps.updatedAt,
});

export const backupSnapshots = pgTable(
  "backup_snapshots",
  {
    id: id(),
    tenantId: tenantId(),
    trigger: text("trigger").$type<"cron" | "manual" | "pre_restore">().notNull(),
    status: text("status").$type<"running" | "completed" | "failed">().notNull().default("running"),
    /** { table: { rows, bytes, sha256, key } } */
    files: jsonb("files").$type<Record<string, { rows: number; bytes: number; sha256: string; key: string }>>().notNull().default({}),
    sizeBytes: integer("size_bytes").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("backup_snapshots_recent").on(t.tenantId, t.startedAt)],
);

// ------------------------------------------------------------------ row types

export type Tenant = typeof tenants.$inferSelect;
export type User = typeof users.$inferSelect;
export type Process = typeof processes.$inferSelect;
export type Integration = typeof integrations.$inferSelect;
export type TelephonyDid = typeof telephonyDids.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type ImportSource = typeof importSources.$inferSelect;
export type Lead = typeof leads.$inferSelect;
export type Interaction = typeof interactions.$inferSelect;
export type LeadEvent = typeof leadEvents.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type SavedView = typeof savedViews.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Callback = typeof callbacks.$inferSelect;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type OutboxEvent = typeof outbox.$inferSelect;
export type WebhookSubscription = typeof webhookSubscriptions.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type CustomFieldDefinition = typeof customFieldDefinitions.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type ImportBatch = typeof importBatches.$inferSelect;
export type Disposition = typeof dispositions.$inferSelect;
