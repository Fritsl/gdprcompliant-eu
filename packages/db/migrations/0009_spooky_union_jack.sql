CREATE TABLE "corpus_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_ref" text NOT NULL,
	"corpus_version" text NOT NULL,
	"instrument" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"article" text NOT NULL,
	"paragraph" text,
	"point" text,
	"heading" text,
	"text" text NOT NULL,
	"hash" text NOT NULL,
	"source_url" text NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"embedding" vector(1024),
	CONSTRAINT "corpus_chunks_shared" CHECK ("corpus_chunks"."tenant_id" = 'shared'),
	CONSTRAINT "corpus_chunks_kind" CHECK ("kind" in ('article', 'recital', 'guidance', 'decision')),
	CONSTRAINT "corpus_chunks_jurisdiction" CHECK ("corpus_chunks"."jurisdiction" ~ '^(EU|[A-Z]{2})$'),
	CONSTRAINT "corpus_chunks_version" CHECK ("corpus_chunks"."corpus_version" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[a-z0-9-]+)?$'),
	CONSTRAINT "corpus_chunks_hash" CHECK ("corpus_chunks"."hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "corpus_chunks_key_version" ON "corpus_chunks" USING btree ("instrument","corpus_version","key");--> statement-breakpoint
CREATE INDEX "corpus_chunks_jurisdiction_idx" ON "corpus_chunks" USING btree ("jurisdiction","corpus_version");--> statement-breakpoint
-- The corpus (A-08) is shared reference data: every tenant reads it, and only the shared
-- tenant (the ingest) writes it.
ALTER TABLE "corpus_chunks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "corpus_chunks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "corpus_chunks_tenant" ON "corpus_chunks" USING (tenant_id = 'shared' OR tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "corpus_chunks" TO gc_app;
