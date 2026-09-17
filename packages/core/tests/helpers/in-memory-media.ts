import type { KreizAdminAuditLog } from '../../src/data/tables/admin-audit-log';
import type { KreizContentEntry } from '../../src/data/tables/content-entries';
import type { KreizMedia, KreizMediaInsert } from '../../src/data/tables/media';
import type { MediaRepository } from '../../src/data/repositories/media';
import type { ObjectStorage, StoragePutInput, StoredObjectHead } from '../../src/ports/storage';
import type { BackgroundJobs } from '../../src/ports/jobs';
import { MEDIA_STATUS_TRANSITIONS } from '../../src/domain/media/lifecycle';
import { extractRichTextMediaIds, type KreizRichTextDocument } from '../../src/domain/content/rich-text/document';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `data` (ou `published_data`) est un enregistrement de champs — un média
 * référencé vit dans un **champ** document, pas à la racine : extraction par
 * valeur de champ, structurellement défensive (document malformé = pas de
 * référence extraite, jamais d'exception dans un comptage).
 */
function dataReferencesMedia(data: unknown, mediaId: string): boolean {
  if (!isObjectRecord(data)) return false;
  return Object.values(data).some(
    (fieldValue) =>
      isObjectRecord(fieldValue) &&
      Array.isArray((fieldValue as { content?: unknown }).content) &&
      extractRichTextMediaIds(fieldValue as unknown as KreizRichTextDocument).includes(mediaId),
  );
}

/**
 * Doubles de test du domaine média (mission §19/§50) — repositories,
 * storage et jobs **en mémoire**, pour les règles de services sans
 * PostgreSQL ni serveur S3. Les comportements PostgreSQL réels (transitions
 * gardées sous concurrence, FK RESTRICT, comptage SQL) restent couverts par
 * les tests d'intégration Neon ; l'adapter S3 réel est prouvé contre un
 * serveur S3 local (s3rver).
 */

export function stubMediaRow(values: Partial<KreizMediaInsert> = {}): KreizMedia {
  const now = new Date();
  const id = values.id ?? crypto.randomUUID();
  return {
    id,
    status: values.status ?? 'ready',
    failureReason: values.failureReason ?? null,
    storageKey: values.storageKey ?? `media/${id}/original`,
    mime: values.mime ?? 'image/png',
    sizeBytes: values.sizeBytes ?? 1234,
    width: values.width ?? 800,
    height: values.height ?? 600,
    altText: values.altText ?? '',
    variants: values.variants ?? [
      { key: `media/${id}/400.webp`, width: 400, format: 'webp', sizeBytes: 30_000 },
      { key: `media/${id}/400.avif`, width: 400, format: 'avif', sizeBytes: 25_000 },
    ],
    uploadedBy: values.uploadedBy ?? crypto.randomUUID(),
    createdAt: values.createdAt ?? now,
    updatedAt: values.updatedAt ?? now,
    deletedAt: values.deletedAt ?? null,
  } as KreizMedia;
}

export type InMemoryMediaState = {
  media: Map<string, KreizMedia>;
  auditRows: KreizAdminAuditLog[];
  /** Contenus (pour le comptage d'usage des couvertures). */
  entries: Map<string, KreizContentEntry>;
};

export function createInMemoryMediaRepository(
  state: InMemoryMediaState = { media: new Map(), auditRows: [], entries: new Map() },
): MediaRepository {
  return {
    async createUploading(values) {
      const row = stubMediaRow({ ...values, status: 'uploading' });
      state.media.set(row.id, row);
      return row;
    },

    async findById(id) {
      return state.media.get(id) ?? null;
    },

    async markProcessing(id, patch) {
      const row = state.media.get(id);
      if (!row || !MEDIA_STATUS_TRANSITIONS[row.status].includes('processing')) return null;
      const updated: KreizMedia = {
        ...row,
        status: 'processing',
        failureReason: null,
        ...(patch.mime !== undefined ? { mime: patch.mime } : {}),
        ...(patch.sizeBytes !== undefined ? { sizeBytes: patch.sizeBytes } : {}),
        updatedAt: patch.updatedAt,
      };
      state.media.set(id, updated);
      return updated;
    },

    async markReady(id, patch) {
      const row = state.media.get(id);
      if (!row || row.status !== 'processing') return null;
      const updated: KreizMedia = {
        ...row,
        status: 'ready',
        width: patch.width,
        height: patch.height,
        variants: patch.variants,
        failureReason: null,
        updatedAt: patch.updatedAt,
      };
      state.media.set(id, updated);
      return updated;
    },

    async markFailed(id, patch) {
      const row = state.media.get(id);
      if (!row || !['uploading', 'processing'].includes(row.status)) return null;
      const updated: KreizMedia = {
        ...row,
        status: 'failed',
        failureReason: patch.failureReason.slice(0, 200),
        updatedAt: patch.updatedAt,
      };
      state.media.set(id, updated);
      return updated;
    },

    async updateAlt(id, patch) {
      const row = state.media.get(id);
      if (!row || row.deletedAt) return null;
      const updated: KreizMedia = {
        ...row,
        altText: patch.altText,
        updatedAt: patch.updatedAt,
      };
      state.media.set(id, updated);
      return updated;
    },

    async listReady(limit = 200) {
      return [...state.media.values()]
        .filter((row) => row.status === 'ready' && !row.deletedAt)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit);
    },

    async listAdmin(limit = 200) {
      return [...state.media.values()]
        .filter((row) => !row.deletedAt)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit);
    },

    async listReadyByIds(ids) {
      const set = new Set(ids);
      return [...state.media.values()].filter(
        (row) => set.has(row.id) && row.status === 'ready' && !row.deletedAt,
      );
    },

    async countCoverReferences(mediaId) {
      let count = 0;
      for (const entry of state.entries.values()) {
        if (entry.coverMediaId === mediaId || entry.publishedCoverMediaId === mediaId) count += 1;
      }
      return count;
    },

    // Miroir en mémoire du comptage JSONB réel (slice 6) : extraction
    // structurelle par le domaine, contenus soft-deleted compris.
    async countRichTextReferences(mediaId) {
      let count = 0;
      for (const entry of state.entries.values()) {
        const referenced =
          dataReferencesMedia(entry.data, mediaId) ||
          dataReferencesMedia(entry.publishedData, mediaId);
        if (referenced) count += 1;
      }
      return count;
    },

    // Miroir du comptage SEO OG réel (slice 9) : clé `ogImageMediaId` du
    // JSONB `seo` ou du snapshot `published_seo`, soft-deleted compris.
    async countSeoOgImageReferences(mediaId) {
      let count = 0;
      for (const entry of state.entries.values()) {
        if (entry.seo?.ogImageMediaId === mediaId || entry.publishedSeo?.ogImageMediaId === mediaId) {
          count += 1;
        }
      }
      return count;
    },

    async countContentReferences(mediaId) {
      let count = 0;
      for (const entry of state.entries.values()) {
        const coverRef = entry.coverMediaId === mediaId || entry.publishedCoverMediaId === mediaId;
        const seoOgRef = entry.seo?.ogImageMediaId === mediaId || entry.publishedSeo?.ogImageMediaId === mediaId;
        if (
          coverRef ||
          seoOgRef ||
          dataReferencesMedia(entry.data, mediaId) ||
          dataReferencesMedia(entry.publishedData, mediaId)
        ) {
          count += 1;
        }
      }
      return count;
    },

    async deletePhysical(id) {
      return state.media.delete(id);
    },

    async findStuckProcessing(olderThan, limit = 50) {
      return [...state.media.values()]
        .filter((row) => row.status === 'processing' && row.updatedAt < olderThan)
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
        .slice(0, limit);
    },

    async listFailed(limit = 50) {
      return [...state.media.values()]
        .filter((row) => row.status === 'failed' && !row.deletedAt)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, limit);
    },
  };
}

