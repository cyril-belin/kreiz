import { randomUUID } from 'node:crypto';
import type { AdminAuditLogRepository } from '../data/repositories/admin-audit-log.js';
import type { MediaRepository } from '../data/repositories/media.js';
import type { KreizMedia } from '../data/tables/media.js';
import { mediaOriginalKey } from '../domain/media/keys.js';
import {
  MEDIA_PRESIGN_EXPIRY_SECONDS,
  MEDIA_MAX_UPLOAD_BYTES,
  parseMediaUploadRequest,
} from '../domain/media/policy.js';
import { detectImageMime } from '../domain/media/inspect.js';
import type { BackgroundJobs } from '../ports/jobs.js';
import type { ObjectStorage, PresignedUpload } from '../ports/storage.js';
import { MEDIA_AUDIT_ACTIONS, type MediaAuditSource } from './media-audit.js';
import { MediaNotFoundError, MediaStateError } from '../domain/media/errors.js';

/**
 * Service **upload** média (mission §3, §10, §25) — la moitié upload du
 * pipeline : validation initiale, création de la ligne, présignature et
 * confirmation post-upload. Le traitement (transformation, variantes,
 * états `ready`/`failed`) appartient au service processing.
 *
 * Flux (le navigateur n'envoie **jamais** l'image via le serveur Astro) :
 *
 * ```text
 * POST /admin/media/upload-request
 *   → auth + CSRF + validation metadata (taille ≤ 20 Mo, MIME allowlist)
 *   → row media `uploading` (clé générée media/{id}/original)
 *   → URL présignée PUT (10 min, une clé exacte, content-type figé)
 * navigateur → PUT direct vers le stockage
 * POST /admin/media/[id]/confirm
 *   → serveur head + lit l'objet : taille réelle, magic bytes réels
 *   → uploading → processing → enqueue transformation
 * ```
 *
 * Validation **à deux niveaux** (mission §4) : les métadonnées annoncées ne
 * servent qu'à filtrer tôt ; seule la vérification de l'objet réel décide.
 * Idempotence (mission §11) : un second confirm sur `processing`/`ready`
 * est un succès explicite sans effet de bord ; un confirm sur `failed` est
 * refusé (passe par le retry admin) ; un confirm sans objet présent garde
 * l'état `uploading` (l'upload est peut-être encore en cours — le client
 * peut re-confirmer).
 */

/** Raisons d'échec courtes et stables (colonne `failure_reason`, mission §21). */
export const MEDIA_FAILURE_REASONS = {
  tooLarge: 'too-large',
  emptyObject: 'empty-object',
  mimeUnsupported: 'mime-unsupported',
  originalMissing: 'original-missing',
  transformFailed: 'transform-failed',
  variantWriteFailed: 'variant-write-failed',
} as const;

export type MediaUploadServiceDeps = {
  media: MediaRepository;
  audit: AdminAuditLogRepository;
  storage: ObjectStorage;
};

export type CreateUploadRequestInput = {
  actorAdminId: string;
  /** Métadonnées annoncées par le client — premier filtre uniquement. */
  request: unknown;
};

export type CreateUploadRequestOutcome =
  | { kind: 'created'; media: KreizMedia; upload: PresignedUpload }
  | { kind: 'invalid'; reason: 'metadata' };

export type ConfirmUploadInput = {
  mediaId: string;
  actorAdminId: string;
};

export type ConfirmUploadOutcome =
  | { kind: 'confirmed'; media: KreizMedia }
  /** Déjà confirmé — idempotent (double-clic, retry navigateur, mission §11). */
  | { kind: 'already-processing'; media: KreizMedia }
  | { kind: 'already-ready'; media: KreizMedia }
  /** Un média failed ne se re-confirme pas : passe par le retry admin. */
  | { kind: 'failed'; media: KreizMedia }
  /** Objet absent : l'upload direct n'est (peut-être) pas terminé — état conservé. */
  | { kind: 'object-missing'; media: KreizMedia }
  /** Objet réel invalide : nettoyé, média `failed`, raison courte exposée. */
  | { kind: 'rejected'; media: KreizMedia; reason: string };

