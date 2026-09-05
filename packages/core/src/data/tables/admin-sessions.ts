import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { adminUsers } from './admin-users.js';

/**
 * Sessions admin en base, révocables. Seul le hash du token est stocké.
 *
 * `expires_at` est l'expiration glissante, `absolute_expires_at` la limite
 * absolue (défauts cadrage : 14 j / 90 j — fixés par le futur slice auth au
 * moment de la création). `revoked_at` porte la révocation unitaire ou
 * globale (« déconnecter partout »).
 *
 * `ON DELETE CASCADE` : une session est un artefact éphémère, sans valeur
 * sans son compte ; sa disparition n'emporte aucun historique éditorial.
 * La logique d'auth/session appartient au slice 2 — table seule ici.
 */
export const adminSessions = pgTable(
  'kreiz_admin_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adminId: uuid('admin_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('kreiz_admin_sessions_token_hash_key').on(table.tokenHash),
    index('kreiz_admin_sessions_admin_id_idx').on(table.adminId),
  ],
);

export type KreizAdminSession = typeof adminSessions.$inferSelect;
export type KreizAdminSessionInsert = typeof adminSessions.$inferInsert;
