-- The one extension the whole database relies on. Installed into public so every
-- schema, including a test schema of its own, can use the vector type.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
--> statement-breakpoint
CREATE TABLE "app_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
