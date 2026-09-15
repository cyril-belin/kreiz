import { getContentRegistry } from '../content/runtime.js';
import { createAdminAuditLogRepository } from '../data/repositories/admin-audit-log.js';
import { createContentEntriesRepository } from '../data/repositories/content-entries.js';
import { createMediaRepository } from '../data/repositories/media.js';
import { createRedirectsRepository } from '../data/repositories/redirects.js';
import { createScheduledBackgroundJobs, fireAndForgetScheduler, waitUntilScheduler } from '../adapters/jobs.js';
import { createSharpImageTransformer } from '../adapters/image/sharp.js';
import { createContentService, type ContentService } from '../services/content.js';
import { createMediaAdminService, type MediaAdminService } from '../services/media-admin.js';
import { createMediaProcessingService, type MediaProcessingService } from '../services/media-processing.js';
import { createMediaRecoveryService, type MediaRecoveryService } from '../services/media-recovery.js';
import { createMediaUploadService, type MediaUploadService } from '../services/media-upload.js';
import { createPublicationService, type PublicationService } from '../services/publication.js';
import type { BackgroundJobs } from '../ports/jobs.js';
import { getKreizAdminRuntime, type KreizAdminRuntime } from './server-env.js';

/**
 * Composition root des pages du moteur de contenu : runtime admin (base +
 * auth + port de rebuild + storage média) **plus** les services contenu,
 * publication et médias construits sur le registre des types du Project
 * (module virtuel). Memoïsé par identité du runtime de base — une seule
 * revalidation du registre par processus.
 *
 * Les services média sont `null` quand **aucun stockage n'est configuré**
 * (`KREIZ_STORAGE_*` absentes) : la page /admin/media affiche un état
 * explicite « non configuré » — jamais un service à moitié câblé.
 *
 * Ce module n'est importable que dans un contexte Vite/Astro (il tire le
 * module virtuel) : les services et tests injectent un registre explicite.
 */
export interface KreizContentRuntime extends KreizAdminRuntime {
  content: ContentService;
  publication: PublicationService;
  upload: MediaUploadService | null;
  processing: MediaProcessingService | null;
  mediaAdmin: MediaAdminService | null;
  recovery: MediaRecoveryService | null;
}

let cached: { base: KreizAdminRuntime; runtime: KreizContentRuntime } | null = null;

export function getKreizContentRuntime(): KreizContentRuntime {
  const base = getKreizAdminRuntime();
  if (cached?.base !== base) {
    const entries = createContentEntriesRepository(base.db);
    const media = createMediaRepository(base.db);
    const audit = createAdminAuditLogRepository(base.db);
    const redirects = createRedirectsRepository(base.db);
    const registry = getContentRegistry();
    const mediaPublicBaseUrl = base.mediaPublicBaseUrl;
    const content = createContentService({
      entries,
      media,
      audit,
      registry,
      rebuild: base.rebuild,
      mediaPublicBaseUrl,
    });
    const publication = createPublicationService({
      entries,
      media,
      redirects,
      audit,
      registry,
      rebuild: base.rebuild,
      mediaPublicBaseUrl,
    });
    const mediaServices = base.storage
      ? (() => {
          const processing = createMediaProcessingService({
            media,
            audit,
            storage: base.storage,
            transformer: createSharpImageTransformer(),
          });
          const jobsFor = (source: 'background_job' | 'recovery') =>
            createScheduledBackgroundJobs({
              handler: (mediaId) =>
                processing.processMedia({ mediaId, source }).then(() => undefined),
              // Contexte cron/récupération : fire-and-forget — un balayage
              // n'a jamais de waitUntil à portée.
              schedule: fireAndForgetScheduler(),
            });
          return {
            upload: createMediaUploadService({ media, audit, storage: base.storage }),
            processing,
            mediaAdmin: createMediaAdminService({ media, audit, storage: base.storage }),
            recovery: createMediaRecoveryService({ media, audit, jobs: jobsFor('recovery') }),
          };
        })()
      : { upload: null, processing: null, mediaAdmin: null, recovery: null };
    cached = {
      base,
      runtime: {
        ...base,
        content,
        publication,
        upload: mediaServices.upload,
        processing: mediaServices.processing,
        mediaAdmin: mediaServices.mediaAdmin,
        recovery: mediaServices.recovery,
      },
    };
  }
  return cached.runtime;
}

/**
 * Port `BackgroundJobs` **par requête** (mission §18) : la transformation
 * ne s'exécute jamais dans le chemin de la requête utilisateur — elle est
 * planifiée via `waitUntil` quand la plateforme l'expose (Vercel), sinon en
 * fire-and-forget (serveur dev long-lived, où la promesse survit à la
 * réponse). Retourne `null` si aucun traitement média n'est possible
 * (stockage non configuré).
 */
export function createMediaJobsForRequest(
  runtime: KreizContentRuntime,
  waitUntil: ((promise: Promise<unknown>) => void) | null,
): BackgroundJobs | null {
  if (!runtime.processing) return null;
  return createScheduledBackgroundJobs({
    handler: (mediaId) =>
      runtime.processing!.processMedia({ mediaId, source: 'background_job' }).then(() => undefined),
    schedule: waitUntil ? waitUntilScheduler(waitUntil) : fireAndForgetScheduler(),
  });
}

/**
 * Extrait `waitUntil` du contexte plateforme (adapter Vercel : `locals.runtime.ctx.waitUntil`).
 * Absent en dev et hors serverless — retourne `null`.
 */
export function platformWaitUntil(locals: unknown): ((promise: Promise<unknown>) => void) | null {
  const ctx = (
    locals as {
      runtime?: { ctx?: { waitUntil?: (promise: Promise<unknown>) => void } };
    } | null
  )?.runtime?.ctx;
  return typeof ctx?.waitUntil === 'function' ? ctx.waitUntil.bind(ctx) : null;
}
