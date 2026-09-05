import { and, eq, isNull, lt } from 'drizzle-orm';
import type { KreizDatabase } from '../connection.js';
import {
  adminSessions,
  type KreizAdminSession,
  type KreizAdminSessionInsert,
} from '../tables/admin-sessions.js';

/**
 * Repository du domaine sessions admin (slice 2). Seules les opérations
 * nécessaires au cycle de vie d'une session existent — pas de CRUD
 * générique. Le token brut n'est jamais persisté : `tokenHash` est le
 * SHA-256 du token (unicité en base), la correspondance se fait par ce
 * hash uniquement.
 */
export function createAdminSessionsRepository(db: KreizDatabase) {
  return {
    async create(values: KreizAdminSessionInsert): Promise<KreizAdminSession> {
      const rows = await db.insert(adminSessions).values(values).returning();
      const row = rows.at(0);
      if (!row) {
        throw new Error('@kreiz/core : adminSessions.create() n’a retourné aucune ligne.');
      }
      return row;
    },

    findByTokenHash(tokenHash: string): Promise<KreizAdminSession | null> {
      return db
        .select()
        .from(adminSessions)
        .where(eq(adminSessions.tokenHash, tokenHash))
        .limit(1)
        .then((rows) => rows.at(0) ?? null);
    },

    findById(id: string): Promise<KreizAdminSession | null> {
      return db
        .select()
        .from(adminSessions)
        .where(eq(adminSessions.id, id))
        .limit(1)
        .then((rows) => rows.at(0) ?? null);
    },

    /**
     * Rafraîchissement glissant (`last_seen_at`, `expires_at`) — valeurs
     * calculées par le domaine (`sessionTouch`), écrites telles quelles.
     */
    async touch(
      id: string,
      values: { lastSeenAt: Date; expiresAt: Date },
    ): Promise<KreizAdminSession | null> {
      const rows = await db
        .update(adminSessions)
        .set(values)
        .where(eq(adminSessions.id, id))
        .returning();
      return rows.at(0) ?? null;
    },

    /** Révocation unitaire — idempotente (une session déjà révoquée reste révoquée). */
    async revoke(id: string, revokedAt: Date): Promise<void> {
      await db
        .update(adminSessions)
        .set({ revokedAt })
        .where(and(eq(adminSessions.id, id), isNull(adminSessions.revokedAt)));
    },

    /** « Déconnecter partout » : révoque toutes les sessions actives d'un admin. */
    async revokeAllForAdmin(adminId: string, revokedAt: Date): Promise<number> {
      const rows = await db
        .update(adminSessions)
        .set({ revokedAt })
        .where(and(eq(adminSessions.adminId, adminId), isNull(adminSessions.revokedAt)))
        .returning({ id: adminSessions.id });
      return rows.length;
    },

    /**
     * Purge des sessions mortes (limite absolue dépassée) — appelable par
     * une maintenance future ; aucune planification automatique en V1.
     */
    async purgeExpired(before: Date): Promise<number> {
      const rows = await db
        .delete(adminSessions)
        .where(lt(adminSessions.absoluteExpiresAt, before))
        .returning({ id: adminSessions.id });
      return rows.length;
    },
  };
}

export type AdminSessionsRepository = ReturnType<typeof createAdminSessionsRepository>;
