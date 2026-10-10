CREATE TABLE "agent_state" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"refusal_index" integer DEFAULT 0 NOT NULL,
	"greet_index" integer DEFAULT 0 NOT NULL,
	"last_active" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid,
	"device_id" uuid,
	"ip" "inet",
	"login_tried" text
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"class" text,
	"content" text NOT NULL,
	"calc" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_role" CHECK ("chat_messages"."role" in ('user','agent'))
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"pin_hash" text,
	"pin_failed" integer DEFAULT 0 NOT NULL,
	"pin_blocked" boolean DEFAULT false NOT NULL,
	"user_agent" text,
	"password_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "legal_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"form" text NOT NULL,
	"owner_label" text NOT NULL,
	"vat_status" text NOT NULL,
	"annual_revenue" numeric(18, 2) NOT NULL,
	"input_vat_share" numeric(5, 4) NOT NULL,
	"color" text NOT NULL,
	"description" text,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "legal_entities_vat_status" CHECK ("legal_entities"."vat_status" in ('payer','exempt')),
	CONSTRAINT "legal_entities_share_range" CHECK ("legal_entities"."input_vat_share" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"latency_ms" integer,
	"ok" boolean DEFAULT true NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "rate_choices" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"year" integer NOT NULL,
	"rate" integer NOT NULL,
	"chosen_by" uuid,
	"chosen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_choices_rate" CHECK ("rate_choices"."rate" in (5,7,22))
);
--> statement-breakpoint
CREATE TABLE "revenue_monthly" (
	"entity_id" text NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"is_fact" boolean DEFAULT false NOT NULL,
	CONSTRAINT "revenue_monthly_entity_id_year_month_pk" PRIMARY KEY("entity_id","year","month"),
	CONSTRAINT "revenue_monthly_month_range" CHECK ("revenue_monthly"."month" between 1 and 12)
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" numeric(18, 4),
	"formula" text,
	"unit" text DEFAULT 'rub' NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"norm" text,
	"source_url" text,
	"note" text,
	CONSTRAINT "rules_key_valid_from_unique" UNIQUE("key","valid_from")
);
--> statement-breakpoint
CREATE TABLE "seasonality" (
	"month" integer PRIMARY KEY NOT NULL,
	"weight" numeric(6, 4) NOT NULL,
	CONSTRAINT "seasonality_month_range" CHECK ("seasonality"."month" between 1 and 12)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"locked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"login" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_login_unique" UNIQUE("login"),
	CONSTRAINT "users_login_lower" CHECK ("users"."login" = lower("users"."login"))
);
--> statement-breakpoint
CREATE TABLE "webauthn_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webauthn_credentials_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
ALTER TABLE "agent_state" ADD CONSTRAINT "agent_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_events" ADD CONSTRAINT "auth_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_events" ADD CONSTRAINT "auth_events_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_choices" ADD CONSTRAINT "rate_choices_entity_id_legal_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_choices" ADD CONSTRAINT "rate_choices_chosen_by_users_id_fk" FOREIGN KEY ("chosen_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_monthly" ADD CONSTRAINT "revenue_monthly_entity_id_legal_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_events_kind_at_idx" ON "auth_events" USING btree ("kind","at");--> statement-breakpoint
CREATE INDEX "auth_events_ip_at_idx" ON "auth_events" USING btree ("ip","at");--> statement-breakpoint
CREATE INDEX "auth_events_login_at_idx" ON "auth_events" USING btree ("login_tried","at");--> statement-breakpoint
CREATE INDEX "chat_messages_user_created_idx" ON "chat_messages" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "devices_user_id_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "rate_choices_entity_year_idx" ON "rate_choices" USING btree ("entity_id","year","chosen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_device_id_idx" ON "sessions" USING btree ("device_id");