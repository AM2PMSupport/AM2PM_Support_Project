CREATE TABLE "workforce_connections" (
	"provider" text PRIMARY KEY NOT NULL,
	"credentials_enc" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"entries_cursor" timestamp with time zone,
	"entries_synced_at" timestamp with time zone,
	"people_synced_at" timestamp with time zone,
	"leave_synced_at" timestamp with time zone,
	"last_errors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workforce_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"type" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"belongs_to_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workforce_holidays" (
	"date" date NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "workforce_holidays_date_name_pk" PRIMARY KEY("date","name")
);
--> statement-breakpoint
CREATE TABLE "workforce_leave" (
	"id" text PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" text NOT NULL,
	"kind" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workforce_people" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid,
	"linked_by" text,
	"email" text,
	"full_name" text NOT NULL,
	"code" text,
	"status" text,
	"state" text,
	"state_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "on_leave_on" text;--> statement-breakpoint
ALTER TABLE "workforce_connections" ADD CONSTRAINT "workforce_connections_updated_by_accounts_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_people" ADD CONSTRAINT "workforce_people_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workforce_entries_person_day" ON "workforce_entries" USING btree ("person_id","belongs_to_date","at");--> statement-breakpoint
CREATE INDEX "workforce_entries_day" ON "workforce_entries" USING btree ("belongs_to_date");--> statement-breakpoint
CREATE INDEX "workforce_leave_person" ON "workforce_leave" USING btree ("person_id","start_date");--> statement-breakpoint
CREATE INDEX "workforce_leave_dates" ON "workforce_leave" USING btree ("start_date","end_date");--> statement-breakpoint
CREATE INDEX "workforce_people_account" ON "workforce_people" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "workforce_people_email" ON "workforce_people" USING btree (lower("email"));--> statement-breakpoint
-- Platform tables (like accounts, 0007): the RLS-bound app role gets nothing; only lib/platform-admin reads them.
REVOKE ALL ON "workforce_connections" FROM app_rls;--> statement-breakpoint
REVOKE ALL ON "workforce_people" FROM app_rls;--> statement-breakpoint
REVOKE ALL ON "workforce_entries" FROM app_rls;--> statement-breakpoint
REVOKE ALL ON "workforce_leave" FROM app_rls;--> statement-breakpoint
REVOKE ALL ON "workforce_holidays" FROM app_rls;
