import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  contactNotificationStatuses,
  type ContactNotificationStatus,
} from '../../domain/forms/policy.js';

export const kreizContactRequestStatuses = ['new', 'handled'] as const;
export type KreizContactRequestStatus = (typeof kreizContactRequestStatuses)[number];

/**
 * Échec de notification persisté — **bounded** par construction : un `kind`
 * et éventuellement un statut HTTP, jamais la réponse brute du transport,
 * jamais de donnée visiteur (même discipline que les échecs de rebuild).
 */
export type KreizContactNotificationFailure =
  | { kind: 'unreachable' }
  | { kind: 'rejected'; statusCode: number };

/**
 * Demandes de contact. `payload` est validé par le schéma Zod du formulaire
 * déclaré en code (cadrage §13), pas au niveau SQL. Pas d'IP complète,
 * pas d'User-Agent brut.
 *
 * Slice 7 :
 * - `dedup_key` — clé d'idempotence calculée **serveur** (HMAC du contenu
 *   validé + hash d'IP + fenêtre temporelle) ; index unique partiel : une
 *   double soumission concurrente ne crée jamais deux lignes ;
 * - notification (`notification_status`…) : l'envoi peut être non configuré
 *   (`not_configured`), en attente (`pending`), envoyé (`sent`) ou en échec
 *   (`failed`, relançable par balayage ou par l'admin). La demande est
 *   **toujours** persistée avant toute tentative d'envoi : une panne email
 *   ne perd jamais une soumission.
 */
export const contactRequests = pgTable(
  'kreiz_contact_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    formId: text('form_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').$type<KreizContactRequestStatus>().notNull().default('new'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    notificationStatus: text('notification_status')
      .$type<ContactNotificationStatus>()
      .notNull()
      .default('not_configured'),
    notificationAttempts: integer('notification_attempts').notNull().default(0),
    notificationFailure: jsonb('notification_failure').$type<KreizContactNotificationFailure | null>(),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    notificationNextAttemptAt: timestamp('notification_next_attempt_at', { withTimezone: true }),
    /**
     * **Bail de claim** (revue sécurité finale) : horodatage de la dernière
     * réservation d'envoi. Non nul = une tentative est **en vol** — ni
     * ré-armable (double-clic admin) ni re-claimable (balayage concurrent)
     * tant que le bail (`CONTACT_NOTIFICATION_CLAIM_LEASE_MS`) court.
     * Distinct de `notification_next_attempt_at`, qui porte le **backoff**
     * d'échec (une relance admin explicite passe outre le backoff, jamais
     * outre un envoi en vol). Nettoyé à la résolution (sent/failed).
     */
    notificationClaimedAt: timestamp('notification_claimed_at', { withTimezone: true }),
    dedupKey: text('dedup_key'),
  },
  (table) => [
    check(
      'kreiz_contact_requests_status_check',
      sql`${table.status} in ('new', 'handled')`,
    ),
    check(
      'kreiz_contact_requests_notification_status_check',
      sql`${table.notificationStatus} in ('not_configured', 'pending', 'sent', 'failed')`,
    ),
    // Idempotence : une seule demande par clé de déduplication (partielle :
    // les lignes héritées pré-slice 7, sans clé, restent valides).
    uniqueIndex('kreiz_contact_requests_dedup_key_unique')
      .on(table.dedupKey)
      .where(sql`dedup_key is not null`),
    // File d'attente du balayage de rattrapage (cron futur) — notifications dues.
    index('kreiz_contact_requests_notification_due_idx')
      .on(table.notificationNextAttemptAt)
      .where(sql`notification_status in ('pending', 'failed') and notification_next_attempt_at is not null`),
    // Tri de la boîte admin (plus récentes d'abord) par formulaire.
    index('kreiz_contact_requests_form_created_idx').on(table.formId, table.createdAt),
  ],
);

export type KreizContactRequest = typeof contactRequests.$inferSelect;
export type KreizContactRequestInsert = typeof contactRequests.$inferInsert;
export { contactNotificationStatuses };
export type { ContactNotificationStatus };
