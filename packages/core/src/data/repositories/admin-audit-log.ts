import type { KreizDatabase } from '../connection.js';
import { adminAuditLog, type KreizAdminAuditLog } from '../tables/admin-audit-log.js';

/**
 * Repository du journal d'audit — **append-only** (cadrage §7, §16).
 *
 * La seule opération exposée est l'insertion. Il n'existe volontairement
 * aucune méthode `update` ni `delete` : le journal est une piste d'audit,
 * sa modification ou sa suppression ne peut pas passer par le code
 * applicatif. La garde anti-régression des tests vérifie cette surface.
 * Pas d'IP complète dans `metadata`.
 */
export function createAdminAuditLogRepository(db: KreizDatabase) {
  return {
    async append(event: {
      /** Admin authentifié ayant réalisé l'action — `null` pour une action opérateur/système (ex. CLI). */
      actorAdminId: string | null;
      action: string;
      entityType: string;
      entityId: string;
      metadata?: Record<string, unknown>;
    }): Promise<KreizAdminAuditLog> {
      const rows = await db
        .insert(adminAuditLog)
        .values({
          actorAdminId: event.actorAdminId,
          action: event.action,
          entityType: event.entityType,
          entityId: event.entityId,
          metadata: event.metadata ?? {},
        })
        .returning();
      const row = rows.at(0);
      if (!row) {
        throw new Error('@kreiz/core : audit.append() n’a retourné aucune ligne.');
      }
      return row;
    },
  };
}

export type AdminAuditLogRepository = ReturnType<typeof createAdminAuditLogRepository>;
