ALTER TABLE "backup_snapshots" ADD COLUMN "day" text;--> statement-breakpoint
ALTER TABLE "backup_snapshots" ADD COLUMN "key_enc" text;--> statement-breakpoint
ALTER TABLE "backup_snapshots" ADD COLUMN "cursor" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "backup_snapshots_cron_day" ON "backup_snapshots" USING btree ("tenant_id","day") WHERE "backup_snapshots"."trigger" = 'cron';