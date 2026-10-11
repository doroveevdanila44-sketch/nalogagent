CREATE TABLE "checks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"item" text NOT NULL,
	"amount" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checks_user_subject_item_unique" UNIQUE("user_id","subject","item")
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text DEFAULT 'calc' NOT NULL,
	"created_by" uuid NOT NULL,
	"recipient_id" text NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"title" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"excel_name" text NOT NULL,
	"excel_file" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_requests_type" CHECK ("review_requests"."type" in ('calc')),
	CONSTRAINT "review_requests_status" CHECK ("review_requests"."status" in ('sent','in_review','confirmed','returned'))
);
--> statement-breakpoint
ALTER TABLE "checks" ADD CONSTRAINT "checks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_recipient_id_people_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_requests_user_created_idx" ON "review_requests" USING btree ("created_by","created_at" DESC NULLS LAST);