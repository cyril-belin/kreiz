ALTER TABLE "kreiz_content_entries" ADD COLUMN "published_slug" text;--> statement-breakpoint
ALTER TABLE "kreiz_content_entries" ADD COLUMN "published_title" text;--> statement-breakpoint
ALTER TABLE "kreiz_content_entries" ADD COLUMN "published_data" jsonb;--> statement-breakpoint
ALTER TABLE "kreiz_content_entries" ADD COLUMN "published_seo" jsonb;