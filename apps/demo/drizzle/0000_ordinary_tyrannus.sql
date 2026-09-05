CREATE TABLE "kreiz_admin_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_admin_id" uuid NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kreiz_admin_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "kreiz_admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kreiz_analytics_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_name" text NOT NULL,
	"path" text NOT NULL,
	"referrer" text,
	"session_id" text NOT NULL,
	"content_type" text,
	"content_entry_id" uuid,
	"device_class" text,
	"country" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kreiz_analytics_events_event_name_check" CHECK ("kreiz_analytics_events"."event_name" in ('page_view', 'cta_click', 'contact_form_submitted')),
	CONSTRAINT "kreiz_analytics_events_device_class_check" CHECK ("kreiz_analytics_events"."device_class" is null or "kreiz_analytics_events"."device_class" in ('mobile', 'tablet', 'desktop'))
);
--> statement-breakpoint
CREATE TABLE "kreiz_contact_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kreiz_contact_requests_status_check" CHECK ("kreiz_contact_requests"."status" in ('new', 'handled'))
);
--> statement-breakpoint
CREATE TABLE "kreiz_content_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_type" text NOT NULL,
	"route_namespace" text NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"cover_media_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"seo" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "kreiz_content_entries_status_check" CHECK ("kreiz_content_entries"."status" in ('draft', 'published'))
);
--> statement-breakpoint
CREATE TABLE "demo_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kreiz_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"failure_reason" text,
	"storage_key" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"alt_text" text DEFAULT '' NOT NULL,
	"variants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "kreiz_media_status_check" CHECK ("kreiz_media"."status" in ('uploading', 'processing', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "kreiz_rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kreiz_redirects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_path" text NOT NULL,
	"to_path" text NOT NULL,
	"content_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kreiz_admin_audit_log" ADD CONSTRAINT "kreiz_admin_audit_log_actor_admin_id_kreiz_admin_users_id_fk" FOREIGN KEY ("actor_admin_id") REFERENCES "public"."kreiz_admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kreiz_admin_sessions" ADD CONSTRAINT "kreiz_admin_sessions_admin_id_kreiz_admin_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."kreiz_admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kreiz_analytics_events" ADD CONSTRAINT "kreiz_analytics_events_content_entry_id_kreiz_content_entries_id_fk" FOREIGN KEY ("content_entry_id") REFERENCES "public"."kreiz_content_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kreiz_content_entries" ADD CONSTRAINT "kreiz_content_entries_cover_media_id_kreiz_media_id_fk" FOREIGN KEY ("cover_media_id") REFERENCES "public"."kreiz_media"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kreiz_content_entries" ADD CONSTRAINT "kreiz_content_entries_created_by_kreiz_admin_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."kreiz_admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kreiz_content_entries" ADD CONSTRAINT "kreiz_content_entries_updated_by_kreiz_admin_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."kreiz_admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kreiz_media" ADD CONSTRAINT "kreiz_media_uploaded_by_kreiz_admin_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."kreiz_admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kreiz_redirects" ADD CONSTRAINT "kreiz_redirects_content_entry_id_kreiz_content_entries_id_fk" FOREIGN KEY ("content_entry_id") REFERENCES "public"."kreiz_content_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kreiz_admin_sessions_token_hash_key" ON "kreiz_admin_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "kreiz_admin_sessions_admin_id_idx" ON "kreiz_admin_sessions" USING btree ("admin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kreiz_admin_users_email_key" ON "kreiz_admin_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "kreiz_analytics_events_name_created_at_idx" ON "kreiz_analytics_events" USING btree ("event_name","created_at");--> statement-breakpoint
CREATE INDEX "kreiz_analytics_events_created_at_idx" ON "kreiz_analytics_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "kreiz_content_entries_namespace_slug_active_key" ON "kreiz_content_entries" USING btree ("route_namespace","slug") WHERE "kreiz_content_entries"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "kreiz_content_entries_type_status_published_idx" ON "kreiz_content_entries" USING btree ("content_type","status","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "kreiz_content_entries_namespace_published_idx" ON "kreiz_content_entries" USING btree ("route_namespace","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "kreiz_redirects_from_path_key" ON "kreiz_redirects" USING btree ("from_path");