ALTER TABLE "kreiz_analytics_events" DROP CONSTRAINT "kreiz_analytics_events_event_name_check";--> statement-breakpoint
ALTER TABLE "kreiz_analytics_events" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "kreiz_analytics_events" ADD COLUMN "referrer_kind" text;--> statement-breakpoint
ALTER TABLE "kreiz_analytics_events" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "kreiz_analytics_events" ADD COLUMN "utm_source" text;--> statement-breakpoint
ALTER TABLE "kreiz_analytics_events" ADD COLUMN "utm_medium" text;--> statement-breakpoint
ALTER TABLE "kreiz_analytics_events" ADD COLUMN "utm_campaign" text;--> statement-breakpoint
ALTER TABLE "kreiz_analytics_events" ADD COLUMN "utm_content" text;--> statement-breakpoint
ALTER TABLE "kreiz_analytics_events" ADD COLUMN "utm_term" text;--> statement-breakpoint
ALTER TABLE "kreiz_analytics_events" ADD COLUMN "dedup_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "kreiz_analytics_events_dedup_key_unique" ON "kreiz_analytics_events" USING btree ("dedup_key") WHERE dedup_key is not null;--> statement-breakpoint
ALTER TABLE "kreiz_analytics_events" ADD CONSTRAINT "kreiz_analytics_events_referrer_kind_check" CHECK ("kreiz_analytics_events"."referrer_kind" is null or "kreiz_analytics_events"."referrer_kind" in ('internal', 'external'));--> statement-breakpoint
ALTER TABLE "kreiz_analytics_events" ADD CONSTRAINT "kreiz_analytics_events_path_len_check" CHECK (char_length("kreiz_analytics_events"."path") <= 512);--> statement-breakpoint
ALTER TABLE "kreiz_analytics_events" ADD CONSTRAINT "kreiz_analytics_events_referrer_len_check" CHECK (char_length("kreiz_analytics_events"."referrer") <= 253);--> statement-breakpoint
ALTER TABLE "kreiz_analytics_events" ADD CONSTRAINT "kreiz_analytics_events_session_len_check" CHECK (char_length("kreiz_analytics_events"."session_id") <= 64);--> statement-breakpoint
ALTER TABLE "kreiz_analytics_events" ADD CONSTRAINT "kreiz_analytics_events_locale_len_check" CHECK (char_length("kreiz_analytics_events"."locale") <= 35);--> statement-breakpoint
ALTER TABLE "kreiz_analytics_events" ADD CONSTRAINT "kreiz_analytics_events_utm_len_check" CHECK (char_length("kreiz_analytics_events"."utm_source") <= 128 and char_length("kreiz_analytics_events"."utm_medium") <= 128
        and char_length("kreiz_analytics_events"."utm_campaign") <= 128 and char_length("kreiz_analytics_events"."utm_content") <= 128
        and char_length("kreiz_analytics_events"."utm_term") <= 128);--> statement-breakpoint
ALTER TABLE "kreiz_analytics_events" ADD CONSTRAINT "kreiz_analytics_events_dedup_key_len_check" CHECK (char_length("kreiz_analytics_events"."dedup_key") <= 700);--> statement-breakpoint
ALTER TABLE "kreiz_analytics_events" ADD CONSTRAINT "kreiz_analytics_events_event_name_check" CHECK ("kreiz_analytics_events"."event_name" in ('page_view', 'cta_click', 'form_accepted', 'form_notification_sent'));