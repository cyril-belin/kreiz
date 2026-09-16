import { getContentRegistry } from '../content/runtime.js';
import { getContactFormRegistry } from '../forms/runtime.js';
import { createAdminAuditLogRepository } from '../data/repositories/admin-audit-log.js';
import { createAnalyticsEventsRepository } from '../data/repositories/analytics-events.js';
import { createContactRequestsRepository } from '../data/repositories/contact-requests.js';
import { createContentEntriesRepository } from '../data/repositories/content-entries.js';
import { createMediaRepository } from '../data/repositories/media.js';
import { createRedirectsRepository } from '../data/repositories/redirects.js';
import { createRateLimitsRepository } from '../data/repositories/rate-limits.js';
import { createScheduledBackgroundJobs, fireAndForgetScheduler, waitUntilScheduler } from '../adapters/jobs.js';
import { createSharpImageTransformer } from '../adapters/image/sharp.js';
import { createAnalyticsService, type AnalyticsService } from '../services/analytics.js';
import { createContactService, type ContactService } from '../services/contact.js';
import { createContentService, type ContentService } from '../services/content.js';
import { createMediaAdminService, type MediaAdminService } from '../services/media-admin.js';
import { createMediaProcessingService, type MediaProcessingService } from '../services/media-processing.js';
import { createMediaRecoveryService, type MediaRecoveryService } from '../services/media-recovery.js';
import { createMediaUploadService, type MediaUploadService } from '../services/media-upload.js';
import { createPublicationService, type PublicationService } from '../services/publication.js';
import type { BackgroundJobs } from '../ports/jobs.js';
import { getKreizAdminRuntime, type KreizAdminRuntime } from './server-env.js';
import { getAnalyticsConfig } from '../analytics/runtime.js';

/**
 * Composition root des pages du moteur de contenu : runtime admin (base +
 * auth + port de rebuild + storage média + bloc mail) **plus** les services
 * contenu, publication, médias et contact construits sur les registres des
 * types et formulaires du Project (module virtuel). Memoïsé par identité du
 * runtime de base — une seule revalidation des registres par processus.
 *
 * Les services média sont `null` quand **aucun stockage n'est configuré**
 * (`KREIZ_STORAGE_*` absentes) : la page /admin/media affiche un état
 * explicite « non configuré » — jamais un service à moitié câblé. Le
 * service contact existe toujours : sans bloc mail, les demandes restent
 * stockées et notifiées `not_configured` (cadrage §13).
 *
 * Ce module n'est importable que dans un contexte Vite/Astro (il tire le
 * module virtuel) : les services et tests injectent des registres explicites.
 */
export interface KreizContentRuntime extends KreizAdminRuntime {
  content: ContentService;
  publication: PublicationService;
  upload: MediaUploadService | null;
  processing: MediaProcessingService | null;
  mediaAdmin: MediaAdminService | null;
  recovery: MediaRecoveryService | null;
  /** Demandes de contact — soumission publique, boîte admin, relances. */
  contact: ContactService;
  /** Analytics privacy-first (slice 8) — collecte beacon, conversions, dashboard. */
  analytics: AnalyticsService;
}

let cached: { base: KreizAdminRuntime; runtime: KreizContentRuntime } | null = null;

export function getKreizContentRuntime(): KreizContentRuntime {
  const base = getKreizAdminRuntime();
  if (cached?.base !== base) {
    const entries = createContentEntriesRepository(base.db);
    const media = createMediaRepository(base.db);
    const audit = createAdminAuditLogRepository(base.db);
    const redirects = createRedirectsRepository(base.db);
    const rateLimits = createRateLimitsRepository(base.db);
    const requests = createContactRequestsRepository(base.db);
    const registry = getContentRegistry();
    const forms = getContactFormRegistry();
    const mediaPublicBaseUrl = base.mediaPublicBaseUrl;
    const analytics = createAnalyticsService({
      events: createAnalyticsEventsRepository(base.db),
      rateLimits,
      config: getAnalyticsConfig(),
      secret: base.secret,
    });
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
    const contact = createContactService({
      requests,
      rateLimits,
      audit,
      mailer: base.mailer,
      mailFrom: base.mailFrom,
      secret: base.secret,
      forms: { findById: (formId) => forms.findByKey(formId) },
      analytics,
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
        contact,
        analytics,
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
