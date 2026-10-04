ALTER TABLE "contacts" ADD COLUMN "alt_phone_e164" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "alt_phone_key" text;--> statement-breakpoint
CREATE INDEX "contacts_tenant_alt_phone" ON "contacts" USING btree ("tenant_id","alt_phone_key");--> statement-breakpoint
CREATE INDEX "contacts_search_alt_phone" ON "contacts" USING gin ("tenant_id","alt_phone_key" gin_trgm_ops);