import { eq } from 'drizzle-orm';
import type { KreizDatabase } from '../connection.js';
import { redirects, type KreizRedirect, type KreizRedirectInsert } from '../tables/redirects.js';

/**
 * Repository du domaine redirections. Minimum du slice 1 : écriture et
 * lookup par chemin source. Normalisation des chaînes, résolution des
 * boucles, matérialisation au build : slice 4.
 */
export function createRedirectsRepository(db: KreizDatabase) {
  return {
    async create(values: KreizRedirectInsert): Promise<KreizRedirect> {
      const rows = await db.insert(redirects).values(values).returning();
      const row = rows.at(0);
      if (!row) {
        throw new Error('@kreiz/core : redirects.create() n’a retourné aucune ligne.');
      }
      return row;
    },

    findByFromPath(fromPath: string): Promise<KreizRedirect | null> {
      return db
        .select()
        .from(redirects)
        .where(eq(redirects.fromPath, fromPath))
        .limit(1)
        .then((rows) => rows.at(0) ?? null);
    },
  };
}

export type RedirectsRepository = ReturnType<typeof createRedirectsRepository>;
