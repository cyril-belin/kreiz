import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { adminUsers } from './admin-users.js';

/**
 * Journal d'audit admin — intention applicative **append-only**.
 *
 * Aucun code applicatif n'update ni ne supprime ce journal ; le Core
 * n'expose volontairement aucun repository générique permettant de le faire.
 * Pas d'IP complète.
 *
 * **Sémantique de `actor_admin_id` — invariant : l'acteur ne prétend jamais
 * identifier un admin qui n'a pas réellement réalisé l'action.**
 * - `NOT NULL`-like (renseigné) : action réalisée par un **admin
 *   authentifié via une session** (ex. `admin.login`, `admin.logout`).
 * - `NULL` : action **opérateur/système sans session admin** (ex.
 *   `admin.password_reset` via le CLI `kreiz`). La source réelle est alors
 *   portée par `metadata.source` (`"cli"`) — l'admin cible d'une action
 *   opérateur est désigné par `entity_id`, jamais par l'acteur.
 *
 * `ON DELETE RESTRICT` sur l'acteur : supprimer un admin référencé par
 * l'audit est impossible, l'historique prime (les lignes à acteur NULL ne
 * référencent personne). `action` reste en texte libre (pas de CHECK) : les
 * actions arrivent slice après slice (auth, publication, médias,
 * formulaires) et fermer le vocabulaire en base imposerait une migration à
 * chaque nouvelle action.
 */
export const adminAuditLog = pgTable('kreiz_admin_audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorAdminId: uuid('actor_admin_id')
    .references(() => adminUsers.id, { onDelete: 'restrict' }),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type KreizAdminAuditLog = typeof adminAuditLog.$inferSelect;
export type KreizAdminAuditLogInsert = typeof adminAuditLog.$inferInsert;
