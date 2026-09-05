import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Compteurs de rate limiting PostgreSQL (pas de Redis en V1, cadrage §16).
 * `key` encode le couple identité/fenêtre voulu par l'appelant (ex.
 * `login:email:…`), la future incrémentation sera un upsert atomique
 * concurrent-safe et la purge opportuniste balayera les fenêtres échues.
 *
 * Pas de timestamps au-delà de `window_started_at` : la ligne n'a pas
 * d'historique propre, c'est un compteur éphémère. Service de rate limiting :
 * slice 2 (login) — table seule ici.
 */
export const rateLimits = pgTable('kreiz_rate_limits', {
  key: text('key').primaryKey(),
  windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
  count: integer('count').notNull().default(0),
});

export type KreizRateLimit = typeof rateLimits.$inferSelect;
export type KreizRateLimitInsert = typeof rateLimits.$inferInsert;
