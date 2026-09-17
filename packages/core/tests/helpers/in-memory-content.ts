import type { KreizAdminAuditLog } from '../../src/data/tables/admin-audit-log';
import type { KreizContentEntry } from '../../src/data/tables/content-entries';
import type { KreizRedirect } from '../../src/data/tables/redirects';
import type { ContentEntriesRepository } from '../../src/data/repositories/content-entries';
import type { RedirectsRepository } from '../../src/data/repositories/redirects';

/**
 * Repositories **en mémoire** — doubles de test pour les règles de domaine
 * sans PostgreSQL. Ils reproduisent la sémantique de l'index unique partiel
 * `(route_namespace, slug) WHERE deleted_at IS NULL` :
 * `slugExistsInNamespace` ne regarde que les lignes actives.
 *
 * Les comportements PostgreSQL réels (index partiel, 23505, dates, upsert
 * `from_path`) restent couverts par les tests d'intégration sur Neon.
 */
export type InMemoryContentState = {
  entries: Map<string, KreizContentEntry>;
  redirects: Map<string, KreizRedirect>;
  auditRows: KreizAdminAuditLog[];
};

export function stubContentEntry(values: Partial<KreizContentEntry> = {}): KreizContentEntry {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    contentType: 'article',
    routeNamespace: 'articles',
    title: 'Titre',
    slug: 'titre',
    coverMediaId: null,
    status: 'draft',
    publishedAt: null,
    publishedSlug: null,
    publishedTitle: null,
    publishedData: null,
    publishedSeo: null,
    publishedCoverMediaId: null,
    seo: {},
    data: {},
    createdBy: crypto.randomUUID(),
    updatedBy: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...values,
  };
}

export function createInMemoryContentRepository(
  state: InMemoryContentState = { entries: new Map(), redirects: new Map(), auditRows: [] },
): ContentEntriesRepository {
  const active = (entry: KreizContentEntry) => entry.deletedAt === null;

  return {
    async create(values): Promise<KreizContentEntry> {
      const entry = stubContentEntry({ ...values } as Partial<KreizContentEntry>);
      state.entries.set(entry.id, entry);
      return entry;
    },

    async findById(id) {
      return state.entries.get(id) ?? null;
    },

    async findActiveByNamespaceAndSlug(routeNamespace, slug) {
      for (const entry of state.entries.values()) {
        if (
          active(entry) &&
          entry.routeNamespace === routeNamespace &&
          entry.slug === slug
        ) {
          return entry;
        }
      }
      return null;
    },

    async listByType(contentType, options = {}) {
      return [...state.entries.values()]
        .filter((entry) => active(entry) && entry.contentType === contentType)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, options.limit ?? 500);
    },

    async updateDraft(id, patch) {
      const entry = state.entries.get(id);
      if (!entry || !active(entry)) return null;
      const updated: KreizContentEntry = {
        ...entry,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
        ...(patch.data !== undefined ? { data: patch.data } : {}),
        ...(patch.coverMediaId !== undefined ? { coverMediaId: patch.coverMediaId } : {}),
        ...(patch.seo !== undefined ? { seo: patch.seo as KreizContentEntry['seo'] } : {}),
        updatedBy: patch.updatedBy,
        updatedAt: patch.updatedAt,
      };
      state.entries.set(id, updated);
      return updated;
    },

    async softDelete(id, patch) {
      const entry = state.entries.get(id);
      if (!entry || !active(entry)) return null;
      const updated: KreizContentEntry = {
        ...entry,
        deletedAt: patch.deletedAt,
        updatedBy: patch.updatedBy,
        updatedAt: patch.deletedAt,
      };
      state.entries.set(id, updated);
      return updated;
    },

    async slugExistsInNamespace(routeNamespace, slug, options = {}) {
      for (const entry of state.entries.values()) {
        if (!active(entry) || options.excludeId === entry.id) continue;
        if (entry.routeNamespace === routeNamespace && entry.slug === slug) return true;
      }
      return false;
    },

    async markPublished(id, patch) {
      const entry = state.entries.get(id);
      if (!entry || !active(entry)) return null;
      const updated: KreizContentEntry = {
        ...entry,
        status: 'published',
        publishedAt: patch.publishedAt,
        publishedSlug: patch.publishedSlug,
        publishedTitle: patch.publishedTitle,
        publishedData: patch.publishedData,
        publishedSeo: patch.publishedSeo,
        publishedCoverMediaId: patch.publishedCoverMediaId,
        updatedBy: patch.updatedBy,
        updatedAt: patch.updatedAt,
      };
      state.entries.set(id, updated);
      return updated;
    },

    async markUnpublished(id, patch) {
      const entry = state.entries.get(id);
      if (!entry || !active(entry)) return null;
      const updated: KreizContentEntry = {
        ...entry,
        status: 'draft',
        updatedBy: patch.updatedBy,
        updatedAt: patch.updatedAt,
      };
      state.entries.set(id, updated);
      return updated;
    },

    async listPublishedByType(contentType, options = {}) {
      return [...state.entries.values()]
        .filter((entry) => active(entry) && entry.contentType === contentType && entry.status === 'published')
        .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))
        .slice(0, options.limit ?? 500);
    },

    async findPublishedByNamespaceAndPublishedSlug(routeNamespace, publishedSlug) {
      for (const entry of state.entries.values()) {
        if (
          active(entry) &&
          entry.status === 'published' &&
          entry.routeNamespace === routeNamespace &&
          entry.publishedSlug === publishedSlug
        ) {
          return entry;
        }
      }
      return null;
    },

    async listPublishedRoutes() {
      return [...state.entries.values()]
        .filter((entry) => active(entry) && entry.status === 'published' && entry.publishedSlug !== null)
        .map((entry) => ({ routeNamespace: entry.routeNamespace, slug: entry.publishedSlug as string }));
    },

    // Miroir en mémoire du filtre SQL réel (slice 9) : publiés actifs,
    // noindex exclu — une page hors index n'appartient pas au sitemap.
    async listPublishedForSitemap() {
      return [...state.entries.values()]
        .filter(
          (entry) =>
            active(entry) &&
            entry.status === 'published' &&
            entry.publishedSlug !== null &&
            entry.publishedSeo?.noindex !== true,
        )
        .map((entry) => ({
          routeNamespace: entry.routeNamespace,
          publishedSlug: entry.publishedSlug as string,
          publishedAt: entry.publishedAt,
        }));
    },
  };
}

