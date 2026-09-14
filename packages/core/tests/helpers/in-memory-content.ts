import type { KreizAdminAuditLog } from '../../src/data/tables/admin-audit-log';
import type { KreizContentEntry } from '../../src/data/tables/content-entries';
import type { ContentEntriesRepository } from '../../src/data/repositories/content-entries';

/**
 * Repository contenu **en mémoire** — double de test pour les règles de
 * domaine sans PostgreSQL. Il reproduit la sémantique de l'index unique
 * partiel `(route_namespace, slug) WHERE deleted_at IS NULL` :
 * `slugExistsInNamespace` ne regarde que les lignes actives.
 *
 * Les comportements PostgreSQL réels (index partiel, 23505, dates) restent
 * couverts par les tests d'intégration sur Neon.
 */
export type InMemoryContentState = {
  entries: Map<string, KreizContentEntry>;
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
  state: InMemoryContentState = { entries: new Map(), auditRows: [] },
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
