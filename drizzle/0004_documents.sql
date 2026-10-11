CREATE TABLE "document_comments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"version_n" integer NOT NULL,
	"field_key" text,
	"kind" text DEFAULT 'comment' NOT NULL,
	"body" text NOT NULL,
	"author_user_id" uuid,
	"author_person_id" text,
	"author_name" text NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"resolved" boolean DEFAULT false NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_comments_kind" CHECK ("document_comments"."kind" in ('comment','remark','approval'))
);
--> statement-breakpoint
CREATE TABLE "document_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"version_n" integer,
	"actor" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_templates" (
	"key" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"fields" jsonb NOT NULL,
	"scope" text DEFAULT 'entity' NOT NULL,
	"needs_period" boolean DEFAULT false NOT NULL,
	"output" text DEFAULT 'docx' NOT NULL,
	"taxes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"body" text NOT NULL,
	"fields" jsonb NOT NULL,
	"values" jsonb NOT NULL,
	"calc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"author_id" uuid,
	"author_name" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_versions_doc_n_unique" UNIQUE("document_id","n")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_key" text NOT NULL,
	"title" text NOT NULL,
	"entity_id" text,
	"period" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"reviewer_id" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_status" CHECK ("documents"."status" in ('draft','review','remarks','approved','withdrawn'))
);
--> statement-breakpoint
ALTER TABLE "legal_entities" ADD COLUMN "requisites" jsonb;--> statement-breakpoint
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_author_person_id_people_id_fk" FOREIGN KEY ("author_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_events" ADD CONSTRAINT "document_events_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_template_key_document_templates_key_fk" FOREIGN KEY ("template_key") REFERENCES "public"."document_templates"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_entity_id_legal_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_reviewer_id_people_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_comments_doc_idx" ON "document_comments" USING btree ("document_id","created_at");--> statement-breakpoint
CREATE INDEX "document_events_doc_idx" ON "document_events" USING btree ("document_id","created_at");--> statement-breakpoint
CREATE INDEX "documents_user_updated_idx" ON "documents" USING btree ("created_by","updated_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE FUNCTION "document_versions_immutable"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'document_versions: версия документа неизменяема, создайте новую версию';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "document_versions_no_update" BEFORE UPDATE ON "document_versions" FOR EACH ROW EXECUTE FUNCTION "document_versions_immutable"();
