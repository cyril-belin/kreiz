import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { contentEntries } from './content-entries.js';

/**
 * Redirections permanentes (normalisées à l'écriture par le futur slice 4 —
 * résolveur et moteur de publication). Le repository ne normalise pas : la
 * normalisation est une règle du domaine, pas du mapping.
 *
 * `from_path` unique : un chemin source ne peut mener qu'à une seule cible.
 * `ON DELETE SET NULL` sur le contenu d'origine : la redirection est de
 * l'historique de navigation qui doit survivre à une purge physique du
 * contenu ; la ligne reste valide (`to_path` est une chaîne autonome),
 * seule la provenance est perdue.
 */
export const redirects = pgTable(
  'kreiz_redirects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromPath: text('from_path').notNull(),
    toPath: text('to_path').notNull(),
    contentEntryId: uuid('content_entry_id').references(() => contentEntries.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('kreiz_redirects_from_path_key').on(table.fromPath)],
);

export type KreizRedirect = typeof redirects.$inferSelect;
export type KreizRedirectInsert = typeof redirects.$inferInsert;
