import { eq } from 'drizzle-orm';
import type { KreizDatabase } from '../connection.js';
import { adminUsers, type KreizAdminUser, type KreizAdminUserInsert } from '../tables/admin-users.js';

/**
 * Repository du domaine admin users. Slice 1 : écriture/lecture typée.
 * Slice 2 : ajoute uniquement ce dont l'auth a besoin — mise à jour du
 * hash (reset password via CLI) et désactivation (`disabled_at`, jamais
 * de suppression physique : les FK RESTRICT de l'audit et des contenus
 * l'interdisent de toute façon).
 */
export function createAdminUsersRepository(db: KreizDatabase) {
  return {
    async create(values: KreizAdminUserInsert): Promise<KreizAdminUser> {
      const rows = await db.insert(adminUsers).values(values).returning();
      const row = rows.at(0);
      if (!row) {
        throw new Error('@kreiz/core : adminUsers.create() n’a retourné aucune ligne.');
      }
      return row;
    },

    findById(id: string): Promise<KreizAdminUser | null> {
      return db
        .select()
        .from(adminUsers)
        .where(eq(adminUsers.id, id))
        .limit(1)
        .then((rows) => rows.at(0) ?? null);
    },

    findByEmail(email: string): Promise<KreizAdminUser | null> {
      return db
        .select()
        .from(adminUsers)
        .where(eq(adminUsers.email, email))
        .limit(1)
        .then((rows) => rows.at(0) ?? null);
    },

    /**
     * Remplace le hash de mot de passe (reset via CLI). Le hash complet
     * (chaîne PHC argon2id) est stocké tel quel — jamais le mot de passe
     * brut.
     */
    async updatePasswordHash(
      id: string,
      passwordHash: string,
      updatedAt: Date,
    ): Promise<KreizAdminUser | null> {
      const rows = await db
        .update(adminUsers)
        .set({ passwordHash, updatedAt })
        .where(eq(adminUsers.id, id))
        .returning();
      return rows.at(0) ?? null;
    },

    /** Désactivation réversible : bloque login et sessions existantes. */
    async disable(id: string, disabledAt: Date): Promise<KreizAdminUser | null> {
      const rows = await db
        .update(adminUsers)
        .set({ disabledAt, updatedAt: disabledAt })
        .where(eq(adminUsers.id, id))
        .returning();
      return rows.at(0) ?? null;
    },
  };
}

export type AdminUsersRepository = ReturnType<typeof createAdminUsersRepository>;
