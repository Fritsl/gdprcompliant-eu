ALTER TABLE "cases" ADD COLUMN "referral_code" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "referred_by" text;--> statement-breakpoint
CREATE UNIQUE INDEX "cases_referral_code" ON "cases" USING btree ("referral_code");