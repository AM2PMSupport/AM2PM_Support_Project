ALTER TABLE "leads" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
CREATE INDEX "leads_recycle_bin" ON "leads" USING btree ("tenant_id","deleted_at") WHERE "leads"."deleted_at" is not null;