/** Repository redirections en mémoire — upsert sur `from_path` comme l'index unique SQL. */
export function createInMemoryRedirectsRepository(
  state: InMemoryContentState,
): RedirectsRepository {
  return {
    async create(values) {
      if (state.redirects.has(values.fromPath)) {
        const error = new Error('duplicate') as { code?: string };
        error.code = '23505';
        throw error;
      }
      const row: KreizRedirect = {
        id: crypto.randomUUID(),
        fromPath: values.fromPath,
        toPath: values.toPath,
        contentEntryId: values.contentEntryId ?? null,
        createdAt: new Date(),
      };
      state.redirects.set(row.fromPath, row);
      return row;
    },

    async findByFromPath(fromPath) {
      return state.redirects.get(fromPath) ?? null;
    },

    async listAll(options = {}) {
      return [...state.redirects.values()].slice(0, options.limit ?? 10_000);
    },

    async upsert(values) {
      const existing = state.redirects.get(values.fromPath);
      const row: KreizRedirect = {
        id: existing?.id ?? crypto.randomUUID(),
        fromPath: values.fromPath,
        toPath: values.toPath,
        contentEntryId: values.contentEntryId,
        createdAt: existing?.createdAt ?? new Date(),
      };
      state.redirects.set(row.fromPath, row);
      return row;
    },

    async deleteByFromPaths(fromPaths) {
      let deleted = 0;
      for (const path of fromPaths) {
        if (state.redirects.delete(path)) deleted += 1;
      }
      return deleted;
    },

    async retargetTargets(fromPathTarget, newToPath) {
      let retargeted = 0;
      for (const row of state.redirects.values()) {
        if (row.toPath === fromPathTarget) {
          state.redirects.set(row.fromPath, { ...row, toPath: newToPath });
          retargeted += 1;
        }
      }
      return retargeted;
    },

    async count() {
      return state.redirects.size;
    },
  };
}

/** Audit en mémoire — n'enregistre que (l'append est la seule opération). */
export function createInMemoryAuditRepository(state: InMemoryContentState) {
  return {
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
