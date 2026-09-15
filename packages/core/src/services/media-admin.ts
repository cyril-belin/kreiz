import type { AdminAuditLogRepository } from '../data/repositories/admin-audit-log.js';
import type { MediaRepository } from '../data/repositories/media.js';
import type { KreizMedia } from '../data/tables/media.js';
import { mediaObjectKeys } from '../domain/media/keys.js';
import { MEDIA_ALT_MAX_LENGTH } from '../domain/media/policy.js';
import {
  MediaInUseError,
  MediaNotFoundError,
  MediaStateError,
} from '../domain/media/errors.js';
import type { BackgroundJobs } from '../ports/jobs.js';
import type { ObjectStorage } from '../ports/storage.js';
import { MEDIA_AUDIT_ACTIONS } from './media-audit.js';

/**
 * Service **admin** média (mission §16, §22, §26) — mutations pilotées par
 * un admin authentifié (acteur réel de chaque événement d'audit) :
 * alt text, retry d'un média `failed`, suppression.
 *
 * - **Retry** (mission §22) : `failed → processing` + enqueue. Pas de retry
 *   automatique infini — chaque retry est une action explicite, audité.
 * - **Alt text** (mission §16) : saisi par l'admin, jamais généré ; vide
 *   autorisé (image décorative).
 * - **Suppression** (mission §26/§46) : un média utilisé comme couverture
 *   — même par un contenu **soft-deleted** — est refusé avec message
 *   explicite (`MediaInUseError`) ; un média non référencé est supprimé
 *   physiquement (ligne + objets storage, original et variantes).
 */

export type MediaAdminServiceDeps = {
  media: MediaRepository;
  audit: AdminAuditLogRepository;
  storage: ObjectStorage;
};

export function createMediaAdminService(deps: MediaAdminServiceDeps) {
  const { media, audit, storage } = deps;

  return {
    /** Listing admin (tous statuts actifs) — page /admin/media. */
    listForAdmin(limit = 200): Promise<KreizMedia[]> {
      return media.listAdmin(limit);
    },

    /** Médias `ready` — pickers et sélection de couverture. */
    listReady(limit = 200): Promise<KreizMedia[]> {
      return media.listReady(limit);
    },

    async findById(mediaId: string): Promise<KreizMedia | null> {
      return media.findById(mediaId);
    },

    /** Statut exposé au polling client (mission §35) — shape minimale. */
    async statusOf(mediaId: string): Promise<{
      id: string;
      status: KreizMedia['status'];
      failureReason: string | null;
      variantCount: number;
    } | null> {
      const found = await media.findById(mediaId);
      if (!found) return null;
      return {
        id: found.id,
        status: found.status,
        failureReason: found.failureReason,
        variantCount: found.variants.length,
      };
    },

    /**
     * Retry d'un média `failed` (mission §22) : `failed → processing`
     * (transition gardée) + enqueue. Audit `media.retried` avec le vrai
     * acteur. Le port jobs est lié par exécution (waitUntil est par requête).
     */
    async retryMedia(
      input: { mediaId: string; actorAdminId: string },
      options: { now?: Date; jobs: BackgroundJobs },
    ): Promise<KreizMedia> {
      const now = options.now ?? new Date();
      const { jobs } = options;
      const found = await media.findById(input.mediaId);
      if (!found) throw new MediaNotFoundError(input.mediaId);
      if (found.status !== 'failed') {
        throw new MediaStateError(found.id, found.status, 'retry');
      }
      const processing = await media.markProcessing(found.id, { updatedAt: now });
      if (!processing) {
        // Course : un autre retry (ou une récupération) a déjà gagné —
        // le média est déjà `processing`, l'état demandé est atteint.
        const raced = await media.findById(found.id);
        if (raced?.status === 'processing') return raced;
        throw new MediaStateError(found.id, raced?.status ?? 'unknown', 'retry');
      }
      await jobs.enqueueMediaProcessing(processing.id);
      await audit.append({
        actorAdminId: input.actorAdminId,
        action: MEDIA_AUDIT_ACTIONS.retried,
        entityType: 'media',
        entityId: processing.id,
        metadata: { source: 'admin' },
      });
      return processing;
    },

    /** Met à jour l'alt text (mission §16) — borné, audité, acteur réel. */
    async updateAlt(
      input: { mediaId: string; altText: string; actorAdminId: string },
      options: { now?: Date } = {},
    ): Promise<KreizMedia> {
      const now = options.now ?? new Date();
      const altText = input.altText.trim().slice(0, MEDIA_ALT_MAX_LENGTH);
      const found = await media.findById(input.mediaId);
      if (!found) throw new MediaNotFoundError(input.mediaId);
      const updated = await media.updateAlt(input.mediaId, { altText, updatedAt: now });
      if (!updated) throw new MediaNotFoundError(input.mediaId);
      await audit.append({
        actorAdminId: input.actorAdminId,
        action: MEDIA_AUDIT_ACTIONS.altUpdated,
        entityType: 'media',
        entityId: updated.id,
        metadata: {},
      });
      return updated;
    },

    /**
     * Suppression (mission §26/§46) : référencé (même par un contenu
     * soft-deleted) → `MediaInUseError` avant toute écriture ; non
     * référencé → suppression DB puis objets storage (original +
     * variantes). L'ordre DB → storage privilégie l'absence de référence
     * résiduelle : un objet orphelin est invisible et purgeable, un row
     * pointant vers du stockage supprimé ne l'est pas.
     */
    async deleteMedia(
      input: { mediaId: string; actorAdminId: string },
    ): Promise<{ deleted: true; mediaId: string }> {
      const found = await media.findById(input.mediaId);
      if (!found) throw new MediaNotFoundError(input.mediaId);

      const references = await media.countCoverReferences(found.id);
      if (references > 0) {
        throw new MediaInUseError(found.id, references);
      }

      const keys = mediaObjectKeys(
        found.id,
        found.variants.map((variant) => variant.key),
      );
      const deleted = await media.deletePhysical(found.id);
      if (!deleted) throw new MediaNotFoundError(input.mediaId);

      await storage.deleteMany(keys).catch(() => {
        // Best effort : la ligne est partie, l'audit existe ; un objet
        // résiduel est orphelin et sans référence (récupération future).
      });
      await audit.append({
        actorAdminId: input.actorAdminId,
        action: MEDIA_AUDIT_ACTIONS.deleted,
        entityType: 'media',
        entityId: found.id,
        metadata: { status: found.status },
      });
      return { deleted: true, mediaId: found.id };
    },
  };
}

export type MediaAdminService = ReturnType<typeof createMediaAdminService>;
