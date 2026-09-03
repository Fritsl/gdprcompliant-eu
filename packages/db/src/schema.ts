import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// The relational schema, as Drizzle tables. F-02 lays the harness and one table; F-03
// adds the spine (tenants, cases, case_events, findings, evidence, remedies, ...), each
// with tenant_id, created_at and a source reference, and the append-only and NOT NULL
// constraints that make the product rules structural.

// Facts about the database itself: schema version markers, seed stamps, and the like.
export const appMeta = pgTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
