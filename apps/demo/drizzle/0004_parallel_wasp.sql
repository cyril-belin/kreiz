ALTER TABLE "kreiz_contact_requests" ADD COLUMN "notification_status" text DEFAULT 'not_configured' NOT NULL;--> statement-breakpoint
ALTER TABLE "kreiz_contact_requests" ADD COLUMN "notification_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "kreiz_contact_requests" ADD COLUMN "notification_failure" jsonb;--> statement-breakpoint
ALTER TABLE "kreiz_contact_requests" ADD COLUMN "notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kreiz_contact_requests" ADD COLUMN "notification_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kreiz_contact_requests" ADD COLUMN "dedup_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "kreiz_contact_requests_dedup_key_unique" ON "kreiz_contact_requests" USING btree ("dedup_key") WHERE dedup_key is not null;--> statement-breakpoint
CREATE INDEX "kreiz_contact_requests_notification_due_idx" ON "kreiz_contact_requests" USING btree ("notification_next_attempt_at") WHERE notification_status in ('pending', 'failed') and notification_next_attempt_at is not null;--> statement-breakpoint
CREATE INDEX "kreiz_contact_requests_form_created_idx" ON "kreiz_contact_requests" USING btree ("form_id","created_at");--> statement-breakpoint
ALTER TABLE "kreiz_contact_requests" ADD CONSTRAINT "kreiz_contact_requests_notification_status_check" CHECK ("kreiz_contact_requests"."notification_status" in ('not_configured', 'pending', 'sent', 'failed'));