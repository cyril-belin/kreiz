import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { adminUsers } from './admin-users.js';

/**
 * Médias. Le pipeline (upload présigné, vérification serveur, variantes
 * asynchrones) appartient au slice 5 — table seule ici.
 *
 * Cycle de vie explicite : `uploading → processing → ready | failed`.
 * `width` / `height` sont nullables : les types sans dimensions (PDF…)
 * n'en possèdent pas. `alt_text` est requis pour insérer un média dans un
 * contenu (slice 5) mais pas à la création de la ligne.
 * Suppression = soft delete (`deleted_at`) ; `ON DELETE RESTRICT` depuis
 * `kreiz_content_entries.cover_media_id` interdit d'écraser par effet de bord
 * une couverture référencée.
 */
export const kreizMediaStatuses = ['uploading', 'processing', 'ready', 'failed'] as const;
export type KreizMediaStatus = (typeof kreizMediaStatuses)[number];

/** Variante générée d'une image. Clés JSONB en camelCase (consommées par le TS applicatif). */
export type KreizMediaVariant = {
  key: string;
  width: number;
  format: string;
  sizeBytes: number;
};

export const media = pgTable(
  'kreiz_media',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    status: text('status').$type<KreizMediaStatus>().notNull().default('uploading'),
    failureReason: text('failure_reason'),
    storageKey: text('storage_key').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    width: integer('width'),
    height: integer('height'),
    altText: text('alt_text').notNull().default(''),
    variants: jsonb('variants').$type<KreizMediaVariant[]>().notNull().default([]),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'kreiz_media_status_check',
      sql`${table.status} in ('uploading', 'processing', 'ready', 'failed')`,
    ),
  ],
);

export type KreizMedia = typeof media.$inferSelect;
export type KreizMediaInsert = typeof media.$inferInsert;
