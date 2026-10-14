ALTER TABLE "legal_entities" ADD COLUMN IF NOT EXISTS "revenue_per_car_monthly" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "legal_entities" ADD COLUMN IF NOT EXISTS "activity" text;--> statement-breakpoint
UPDATE "legal_entities" SET "revenue_per_car_monthly" = CASE "id"
  WHEN 'alfa' THEN 180000.00
  WHEN 'beta' THEN 150000.00
  WHEN 'delta' THEN 130000.00
  WHEN 'gamma' THEN 160000.00
  WHEN 'epsilon' THEN 170000.00
END
WHERE "id" IN ('alfa', 'beta', 'delta', 'gamma', 'epsilon') AND "revenue_per_car_monthly" IS NULL;--> statement-breakpoint
UPDATE "legal_entities" SET "activity" = CASE "id"
  WHEN 'alfa' THEN 'rent_no_crew'
  WHEN 'beta' THEN 'rent_no_crew'
  WHEN 'delta' THEN 'rent_no_crew'
  WHEN 'gamma' THEN 'rent_with_crew'
  WHEN 'epsilon' THEN 'other'
END
WHERE "id" IN ('alfa', 'beta', 'delta', 'gamma', 'epsilon') AND "activity" IS NULL;
