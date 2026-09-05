import { eq } from 'drizzle-orm';
import type { KreizDatabase } from '../connection.js';
import { adminUsers, type KreizAdminUser, type KreizAdminUserInsert } from '../tables/admin-users.js';

/**
 * Repository du domaine admin users. Minimum du slice 1 : prouver écriture,
 * lecture et typage bout en bout. Login, désactivation, reset password :
 * slice 2.
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
  };
}

export type AdminUsersRepository = ReturnType<typeof createAdminUsersRepository>;
