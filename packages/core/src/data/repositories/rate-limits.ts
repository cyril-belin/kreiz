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

    /** Purge opportuniste des fenêtres échues (maintenance future ou appelant). */
    async purgeExpired(before: Date): Promise<number> {
      const rows = await db
        .delete(rateLimits)
        .where(lt(rateLimits.windowStartedAt, before))
        .returning({ key: rateLimits.key });
      return rows.length;
    },
  };
}

export type RateLimitsRepository = ReturnType<typeof createRateLimitsRepository>;
