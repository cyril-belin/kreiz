import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { adminUsers } from './admin-users.js';
import { media } from './media.js';

export const kreizContentStatuses = ['draft', 'published'] as const;
export type KreizContentStatus = (typeof kreizContentStatuses)[number];

/**
 * SEO d'une entrée (JSONB `seo`). Clés JSONB en camelCase : le JSONB est
 * consommé par le TS applicatif (templates, helpers SEO), pas interrogé en
 * SQL brut. `ogImageMediaId` référence un média par identifiant : référence
 * logique, pas de FK SQL possible depuis un JSONB.
 */
export type KreizContentSeo = {
  title?: string;
  description?: string;
  canonicalOverride?: string;
  ogImageMediaId?: string;
};

/**
 * Contenus génériques — le cœur du moteur éditorial (slices 3 et 4).
 *
 * `data` est validé par le schéma Zod du type de contenu déclaré en code
 * (cadrage §8), pas au niveau SQL. Suppression = soft delete (`deleted_at`).
 *
 * Contrainte structurante : unicité `(route_namespace, slug)` **partielle**
 * (`WHERE deleted_at IS NULL`) — un slug réapparaît disponible après soft
 * delete, sans jamais entrer en collision avec un contenu actif.
 * `ON DELETE RESTRICT` sur `created_by` / `updated_by` / `cover_media_id` :
 * ni un admin ni un média référencés ne peuvent être supprimés physiquement
 * et écraser l'historique éditorial par effet de bord.
 */
export const contentEntries = pgTable(
  'kreiz_content_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contentType: text('content_type').notNull(),
    routeNamespace: text('route_namespace').notNull(),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    coverMediaId: uuid('cover_media_id').references(() => media.id, { onDelete: 'restrict' }),
    status: text('status').$type<KreizContentStatus>().notNull().default('draft'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    seo: jsonb('seo').$type<KreizContentSeo>().notNull().default({}),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'restrict' }),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('kreiz_content_entries_namespace_slug_active_key')
      .on(table.routeNamespace, table.slug)
      .where(sql`${table.deletedAt} is null`),
    // Listings admin et build par type/statut/date (cadrage §7).
    index('kreiz_content_entries_type_status_published_idx').on(
      table.contentType,
      table.status,
      table.publishedAt.desc(),
    ),
    index('kreiz_content_entries_namespace_published_idx').on(
      table.routeNamespace,
      table.publishedAt.desc(),
    ),
    check(
      'kreiz_content_entries_status_check',
      sql`${table.status} in ('draft', 'published')`,
    ),
  ],
);

export type KreizContentEntry = typeof contentEntries.$inferSelect;
export type KreizContentEntryInsert = typeof contentEntries.$inferInsert;
