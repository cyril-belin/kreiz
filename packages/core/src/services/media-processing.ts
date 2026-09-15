import type { AdminAuditLogRepository } from '../data/repositories/admin-audit-log.js';
import type { MediaRepository } from '../data/repositories/media.js';
import type { KreizMedia, KreizMediaVariant } from '../data/tables/media.js';
import { mediaVariantKey } from '../domain/media/keys.js';
import { MEDIA_VARIANT_WIDTHS, type KreizMediaVariantFormat } from '../domain/media/policy.js';
import type { ImageVariantSpec } from '../ports/image-transform.js';
import type { ObjectStorage } from '../ports/storage.js';
import { MEDIA_AUDIT_ACTIONS, type MediaAuditSource } from './media-audit.js';
import { MEDIA_FAILURE_REASONS } from './media-upload.js';

/**
 * Service **processing** média (mission §21, §25) — la moitié asynchrone du
 * pipeline, exécutée par un job (`waitUntil` côté Vercel, fire-and-forget en
 * dev, jamais dans la requête utilisateur — mission §18) :
 *
 * ```text
 * media processing
 * → lecture de l'original (privé)
 * → inspection + transformation (port ImageTransformer)
 * → écriture des variantes (immuables, Cache-Control public)
 * → markReady
 * → en erreur : markFailed (raison courte) + audit sans stack trace
 * ```
 *
 * - **Acteur d'audit honnête** (mission §44, invariant slice 2) : un job
 *   n'a pas de session admin — `actor_admin_id = NULL` et
 *   `metadata.source: 'background_job' | 'recovery'`.
 * - **Idempotent** : un média déjà `ready` n'est jamais retransformé —
 *   les objets servis portent `immutable`, aucun remplacement silencieux
 *   d'URL publique (mission §40). Un double job concurrent est arbitré par
 *   la transition gardée `markReady` (une seule gagne).
 * - **Échec partiel** : variantes écrites puis échec → média `failed`, les
 *   objets résiduels n'ont **jamais** été publics (média jamais `ready`) —
 *   un retry réécrit les mêmes clés sans casser de cache (mission §23/§40).
 */

export type MediaProcessingServiceDeps = {
  media: MediaRepository;
  audit: AdminAuditLogRepository;
  storage: ObjectStorage;
  transformer: import('../ports/image-transform.js').ImageTransformer;
};

export type ProcessMediaInput = {
  mediaId: string;
  /** Source d'exécution — trace d'audit uniquement. */
  source: Extract<MediaAuditSource, 'background_job' | 'recovery'>;
};

export type ProcessMediaOutcome =
  | { kind: 'ready'; media: KreizMedia }
  | { kind: 'already-ready'; media: KreizMedia }
  | { kind: 'skipped'; media: KreizMedia | null; reason: string }
  | { kind: 'failed'; media: KreizMedia; reason: string };

/** Cache-Control des variantes — clés immuables (mission §40). */
export const MEDIA_VARIANT_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const VARIANT_SPECS: ImageVariantSpec[] = MEDIA_VARIANT_WIDTHS.flatMap((width) =>
  (['webp', 'avif'] as const).map((format) => ({ width, format })),
);

const VARIANT_MIME: Record<KreizMediaVariantFormat, string> = {
  webp: 'image/webp',
  avif: 'image/avif',
};

