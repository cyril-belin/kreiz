import type { AdminAuditLogRepository } from '../data/repositories/admin-audit-log.js';
import type { MediaRepository } from '../data/repositories/media.js';
import type { BackgroundJobs } from '../ports/jobs.js';
import { MEDIA_AUDIT_ACTIONS } from './media-audit.js';

/**
 * Récupération des médias bloqués (mission §20, §23) — filet de sécurité
 * **explicite** : aucun scheduler n'est livré en V1, mais l'architecture
 * permet à un cron futur (adapter `BackgroundJobs` planifié, job Vercel
 * cron…) d'appeler ces deux méthodes telles quelles.
 *
 * - `retryFailedMedia` : repasse des `failed` en `processing` et
 *   ré-enfile. Borné (`limit`) : pas de rafale infinie — un fichier
 *   intrinsèquement invalide échouera de nouveau et attendra un humain.
 * - `processStuckMedia` : les `processing` dont `updated_at` est plus
 *   ancien qu'un seuil (job perdu : crash serveur, `waitUntil` coupé).
 *   Ré-enfile sans changer l'état (déjà `processing`) ; l'idempotence du
 *   service de traitement arbitre les courses.
 *
 * Acteur d'audit : `NULL` + `metadata.source: 'recovery'` — action
 * système, jamais attribuée à un admin (invariant slice 2, mission §44).
 */

export type MediaRecoveryServiceDeps = {
  media: MediaRepository;
  audit: AdminAuditLogRepository;
  jobs: BackgroundJobs;
};

export function createMediaRecoveryService(deps: MediaRecoveryServiceDeps) {
  const { media, audit, jobs } = deps;

  return {
    /** Reprend les médias `failed` (mission §20). Retourne le nombre repris. */
    async retryFailedMedia(
      options: { limit?: number; now?: Date } = {},
    ): Promise<{ recovered: number }> {
      const now = options.now ?? new Date();
      const failed = await media.listFailed(options.limit ?? 25);
      let recovered = 0;
      for (const row of failed) {
        const processingRow = await media.markProcessing(row.id, { updatedAt: now });
        if (!processingRow) continue; // déjà repris par un chemin concurrent
        await jobs.enqueueMediaProcessing(processingRow.id);
        await audit.append({
          actorAdminId: null,
          action: MEDIA_AUDIT_ACTIONS.retried,
          entityType: 'media',
          entityId: processingRow.id,
          metadata: { source: 'recovery' },
        });
        recovered += 1;
      }
      return { recovered };
    },

    /**
     * Ré-enfile les `processing` bloqués depuis plus que `olderThanMs`
     * (défaut : 1 h — largement au-delà d'une transformation normale,
     * largement sous un cycle de cron réaliste).
     */
    async processStuckMedia(
      options: { olderThanMs?: number; limit?: number; now?: Date } = {},
    ): Promise<{ recovered: number }> {
      const now = options.now ?? new Date();
      const cutoff = new Date(now.getTime() - (options.olderThanMs ?? 60 * 60 * 1000));
      const stuck = await media.findStuckProcessing(cutoff, options.limit ?? 25);
      let recovered = 0;
      for (const row of stuck) {
        // Pas de transition d'état : déjà `processing` — on ré-arme le job.
        await jobs.enqueueMediaProcessing(row.id);
        await audit.append({
          actorAdminId: null,
          action: MEDIA_AUDIT_ACTIONS.retried,
          entityType: 'media',
          entityId: row.id,
          metadata: { source: 'recovery', reason: 'stuck' },
        });
        recovered += 1;
      }
      return { recovered };
    },
  };
}

export type MediaRecoveryService = ReturnType<typeof createMediaRecoveryService>;
