import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { adminUsers } from './admin-users.js';

/**
 * Journal d'audit admin — intention applicative **append-only**.
 *
 * Aucun code applicatif n'update ni ne supprime ce journal ; le Core
 * n'expose volontairement aucun repository générique permettant de le faire.
 * `ON DELETE RESTRICT` sur l'acteur : supprimer un admin référencé par
 * l'audit est impossible, l'historique prime. Pas d'IP complète.
 *
 * `action` reste en texte libre (pas de CHECK) : les actions arrivent slice
 * après slice (auth, publication, médias, formulaires) et fermer le vocabulaire
 * en base imposerait une migration à chaque nouvelle action.
 * Le moteur d'audit appartient aux slices 4/5 — table seule ici.
 */
export const adminAuditLog = pgTable('kreiz_admin_audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorAdminId: uuid('actor_admin_id')
    .notNull()
    .references(() => adminUsers.id, { onDelete: 'restrict' }),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type KreizAdminAuditLog = typeof adminAuditLog.$inferSelect;
export type KreizAdminAuditLogInsert = typeof adminAuditLog.$inferInsert;