export function createMediaProcessingService(deps: MediaProcessingServiceDeps) {
  const { media, audit, storage, transformer } = deps;

  return {
    /** Specs de transformation V1 — exposé pour tests et documentation. */
    variantSpecs: VARIANT_SPECS,

    /**
     * Traite un média confirmé. Ne lève pas pour les échecs métier du média
     * (il marque `failed` et audite) — une exception ne doit rien perdre :
     * la méthode ne rejette qu'en cas d'erreur d'infrastructure imprévue,
     * après avoir tenté `markFailed`.
     */
    async processMedia(
      input: ProcessMediaInput,
      options: { now?: Date } = {},
    ): Promise<ProcessMediaOutcome> {
      const now = options.now ?? new Date();
      const found = await media.findById(input.mediaId);
      if (!found || found.deletedAt) {
        // Job perdu/obsolète : rien à faire, silencieusement.
        return { kind: 'skipped', media: null, reason: 'not-found' };
      }
      if (found.status === 'ready') {
        return { kind: 'already-ready', media: found };
      }
      if (found.status !== 'processing') {
        // `uploading` (jamais confirmé) ou `failed` : hors périmètre du job.
        return { kind: 'skipped', media: found, reason: `status-${found.status}` };
      }

      let originalBytes: Uint8Array | null;
      try {
        originalBytes = await storage.read(found.storageKey);
      } catch {
        originalBytes = null;
      }
      if (!originalBytes) {
        return this.failMedia(found, {
          reason: MEDIA_FAILURE_REASONS.originalMissing,
          source: input.source,
          now,
        });
      }

      let transformed;
      try {
        transformed = await transformer.transform(originalBytes, VARIANT_SPECS);
      } catch {
        // Raison courte, jamais de stack trace en DB (mission §21) : le
        // contenu était un fichier image maquillé ou corrompu, ou le
        // décodeur a refusé — même code, même traitement.
        return this.failMedia(found, {
          reason: MEDIA_FAILURE_REASONS.transformFailed,
          source: input.source,
          now,
        });
      }

      const variants: KreizMediaVariant[] = [];
      try {
        for (const variant of transformed.variants) {
          const key = mediaVariantKey(found.id, variant.width, variant.format);
          await storage.put({
            key,
            body: variant.data,
            contentType: VARIANT_MIME[variant.format],
            cacheControl: MEDIA_VARIANT_CACHE_CONTROL,
          });
          variants.push({
            key,
            width: variant.width,
            format: variant.format,
            sizeBytes: variant.data.byteLength,
          });
        }
      } catch {
        return this.failMedia(found, {
          reason: MEDIA_FAILURE_REASONS.variantWriteFailed,
          source: input.source,
          now,
        });
      }

      const ready = await media.markReady(found.id, {
        width: transformed.original.width,
        height: transformed.original.height,
        variants,
        updatedAt: now,
      });
      if (!ready) {
        // Un job concurrent a déjà publié le média : idempotent (mission §21),
        // les objets fraîchement écrits sont identiques (même original, même
        // version de transformer) — aucun cache cassé.
        const raced = await media.findById(found.id);
        if (raced?.status === 'ready') return { kind: 'already-ready', media: raced };
        return { kind: 'skipped', media: raced ?? found, reason: 'concurrent-transition' };
      }

      await audit.append({
        actorAdminId: null,
        action: MEDIA_AUDIT_ACTIONS.ready,
        entityType: 'media',
        entityId: ready.id,
        metadata: {
          source: input.source,
          width: ready.width,
          height: ready.height,
          variants: ready.variants.length,
        },
      });
      return { kind: 'ready', media: ready };
    },

    /**
     * Marque l'échec (transition gardée) puis audite avec acteur NULL et
     * source système — l'honnêteté de l'acteur prime (mission §44).
     */
    async failMedia(
      found: KreizMedia,
      context: { reason: string; source: MediaAuditSource; now: Date },
    ): Promise<ProcessMediaOutcome> {
      const failed = await media.markFailed(found.id, {
        failureReason: context.reason,
        updatedAt: context.now,
      });
      const row = failed ?? found;
      await audit.append({
        actorAdminId: null,
        action: MEDIA_AUDIT_ACTIONS.failed,
        entityType: 'media',
        entityId: row.id,
        metadata: { reason: context.reason, source: context.source },
      });
      return { kind: 'failed', media: row, reason: context.reason };
    },
  };
}

export type MediaProcessingService = ReturnType<typeof createMediaProcessingService>;
