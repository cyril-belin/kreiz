import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { contentEntries } from './content-entries.js';

export const kreizAnalyticsEventNames = [
  'page_view',
  'cta_click',
  'contact_form_submitted',
] as const;
export type KreizAnalyticsEventName = (typeof kreizAnalyticsEventNames)[number];

export const kreizDeviceClasses = ['mobile', 'tablet', 'desktop'] as const;
export type KreizDeviceClass = (typeof kreizDeviceClasses)[number];

/**
 * Événements analytics internes (3 événements V1, cadrage §14). Volume élevé
 * par nature : lecture agrégée par `(event_name, created_at)` et purge par
 * rétention via `created_at` — les deux index validés par le cadrage.
 *
 * `session_id` est la session anonyme éphémère (sessionStorage), **sans**
 * lien avec `kreiz_admin_sessions`. `referrer` nullable : NULL = accès
 * direct. `country` est un enrichissement plateforme optionnel, jamais
 * requis par le modèle. `ON DELETE SET NULL` sur le contenu : la télémétrie
 * agrégée doit survivre à une purge du contenu (elle ne bloque jamais une
 * purge, contrairement aux références éditoriales en RESTRICT).
 *
 * Endpoint de collecte et dashboard : slice 8 — table seule ici.
 */
export const analyticsEvents = pgTable(
  'kreiz_analytics_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventName: text('event_name').notNull(),
    path: text('path').notNull(),
    referrer: text('referrer'),
    sessionId: text('session_id').notNull(),
    contentType: text('content_type'),
    contentEntryId: uuid('content_entry_id').references(() => contentEntries.id, {
      onDelete: 'set null',
    }),
    deviceClass: text('device_class'),
    country: text('country'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'kreiz_analytics_events_event_name_check',
      sql`${table.eventName} in ('page_view', 'cta_click', 'contact_form_submitted')`,
    ),
    check(
      'kreiz_analytics_events_device_class_check',
      sql`${table.deviceClass} is null or ${table.deviceClass} in ('mobile', 'tablet', 'desktop')`,
    ),
    index('kreiz_analytics_events_name_created_at_idx').on(table.eventName, table.createdAt),
    index('kreiz_analytics_events_created_at_idx').on(table.createdAt),
  ],
);

export type KreizAnalyticsEvent = typeof analyticsEvents.$inferSelect;
export type KreizAnalyticsEventInsert = typeof analyticsEvents.$inferInsert;
