import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Comptes d'administration Kreiz.
 *
 * Un administrateur n'est jamais supprimé pour être désactivé : la colonne
 * `disabled_at` (futur flux disable → révocation des sessions → login interdit)
 * préserve les références historiques (`actor_admin_id`, `created_by`,
 * `updated_by`, `uploaded_by`). Les FK qui pointent vers cette table sont donc
 * `ON DELETE RESTRICT` : la suppression physique d'un compte référencé est
 * impossible tant que l'historique existe.
 */
export const adminUsers = pgTable(
  'kreiz_admin_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('kreiz_admin_users_email_key').on(table.email)],
);

export type KreizAdminUser = typeof adminUsers.$inferSelect;
export type KreizAdminUserInsert = typeof adminUsers.$inferInsert;
