import { and, count, desc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import type { KreizDatabase } from '../connection.js';
import {
  contactRequests,
  type KreizContactNotificationFailure,
  type KreizContactRequest,
  type KreizContactRequestStatus,
} from '../tables/contact-requests.js';

/**
 * Repository des demandes de contact (slice 7) — seule frontière Drizzle du
 * domaine.
 *
 * Deux opérations sont **concurrence-sûres par construction** :
 * - `insertOrFindDuplicate` : `ON CONFLICT DO NOTHING` + relecture — deux
 *   POST simultanés de même contenu ne créent qu'une ligne (l'index unique
 *   partiel arbitre), le perdant reçoit la ligne gagnante (idempotence) ;
 * - `claimNotificationAttempt` : incrément **conditionnel** du compteur
 *   d'attempts — deux chemins concurrents (balayage + relance admin, deux
 *   instances serverless) ne peuvent pas envoyer deux fois la même
 *   notification : un seul claim gagne.
 */
export function createContactRequestsRepository(db: KreizDatabase) {
  return {
    /**
     * Insère une demande ; si `dedupKey` existe déjà (soumission en double,
     * même fenêtre), ne modifie rien et retourne la ligne existante.
     */
    async insertOrFindDuplicate(row: {
      formId: string;
      payload: Record<string, unknown>;
      notificationStatus: KreizContactRequest['notificationStatus'];
      notificationNextAttemptAt: Date | null;
      dedupKey: string | null;
      createdAt?: Date;
    }): Promise<{ request: KreizContactRequest; duplicate: boolean }> {
      const inserted = await db
        .insert(contactRequests)
        .values({
          formId: row.formId,
          payload: row.payload,
          notificationStatus: row.notificationStatus,
          notificationNextAttemptAt: row.notificationNextAttemptAt,
          dedupKey: row.dedupKey,
          ...(row.createdAt ? { createdAt: row.createdAt } : {}),
        })
        .onConflictDoNothing()
        .returning();
      const created = inserted.at(0);
      if (created) return { request: created, duplicate: false };
      // Conflit de déduplication : relecture de la ligne gagnante.
      if (!row.dedupKey) {
        throw new Error('@kreiz/core : contactRequests.insert conflit sans dedupKey.');
      }
      const existing = await db
        .select()
        .from(contactRequests)
        .where(eq(contactRequests.dedupKey, row.dedupKey))
        .limit(1);
      const found = existing.at(0);
      if (!found) {
        throw new Error('@kreiz/core : contactRequests.insert conflit de déduplication illisible.');
      }
      return { request: found, duplicate: true };
    },

    findById(id: string): Promise<KreizContactRequest | null> {
      return db
        .select()
        .from(contactRequests)
        .where(eq(contactRequests.id, id))
        .limit(1)
        .then((rows) => rows.at(0) ?? null);
    },

    /** Boîte admin — plus récentes d'abord, bornée (pas de pagination en V1). */
    list(options: { limit?: number; formId?: string; status?: KreizContactRequestStatus } = {}): Promise<KreizContactRequest[]> {
      const conditions = [
        options.formId ? eq(contactRequests.formId, options.formId) : undefined,
        options.status ? eq(contactRequests.status, options.status) : undefined,
      ].filter((condition) => condition !== undefined);
      return db
        .select()
        .from(contactRequests)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(contactRequests.createdAt))
        .limit(options.limit ?? 200);
    },

    async countNew(): Promise<number> {
      const rows = await db
        .select({ value: count() })
        .from(contactRequests)
        .where(eq(contactRequests.status, 'new'));
      return rows.at(0)?.value ?? 0;
    },

    /** Transition d'état éditorial (`new` ⇄ `handled`) — retourne la ligne à jour. */
    async updateStatus(id: string, status: KreizContactRequestStatus): Promise<KreizContactRequest | null> {
      const rows = await db
        .update(contactRequests)
        .set({ status })
        .where(eq(contactRequests.id, id))
        .returning();
      return rows.at(0) ?? null;
    },

    /**
     * Réserve une tentative d'envoi : incrément conditionnel — réussi une
     * seule fois par valeur attendue du compteur. Retourne `null` si la
     * ligne a changé entre-temps (claim concurrent, notification déjà
     * envoyée) : l'appelant renonce sans double envoi.
     */
    async claimNotificationAttempt(
      id: string,
      options: { expectedAttempts: number },
    ): Promise<KreizContactRequest | null> {
      const rows = await db
        .update(contactRequests)
        .set({
          notificationAttempts: options.expectedAttempts + 1,
          notificationStatus: sql`case when ${contactRequests.notificationStatus} = 'not_configured' then 'pending' else ${contactRequests.notificationStatus} end`,
          notificationFailure: null,
        })
        .where(
          and(
            eq(contactRequests.id, id),
            eq(contactRequests.notificationAttempts, options.expectedAttempts),
            inArray(contactRequests.notificationStatus, ['pending', 'failed', 'not_configured']),
          ),
        )
        .returning();
      return rows.at(0) ?? null;
    },

    async markNotified(id: string, options: { notifiedAt: Date }): Promise<KreizContactRequest | null> {
      const rows = await db
        .update(contactRequests)
        .set({
          notificationStatus: 'sent',
          notifiedAt: options.notifiedAt,
          notificationNextAttemptAt: null,
          notificationFailure: null,
        })
        .where(eq(contactRequests.id, id))
        .returning();
      return rows.at(0) ?? null;
    },

    async markNotificationFailed(
      id: string,
      options: { failure: KreizContactNotificationFailure; nextAttemptAt: Date | null },
    ): Promise<KreizContactRequest | null> {
      const rows = await db
        .update(contactRequests)
        .set({
          notificationStatus: 'failed',
          notificationFailure: options.failure,
          notificationNextAttemptAt: options.nextAttemptAt,
        })
        // Conditionnel : une tentative en vol qui échoue APRÈS une relance
        // concurrente déjà réussie ne doit jamais écraser un `sent`.
        .where(and(eq(contactRequests.id, id), sql`${contactRequests.notificationStatus} <> 'sent'`))
        .returning();
      return rows.at(0) ?? null;
    },

    /**
     * Relance admin : compteur remis à zéro et tentative immédiate. Le
     * `WHERE notification_status <> 'sent'` interdit de repartir après un
     * succès (pas d'envoi en double par un clic rapproché).
     */
    async rearmNotification(id: string, options: { now?: Date } = {}): Promise<KreizContactRequest | null> {
      const rows = await db
        .update(contactRequests)
        .set({
          notificationAttempts: 0,
          // `now` injectable : le service peut contrôler l'horloge (tests,
          // balayage) — jamais d'échéance dépendant du seul mur.
          notificationNextAttemptAt: options.now ?? new Date(),
          notificationStatus: sql`case when ${contactRequests.notificationStatus} = 'not_configured' then 'pending' else ${contactRequests.notificationStatus} end`,
        })
        .where(and(eq(contactRequests.id, id), sql`${contactRequests.notificationStatus} <> 'sent'`))
        .returning();
      return rows.at(0) ?? null;
    },

    /** File du balayage : notifications dues, plafond d'attempts non atteint. */
    listNotificationDue(options: { now: Date; limit?: number; maxAttempts: number }): Promise<KreizContactRequest[]> {
      return db
        .select()
        .from(contactRequests)
        .where(
          and(
            inArray(contactRequests.notificationStatus, ['pending', 'failed']),
            isNotNull(contactRequests.notificationNextAttemptAt),
            lte(contactRequests.notificationNextAttemptAt, options.now),
            sql`${contactRequests.notificationAttempts} < ${options.maxAttempts}`,
          ),
        )
        .orderBy(contactRequests.notificationNextAttemptAt)
        .limit(options.limit ?? 25);
    },

    /**
     * Promotion des demandes héritées du temps « sans mailer » : quand un
     * transport devient disponible, `not_configured` redevient `pending`
     * (rattrapage explicite, borné) — aucune notification n'est perdue par
     * une configuration tardive.
     */
    async promoteNotConfigured(options: { limit?: number; now?: Date } = {}): Promise<number> {
      // Sélection bornée puis mise à jour ciblée : les UPDATE Drizzle/Neon
      // n'ont pas de LIMIT — l'arbitrage des courses reste l'index unique
      // d'idempotence et le claim conditionnel.
      const candidates = await db
        .select({ id: contactRequests.id })
        .from(contactRequests)
        .where(eq(contactRequests.notificationStatus, 'not_configured'))
        .orderBy(contactRequests.createdAt)
        .limit(options.limit ?? 50);
      if (candidates.length === 0) return 0;
      const rows = await db
        .update(contactRequests)
        .set({ notificationStatus: 'pending', notificationNextAttemptAt: options.now ?? new Date() })
        .where(
          and(
            inArray(
              contactRequests.id,
              candidates.map((candidate) => candidate.id),
            ),
            eq(contactRequests.notificationStatus, 'not_configured'),
          ),
        )
        .returning({ id: contactRequests.id });
      return rows.length;
    },
  };
}

export type ContactRequestsRepository = ReturnType<typeof createContactRequestsRepository>;
