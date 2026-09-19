import { eq, inArray, lt, sql } from 'drizzle-orm';
import type { KreizDatabase } from '../connection.js';
import { rateLimits, type KreizRateLimit } from '../tables/rate-limits.js';

/**
 * Repository des compteurs de rate limiting (slice 2 — login).
 *
 * L'incrémentation est un **upsert atomique concurrent-safe** : une seule
 * instruction, sûr sous concurrence serverless (pas de read-then-write),
 * sans Redis (cadrage §16). La fenêtre est réinitialisée dans la même
 * instruction quand elle a expiré — un compteur ne peut donc jamais
 * dépasser la fenêtre voulu par l'appelant.
 */
export function createRateLimitsRepository(db: KreizDatabase) {
  return {
    /**
     * Incrémente le compteur de `key`, en réinitialisant la fenêtre si la
     * précédente a expiré (`window_started_at` + `windowMs` < `now`).
     * Retourne le compteur et le début de fenêtre après l'incrément.
     */
    async incrementWindowed(
      key: string,
      options: { windowMs: number; now: Date },
    ): Promise<Pick<KreizRateLimit, 'key' | 'windowStartedAt' | 'count'>> {
      const cutoffIso = new Date(options.now.getTime() - options.windowMs).toISOString();
      const nowIso = options.now.toISOString();
      const rows = await db
        .insert(rateLimits)
        .values({ key, windowStartedAt: options.now, count: 1 })
        .onConflictDoUpdate({
          target: rateLimits.key,
          set: {
            count: sql`case when ${rateLimits.windowStartedAt} < ${cutoffIso}::timestamptz then 1 else ${rateLimits.count} + 1 end`,
            windowStartedAt: sql`case when ${rateLimits.windowStartedAt} < ${cutoffIso}::timestamptz then ${nowIso}::timestamptz else ${rateLimits.windowStartedAt} end`,
          },
        })
        .returning({
          key: rateLimits.key,
          windowStartedAt: rateLimits.windowStartedAt,
          count: rateLimits.count,
        });
      const row = rows.at(0);
      if (!row) {
        throw new Error('@kreiz/core : rateLimits.incrementWindowed() n’a retourné aucune ligne.');
      }
      return row;
    },

    get(key: string): Promise<KreizRateLimit | null> {
      return db
        .select()
        .from(rateLimits)
        .where(eq(rateLimits.key, key))
        .limit(1)
        .then((rows) => rows.at(0) ?? null);
    },

    /** Réinitialise (supprime) les compteurs donnés — ex. après un login réussi. */
    async reset(keys: string[]): Promise<void> {
      if (keys.length === 0) return;
      await db.delete(rateLimits).where(inArray(rateLimits.key, keys));
    },

    /**
     * Purge opportuniste des fenêtres échues (maintenance future ou appelant).
     * **Bornée par lot** (revue sécurité finale) : jamais un `DELETE …
     * RETURNING` non borné — la table est alimentée par des identités
     * pseudonymisées dont la cardinalité est contrôlée par le client (IP
     * forgée, rotation IPv6) ; un flot hostile ne doit pas transformer chaque
     * purge en transaction géante matérialisant chaque clé en mémoire Node.
     * Retourne le nombre total supprimé.
     */
    async purgeExpired(before: Date): Promise<number> {
      let total = 0;
      for (;;) {
        const candidates = await db
          .select({ key: rateLimits.key })
          .from(rateLimits)
          .where(lt(rateLimits.windowStartedAt, before))
          .limit(PURGE_BATCH);
        if (candidates.length === 0) return total;
        await db.delete(rateLimits).where(
          inArray(
            rateLimits.key,
            candidates.map((candidate) => candidate.key),
          ),
        );
        total += candidates.length;
        if (candidates.length < PURGE_BATCH) return total;
      }
    },
  };
}

/** Taille de lot des purges bornées. */
const PURGE_BATCH = 5_000;

export type RateLimitsRepository = ReturnType<typeof createRateLimitsRepository>;