/**
 * Storage **en mémoire** (mission §50) — même contrat que l'adapter S3 :
 * `publicUrl` construit depuis une base publique, `deleteMany` tolère les
 * objets absents.
 */
export type InMemoryStorageState = {
  objects: Map<string, { body: Uint8Array; contentType: string; cacheControl: string | null }>;
};

export function createInMemoryStorage(
  state: InMemoryStorageState = { objects: new Map() },
): ObjectStorage & { state: InMemoryStorageState } {
  const publicBaseUrl = 'https://media.example.test/cdn';
  return {
    state,
    async presignUpload(input) {
      return {
        url: `${publicBaseUrl}/upload/${input.key}`,
        method: 'PUT',
        headers: { 'content-type': input.contentType },
        expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
      };
    },
    async head(key): Promise<StoredObjectHead | null> {
      const object = state.objects.get(key);
      if (!object) return null;
      return { sizeBytes: object.body.byteLength, contentType: object.contentType };
    },
    async read(key) {
      return state.objects.get(key)?.body ?? null;
    },
    async put(input: StoragePutInput) {
      state.objects.set(input.key, {
        body: input.body,
        contentType: input.contentType,
        cacheControl: input.cacheControl ?? null,
      });
    },
    async deleteMany(keys) {
      for (const key of keys) state.objects.delete(key);
    },
    publicUrl(key) {
      return `${publicBaseUrl}/${key}`;
    },
  };
}

/** File de jobs **contrôlée** (mission §19) — les tests drainent quand ils veulent. */
export function createQueuedJobs(): BackgroundJobs & { queued: string[]; drain(handler: (mediaId: string) => Promise<void>): Promise<void> } {
  const queued: string[] = [];
  return {
    queued,
    async enqueueMediaProcessing(mediaId) {
      queued.push(mediaId);
    },
    async drain(handler) {
      while (queued.length > 0) {
        const mediaId = queued.shift() as string;
        await handler(mediaId);
      }
    },
  };
}

/** Audit en mémoire — append-only, même surface que le repository réel. */
export function createInMemoryAudit(state: { auditRows: KreizAdminAuditLog[] }) {
  return {
    auditRows: state.auditRows,
    async append(event: {
      actorAdminId: string | null;
      action: string;
      entityType: string;
      entityId: string;
      metadata?: Record<string, unknown>;
    }): Promise<KreizAdminAuditLog> {
      const row: KreizAdminAuditLog = {
        id: crypto.randomUUID(),
        actorAdminId: event.actorAdminId,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        metadata: event.metadata ?? {},
        createdAt: new Date(),
      };
      state.auditRows.push(row);
      return row;
    },
  };
}
