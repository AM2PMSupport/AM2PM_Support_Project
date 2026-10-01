CREATE INDEX "callbacks_pending_due" ON "callbacks" USING btree ("due_at") WHERE "callbacks"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "contacts_search_name" ON "contacts" USING gin ("tenant_id","name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_search_phone" ON "contacts" USING gin ("tenant_id","phone_key" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_search_email" ON "contacts" USING gin ("tenant_id","email" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "interactions_customer" ON "interactions" USING btree ("tenant_id","customer_number","started_at");--> statement-breakpoint
CREATE INDEX "interactions_agent_customer" ON "interactions" USING btree ("tenant_id","agent_number","customer_number","started_at");--> statement-breakpoint
CREATE INDEX "leads_open_by_owner" ON "leads" USING btree ("assigned_to") WHERE "leads"."status" = 'open';