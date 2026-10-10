ALTER TABLE "legal_entities" ADD COLUMN "tax_regime" text DEFAULT 'usn_income' NOT NULL;--> statement-breakpoint
ALTER TABLE "legal_entities" ADD COLUMN "usn_rate" numeric(5, 4);--> statement-breakpoint
ALTER TABLE "legal_entities" ADD COLUMN "annual_expenses" numeric(18, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "legal_entities" ADD CONSTRAINT "legal_entities_tax_regime" CHECK ("legal_entities"."tax_regime" in ('usn_income','usn_income_expense','osno'));--> statement-breakpoint
ALTER TABLE "legal_entities" ADD CONSTRAINT "legal_entities_usn_rate_range" CHECK ("legal_entities"."usn_rate" is null or "legal_entities"."usn_rate" between 0 and 1);