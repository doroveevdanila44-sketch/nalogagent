CREATE TABLE "data_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"is_demo" boolean DEFAULT true NOT NULL,
	"loaded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "data_sources_kind" CHECK ("data_sources"."kind" in ('demo_1c'))
);
--> statement-breakpoint
ALTER TABLE "revenue_monthly" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "revenue_monthly" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "revenue_monthly" ADD CONSTRAINT "revenue_monthly_source_id_data_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE no action ON UPDATE no action;