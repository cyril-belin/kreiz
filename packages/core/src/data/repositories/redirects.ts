import { eq, inArray, sql } from 'drizzle-orm';
import type { KreizDatabase } from '../connection.js';
import { redirects, type KreizRedirect, type KreizRedirectInsert } from '../tables/redirects.js';

/**
 * Repository du domaine redirections (slice 1 : écriture et lookup ; slice 4 :
 * opérations du plan d'écriture normalisé du moteur de publication).
 *
 * Frontière : les méthodes ci-dessous sont des **primitives mécaniques** —
 * la décision (quelle redirection créer, quelles lignes re-cibler,
 * prévention des boucles) appartient au domaine (`redirect-engine.ts`) et
 * au service de publication, jamais ici. Aucune logique métier de
 * normalisation dans le mapping.
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

    /** Toutes les lignes — planification de publication et matérialisation build. */
    listAll(options: { limit?: number } = {}): Promise<KreizRedirect[]> {
      return db.select().from(redirects).limit(options.limit ?? 10_000);
    },

    /**
     * Insère ou écrase la redirection d'une source (unicité `from_path`) :
     * une source réapparaissante est réécrite vers sa cible actuelle —
     * jamais de doublon ni de conflit brut 23505 exposé.
     */
    async upsert(values: {
      fromPath: string;
      toPath: string;
      contentEntryId: string | null;
    }): Promise<KreizRedirect> {
      const rows = await db
        .insert(redirects)
        .values(values)
        .onConflictDoUpdate({
          target: redirects.fromPath,
          set: { toPath: values.toPath, contentEntryId: values.contentEntryId },
        })
        .returning();
      const row = rows.at(0);
      if (!row) {
        throw new Error('@kreiz/core : redirects.upsert() n’a retourné aucune ligne.');
      }
      return row;
    },

    /**
     * Supprime les redirections **sources** données (le chemin redevient une
     * page vivante — « slug réapparu », cadrage §12). Idempotent.
     */
    async deleteByFromPaths(fromPaths: string[]): Promise<number> {
      if (fromPaths.length === 0) return 0;
      const rows = await db
        .delete(redirects)
        .where(inArray(redirects.fromPath, fromPaths))
        .returning({ id: redirects.id });
      return rows.length;
    },

    /**
     * Re-cible toutes les redirections pointant vers `fromPathTarget` vers
     * `newToPath` — normalisation des chaînes à l'écriture (mission §21 :
     * `/a → /b` puis `/b → /c` donne `/a → /c`). Retourne le nombre de
     * lignes re-ciblées.
     */
    async retargetTargets(fromPathTarget: string, newToPath: string): Promise<number> {
      const rows = await db
        .update(redirects)
        .set({ toPath: newToPath })
        .where(eq(redirects.toPath, fromPathTarget))
        .returning({ id: redirects.id });
      return rows.length;
    },

    /** Comptage (tests d'intégration et garde de nettoyage). */
    async count(): Promise<number> {
      const rows = await db.select({ n: sql<number>`count(*)::int` }).from(redirects);
      return rows.at(0)?.n ?? 0;
    },
  };
}

export type RedirectsRepository = ReturnType<typeof createRedirectsRepository>;
