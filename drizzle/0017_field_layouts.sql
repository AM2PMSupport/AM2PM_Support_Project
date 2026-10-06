CREATE TABLE "field_layouts" (
	"tenant_id" uuid DEFAULT current_setting('app.tenant_id', true)::uuid NOT NULL,
	"entity" text NOT NULL,
	"layout" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "field_layouts_tenant_id_entity_pk" PRIMARY KEY("tenant_id","entity")
);
--> statement-breakpoint
ALTER TABLE "field_layouts" ADD CONSTRAINT "field_layouts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_layouts" ADD CONSTRAINT "field_layouts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Tenant isolation (0001_rls.sql): each workspace sees and edits only its own layout.
GRANT SELECT, INSERT, UPDATE, DELETE ON field_layouts TO app_rls;--> statement-breakpoint
ALTER TABLE field_layouts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON field_layouts TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
