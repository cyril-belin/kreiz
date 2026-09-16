import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { contentEntries } from './content-entries.js';

/**
 * Vocabulaire **fermé** des événements analytics (slice 8).
 *
 * - `page_view`, `cta_click` — collectés depuis le navigateur (beacon) ;
 * - `form_accepted`, `form_notification_sent` — émis **serveur** par le
 *   service contact (conversions) ; jamais acceptés depuis l'endpoint
 *   public. La cardinalité du vocabulaire est bornée par construction :
 *   ni un visiteur, ni un Project ne peut créer un nom d'événement libre.
 */
export const kreizClientAnalyticsEventNames = ['page_view', 'cta_click'] as const;
export const kreizServerAnalyticsEventNames = ['form_accepted', 'form_notification_sent'] as const;
export const kreizAnalyticsEventNames = [
  ...kreizClientAnalyticsEventNames,
  ...kreizServerAnalyticsEventNames,
] as const;
export type KreizAnalyticsEventName = (typeof kreizAnalyticsEventNames)[number];

export const kreizDeviceClasses = ['mobile', 'tablet', 'desktop'] as const;
export type KreizDeviceClass = (typeof kreizDeviceClasses)[number];

/**
 * Événements analytics (slice 8) — volume élevé par nature : lecture
 * agrégée par `(event_name, created_at)`, purge par rétention via
 * `created_at` (les deux index du cadrage), déduplication légère des
 * rechargements/doubles beacons via `dedup_key` (index unique **partiel**,
 * même arbitre concurrentiel que les demandes de contact).
 *
 * Vie privée (politique détaillée dans `domain/analytics/policy.ts`) :
 * **aucune IP, aucun User-Agent brut, aucune query string, aucune PII** —
 * `referrer` est réduit au domaine (NULL = accès direct), `session_id` est
 * un UUID **éphémère par onglet** (sessionStorage, sans cookie, sans lien
 * avec `kreiz_admin_sessions`, nullable : conversions serveur sans session
 * navigateur), `device_class` est une classe grossière dérivée à la volée,
 * `country` reste un enrichissement plateforme **non rempli en V1**.
 * Les seuls paramètres d'URL conservés sont les cinq UTM whitelistés.
 *
 * `ON DELETE SET NULL` sur le contenu : la télémétrie agrégée survit à une
 * purge du contenu (elle ne bloque jamais une purge, contrairement aux
 * références éditoriales en RESTRICT).
 */
export const analyticsEvents = pgTable(
  'kreiz_analytics_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventName: text('event_name').notNull(),
    /** Pathname seul — jamais l'URL complète (query stripping systématique). */
    path: text('path').notNull(),
    /** Domaine normalisé — NULL = accès direct ; `referrer_kind` le qualifie. */
    referrer: text('referrer'),
    referrerKind: text('referrer_kind'),
    sessionId: text('session_id'),
    contentType: text('content_type'),
    contentEntryId: uuid('content_entry_id').references(() => contentEntries.id, {
      onDelete: 'set null',
    }),
    deviceClass: text('device_class'),
    country: text('country'),
    locale: text('locale'),
    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    utmContent: text('utm_content'),
    utmTerm: text('utm_term'),
    /**
     * Propriétés bornées **construites serveur** (formulaire concerné, id de
     * CTA) — le client ne peut jamais y injecter de structure arbitraire.
     */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    /** Clé de déduplication serveur (session|événement|chemin|tranche 30 s). */
    dedupKey: text('dedup_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'kreiz_analytics_events_event_name_check',
      sql`${table.eventName} in ('page_view', 'cta_click', 'form_accepted', 'form_notification_sent')`,
    ),
    check(
      'kreiz_analytics_events_device_class_check',
      sql`${table.deviceClass} is null or ${table.deviceClass} in ('mobile', 'tablet', 'desktop')`,
    ),
    check(
      'kreiz_analytics_events_referrer_kind_check',
      sql`${table.referrerKind} is null or ${table.referrerKind} in ('internal', 'external')`,
    ),
    // Bornes de longueur en base — filet de sécurité derrière la validation
    // applicative : un défaut de validation ne peut pas transformer une
    // colonne en dépotoir (endpoint public par nature).
    check('kreiz_analytics_events_path_len_check', sql`char_length(${table.path}) <= 512`),
    check('kreiz_analytics_events_referrer_len_check', sql`char_length(${table.referrer}) <= 253`),
    check('kreiz_analytics_events_session_len_check', sql`char_length(${table.sessionId}) <= 64`),
    check('kreiz_analytics_events_locale_len_check', sql`char_length(${table.locale}) <= 35`),
    check(
      'kreiz_analytics_events_utm_len_check',
      sql`char_length(${table.utmSource}) <= 128 and char_length(${table.utmMedium}) <= 128
        and char_length(${table.utmCampaign}) <= 128 and char_length(${table.utmContent}) <= 128
        and char_length(${table.utmTerm}) <= 128`,
    ),
    check('kreiz_analytics_events_dedup_key_len_check', sql`char_length(${table.dedupKey}) <= 700`),
    // Déduplication : un seul événement par (session, nom, chemin, tranche).
    uniqueIndex('kreiz_analytics_events_dedup_key_unique')
      .on(table.dedupKey)
      .where(sql`dedup_key is not null`),
    index('kreiz_analytics_events_name_created_at_idx').on(table.eventName, table.createdAt),
    index('kreiz_analytics_events_created_at_idx').on(table.createdAt),
  ],
);

export type KreizAnalyticsEvent = typeof analyticsEvents.$inferSelect;
export type KreizAnalyticsEventInsert = typeof analyticsEvents.$inferInsert;