export function createMediaUploadService(deps: MediaUploadServiceDeps) {
  const { media, audit, storage } = deps;

  return {
    /**
     * Demande d'upload : validation des métadonnées annoncées, création de
     * la ligne `uploading` avec clé générée, présignature PUT courte durée.
     * Audit `media.created` avec le vrai acteur admin.
     */
    async createUploadRequest(
      input: CreateUploadRequestInput,
      options: { now?: Date } = {},
    ): Promise<CreateUploadRequestOutcome> {
      const now = options.now ?? new Date();
      const metadata = parseMediaUploadRequest(input.request);
      if (!metadata) {
        return { kind: 'invalid', reason: 'metadata' };
      }

      // L'id est généré côté service : la clé storage en dérive (mission §6),
      // jamais du nom de fichier utilisateur.
      const id = randomUUID();
      const row = await media.createUploading({
        id,
        storageKey: mediaOriginalKey(id),
        mime: metadata.mime,
        sizeBytes: metadata.sizeBytes,
        altText: '',
        variants: [],
        uploadedBy: input.actorAdminId,
        createdAt: now,
        updatedAt: now,
      });

      const upload = await storage.presignUpload({
        key: row.storageKey,
        contentType: metadata.mime,
        expiresInSeconds: MEDIA_PRESIGN_EXPIRY_SECONDS,
      });

      await audit.append({
        actorAdminId: input.actorAdminId,
        action: MEDIA_AUDIT_ACTIONS.created,
        entityType: 'media',
        entityId: row.id,
        metadata: { mime: metadata.mime, sizeBytes: metadata.sizeBytes },
      });

      return { kind: 'created', media: row, upload };
    },

    /**
     * Confirmation post-upload : vérification de l'objet **réel** (taille,
     * magic bytes), jamais des métadonnées du navigateur (mission §10).
     * Voir la doc du module pour l'idempotence et les cas limites.
     */
    async confirmUpload(
      input: ConfirmUploadInput,
      options: { now?: Date; jobs: BackgroundJobs },
    ): Promise<ConfirmUploadOutcome> {
      const now = options.now ?? new Date();
      const { jobs } = options;
      const found = await media.findById(input.mediaId);
      if (!found) throw new MediaNotFoundError(input.mediaId);

      // Idempotence explicite (mission §11).
      if (found.status === 'processing') return { kind: 'already-processing', media: found };
      if (found.status === 'ready') return { kind: 'already-ready', media: found };
      if (found.status === 'failed') return { kind: 'failed', media: found };

      const head = await storage.head(found.storageKey);
      if (!head) {
        return { kind: 'object-missing', media: found };
      }

      if (head.sizeBytes > MEDIA_MAX_UPLOAD_BYTES) {
        return this.rejectUpload(found, {
          reason: MEDIA_FAILURE_REASONS.tooLarge,
          actorAdminId: input.actorAdminId,
          source: 'confirm',
          now,
        });
      }
      if (head.sizeBytes === 0) {
        return this.rejectUpload(found, {
          reason: MEDIA_FAILURE_REASONS.emptyObject,
          actorAdminId: input.actorAdminId,
          source: 'confirm',
          now,
        });
      }

      // Type réel par magic bytes (mission §5) — l'objet fait foi sur le
      // mime stocké : une extension mensongère n'existe plus à ce stade.
      const bytes = await storage.read(found.storageKey);
      const detected = bytes ? detectImageMime(bytes) : null;
      if (!detected) {
        return this.rejectUpload(found, {
          reason: MEDIA_FAILURE_REASONS.mimeUnsupported,
          actorAdminId: input.actorAdminId,
          source: 'confirm',
          now,
        });
      }

      // uploading → processing (transition gardée en base — mission §11).
      const processing = await media.markProcessing(found.id, {
        mime: detected,
        sizeBytes: head.sizeBytes,
        updatedAt: now,
      });
      if (!processing) {
        // Une confirmation concurrente a gagné : relecture, résultat idempotent.
        const raced = await media.findById(found.id);
        if (raced?.status === 'processing') return { kind: 'already-processing', media: raced };
        if (raced?.status === 'ready') return { kind: 'already-ready', media: raced };
        throw new MediaStateError(found.id, raced?.status ?? 'unknown', 'confirm');
      }

      // La transformation part **après** le basculement d'état : un crash
      // laisse un média `processing` récupérable (mission §20/§23), jamais
      // un média traité sans état cohérent.
      await jobs.enqueueMediaProcessing(processing.id);
      return { kind: 'confirmed', media: processing };
    },

    /**
     * Rejet à la confirmation : objet supprimé du stockage si possible,
     * média `failed` avec raison courte, audit avec le vrai acteur (la
     * validation a lieu dans la requête d'un admin — mission §44).
     */
    async rejectUpload(
      found: KreizMedia,
      context: { reason: string; actorAdminId: string; source: MediaAuditSource; now: Date },
    ): Promise<ConfirmUploadOutcome> {
      await storage
        .deleteMany([found.storageKey])
        .catch(() => {
          // Best effort (mission §4 : « si possible ») — un objet résiduel
          // orphelin est sans référence ; la récupération future peut le purger.
        });
      const failed = await media.markFailed(found.id, {
        failureReason: context.reason,
        updatedAt: context.now,
      });
      if (!failed) {
        // Course concurrentielle : un autre chemin a déjà quitté `uploading`.
        const raced = await media.findById(found.id);
        if (raced) return { kind: 'already-processing', media: raced };
        throw new MediaNotFoundError(found.id);
      }
      await audit.append({
        actorAdminId: context.actorAdminId,
        action: MEDIA_AUDIT_ACTIONS.failed,
        entityType: 'media',
        entityId: failed.id,
        metadata: { reason: context.reason, source: context.source },
      });
      return { kind: 'rejected', media: failed, reason: context.reason };
    },
  };
}

export type MediaUploadService = ReturnType<typeof createMediaUploadService>;

// Erreurs partagées du domaine média — ré-export pour les routes.
export { MediaNotFoundError, MediaStateError } from '../domain/media/errors.js';
