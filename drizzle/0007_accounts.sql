CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"password_changed_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"last_tenant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_last_tenant_id_tenants_id_fk" FOREIGN KEY ("last_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_email" ON "accounts" USING btree ("email");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_account" ON "users" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE INDEX "users_account" ON "users" USING btree ("account_id");--> statement-breakpoint
-- Backfill: one account per email that exists in exactly ONE workspace,
-- carrying that row's password. An email already present in several
-- workspaces is NOT auto-linked (those rows were created by different
-- admins; linking them would let one workspace's admin reach another).
-- Login already refused such emails (409); AM2PM super admins link them.
INSERT INTO "accounts" ("email", "password_hash", "password_changed_at", "last_login_at", "last_tenant_id")
SELECT lower(u.email), u.password_hash, u.password_changed_at, u.last_login_at, u.tenant_id
FROM "users" u
WHERE lower(u.email) IN (SELECT lower(email) FROM "users" GROUP BY lower(email) HAVING count(*) = 1)
ON CONFLICT ("email") DO NOTHING;--> statement-breakpoint
UPDATE "users" u SET "account_id" = a.id FROM "accounts" a WHERE a.email = lower(u.email) AND u.account_id IS NULL;--> statement-breakpoint
-- Logins are platform-level: the RLS role gets NO access (0006 set default
-- privileges that would otherwise grant it). RLS on with no policy as a
-- second lock.
REVOKE ALL ON "accounts" FROM app_rls;--> statement-breakpoint
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;
