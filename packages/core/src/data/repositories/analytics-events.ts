import { and, eq, gte, sql } from 'drizzle-orm';
import type { KreizDatabase } from '../connection.js';
import { analyticsEvents, type KreizAnalyticsEventInsert } from '../tables/analytics-events.js';
import { contentEntries } from '../tables/content-entries.js';

/**
 * Repository des événements analytics (slice 8) — seule frontière Drizzle
 * du domaine. Deux contraintes structurelles :
 *
 * - **insertion ignorante des doublons** : `ON CONFLICT DO NOTHING` sur
 *   l'index unique partiel `dedup_key` — deux beacons simultanés (double
 *   envoi, retry réseau) ne créent qu'une ligne, sans course ni verrou ;
 * - **agrégations en SQL uniquement** : le dashboard ne charge jamais les
 *   événements en mémoire — buckets journaliers, tops et compteurs sont
 *   des `GROUP BY` bornés servis par les index `(event_name, created_at)`
 *   et `(created_at)` du cadrage.
 */
export function createAnalyticsEventsRepository(db: KreizDatabase) {
  return {
    /**
     * Insère un événement ; si `dedupKey` existe déjà (même session, même
     * événement, même tranche de 30 s), ne modifie rien. Retourne `false`
     * en cas de doublon — jamais d'erreur.
     */
    async insertOrIgnore(row: KreizAnalyticsEventInsert): Promise<boolean> {
      const inserted = await db.insert(analyticsEvents).values(row).onConflictDoNothing().returning({
        id: analyticsEvents.id,
      });
      return inserted.length > 0;
    },

    /**
     * Contenu publié correspondant à un chemin (`/articles/foo` → namespace
     * + slug) — requête indexée unique, appelée au plus une fois par page
     * vue. `null` : pas de contenu publié à ce chemin (accueil, page
     * statique du Project, 404…).
     */
    async findPublishedContentByPath(
      namespace: string,
      slug: string,
    ): Promise<{ contentEntryId: string; contentType: string } | null> {
      const rows = await db
        .select({ id: contentEntries.id, contentType: contentEntries.contentType })
        .from(contentEntries)
        .where(
          and(
            eq(contentEntries.routeNamespace, namespace),
            eq(contentEntries.slug, slug),
            eq(contentEntries.status, 'published'),
            sql`${contentEntries.deletedAt} is null`,
          ),
        )
        .limit(1);
      const row = rows.at(0);
      return row ? { contentEntryId: row.id, contentType: row.contentType } : null;
    },

    /** Purge par rétention — les événements plus vieux que `before` sont supprimés. */
    async purgeOlderThan(before: Date): Promise<number> {
      const deleted = await db
        .delete(analyticsEvents)
        .where(sql`${analyticsEvents.createdAt} < ${before.toISOString()}::timestamptz`)
        .returning({ id: analyticsEvents.id });
      return deleted.length;
    },

    /**
     * Séries journalières — une seule requête pour pageviews, sessions et
     * conversions (`FILTER` évite trois allers-retours Neon). Bucket
     * journalier **explicitement UTC** (`timezone('UTC', …)`) : indépendant
     * du fuseau de la session PostgreSQL, jour retourné en texte `YYYY-MM-DD`
     * (aucune re-parse ambiguë côté Node).
     */
    dailySeries(options: { since: Date }) {
      return db
        .select({
          day: sql<string>`timezone('UTC', ${analyticsEvents.createdAt})::date::text`,
          pageviews: sql<number>`count(*) filter (where ${analyticsEvents.eventName} = 'page_view')::int`,
          sessions: sql<number>`count(distinct ${analyticsEvents.sessionId}) filter (where ${analyticsEvents.eventName} = 'page_view')::int`,
          conversions: sql<number>`count(*) filter (where ${analyticsEvents.eventName} = 'form_accepted')::int`,
        })
        .from(analyticsEvents)
        .where(gte(analyticsEvents.createdAt, options.since))
        .groupBy(sql`1`)
        .orderBy(sql`1`);
    },

    /** Totaux de période — compteur simple + sessions distinctes. */
    async totals(options: { since: Date }): Promise<{
      pageviews: number;
      sessions: number;
      ctaClicks: number;
      conversions: number;
    }> {
      const rows = await db
        .select({
          pageviews: sql<number>`count(*) filter (where ${analyticsEvents.eventName} = 'page_view')::int`,
          sessions: sql<number>`count(distinct ${analyticsEvents.sessionId}) filter (where ${analyticsEvents.eventName} = 'page_view')::int`,
          ctaClicks: sql<number>`count(*) filter (where ${analyticsEvents.eventName} = 'cta_click')::int`,
          conversions: sql<number>`count(*) filter (where ${analyticsEvents.eventName} = 'form_accepted')::int`,
        })
        .from(analyticsEvents)
        .where(gte(analyticsEvents.createdAt, options.since));
      const row = rows.at(0);
      return {
        pageviews: row?.pageviews ?? 0,
        sessions: row?.sessions ?? 0,
        ctaClicks: row?.ctaClicks ?? 0,
        conversions: row?.conversions ?? 0,
      };
    },

    /** Top pages vues — borné (10). */
    topPages(options: { since: Date; limit?: number }) {
      return db
        .select({
          path: analyticsEvents.path,
          views: sql<number>`count(*)::int`,
        })
        .from(analyticsEvents)
        .where(
          and(eq(analyticsEvents.eventName, 'page_view'), gte(analyticsEvents.createdAt, options.since)),
        )
        .groupBy(analyticsEvents.path)
        .orderBy(sql`2 desc`)
        .limit(options.limit ?? 10);
    },

    /** Top sources externes — domaine normalisé, direct jamais listé. */
    topReferrers(options: { since: Date; limit?: number }) {
      return db
        .select({
          domain: analyticsEvents.referrer,
          views: sql<number>`count(*)::int`,
        })
        .from(analyticsEvents)
        .where(
          and(
            eq(analyticsEvents.eventName, 'page_view'),
            eq(analyticsEvents.referrerKind, 'external'),
            gte(analyticsEvents.createdAt, options.since),
          ),
        )
        .groupBy(analyticsEvents.referrer)
        .orderBy(sql`2 desc`)
        .limit(options.limit ?? 10);
    },

    /** Top campagnes — (source, medium, campaign) groupés, borné. */
    topCampaigns(options: { since: Date; limit?: number }) {
      return db
        .select({
          source: analyticsEvents.utmSource,
          medium: analyticsEvents.utmMedium,
          campaign: analyticsEvents.utmCampaign,
          views: sql<number>`count(*)::int`,
        })
        .from(analyticsEvents)
        .where(
          and(
            eq(analyticsEvents.eventName, 'page_view'),
            sql`${analyticsEvents.utmCampaign} is not null`,
            gte(analyticsEvents.createdAt, options.since),
          ),
        )
        .groupBy(analyticsEvents.utmSource, analyticsEvents.utmMedium, analyticsEvents.utmCampaign)
        .orderBy(sql`4 desc`)
        .limit(options.limit ?? 10);
    },

    /** Conversions par formulaire — propriété serveur `metadata.form`. */
    formConversions(options: { since: Date; limit?: number }) {
      return db
        .select({
          form: sql<string>`${analyticsEvents.metadata} ->> 'form'`,
          accepted: sql<number>`count(*)::int`,
        })
        .from(analyticsEvents)
        .where(
          and(
            eq(analyticsEvents.eventName, 'form_accepted'),
            gte(analyticsEvents.createdAt, options.since),
          ),
        )
        .groupBy(sql`${analyticsEvents.metadata} ->> 'form'`)
        .orderBy(sql`2 desc`)
        .limit(options.limit ?? 10);
    },
  };
}

export type AnalyticsEventsRepository = ReturnType<typeof createAnalyticsEventsRepository>;
