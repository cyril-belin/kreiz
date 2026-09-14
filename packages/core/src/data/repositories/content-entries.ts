import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import type { KreizDatabase } from '../connection.js';
import {
  contentEntries,
  type KreizContentEntry,
  type KreizContentEntryInsert,
} from '../tables/content-entries.js';

/**
 * Repository du domaine contenus.
 *
 * Surface portée par les slices : création, lecture typée, lookup par slug
 * actif (slice 1) puis listing, édition de brouillon, soft delete et
 * vérification de collision de slug (slice 3). La publication
 * (published_at, statut) et les lectures orientées build public sont
 * servies par le lecteur `@kreiz/core/content` — pas de méthode de
 * publication ici (slice 4).
 *
 * Le SQL brut (`db.execute`) n'apparaît que dans les tests ; les pages
 * admin passent par le service contenu, jamais par ce repository
 * directement (cadrage §6 : Drizzle confiné à data/repositories).
 */
export function createContentEntriesRepository(db: KreizDatabase) {
  return {
    async create(values: KreizContentEntryInsert): Promise<KreizContentEntry> {
      const rows = await db.insert(contentEntries).values(values).returning();
      const row = rows.at(0);
      if (!row) {
        throw new Error('@kreiz/core : contentEntries.create() n’a retourné aucune ligne.');
      }
      return row;
    },

    findById(id: string): Promise<KreizContentEntry | null> {
      return db
        .select()
        .from(contentEntries)
        .where(eq(contentEntries.id, id))
        .limit(1)
        .then((rows) => rows.at(0) ?? null);
    },

    /**
     * Lookup actif par namespace + slug : filtre `deleted_at IS NULL`, même
     * sémantique que l'index unique partiel — un slug soft-deleted n'est
     * jamais retourné comme contenu vivant.
     */
    findActiveByNamespaceAndSlug(
      routeNamespace: string,
      slug: string,
    ): Promise<KreizContentEntry | null> {
      return db
        .select()
        .from(contentEntries)
        .where(
          and(
            eq(contentEntries.routeNamespace, routeNamespace),
            eq(contentEntries.slug, slug),
            isNull(contentEntries.deletedAt),
          ),
        )
        .limit(1)
        .then((rows) => rows.at(0) ?? null);
    },

    /**
     * Listing actif d'un type (brouillons et publiés) — listings admin du
     * moteur de contenu et lecteur public de build. Du plus récemment
     * modifié au plus ancien (ergonomie éditoriale).
     */
    listByType(contentType: string, options: { limit?: number } = {}): Promise<KreizContentEntry[]> {
      return db
        .select()
        .from(contentEntries)
        .where(
          and(eq(contentEntries.contentType, contentType), isNull(contentEntries.deletedAt)),
        )
        .orderBy(desc(contentEntries.updatedAt))
        .limit(options.limit ?? 500);
    },

    /**
     * Mise à jour d'un brouillon — seuls les champs éditables du slice 3
     * (titre, slug, data, traçabilité) sont acceptés : le contenu_type, le
     * namespace, le statut et les dates de publication ne passent jamais
     * par cette méthode. Retourne `null` si l'entrée est absente ou déjà
     * supprimée (soft).
     */
    async updateDraft(
      id: string,
      patch: {
        title?: string;
        slug?: string;
        data?: Record<string, unknown>;
        updatedBy: string;
        updatedAt: Date;
      },
    ): Promise<KreizContentEntry | null> {
      const rows = await db
        .update(contentEntries)
        .set({
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
          ...(patch.data !== undefined ? { data: patch.data } : {}),
          updatedBy: patch.updatedBy,
          updatedAt: patch.updatedAt,
        })
        .where(and(eq(contentEntries.id, id), isNull(contentEntries.deletedAt)))
        .returning();
      return rows.at(0) ?? null;
    },

    /**
     * Soft delete (mission §24) : `deleted_at = now` + traçabilité — jamais
     * de suppression physique. L'index unique partiel `(route_namespace,
     * slug) WHERE deleted_at IS NULL` libère le slug pour une réutilisation
     * future. Retourne `null` si l'entrée est absente ou déjà supprimée.
     */
    async softDelete(
      id: string,
      patch: { deletedAt: Date; updatedBy: string },
    ): Promise<KreizContentEntry | null> {
      const rows = await db
        .update(contentEntries)
        .set({
          deletedAt: patch.deletedAt,
          updatedBy: patch.updatedBy,
          updatedAt: patch.deletedAt,
        })
        .where(and(eq(contentEntries.id, id), isNull(contentEntries.deletedAt)))
        .returning();
      return rows.at(0) ?? null;
    },

    /**
     * Collision de slug dans un namespace, hors soft-deleted — même
     * périmètre que l'index unique partiel. `excludeId` permet à l'édition
     * de conserver son propre slug.
     */
    async slugExistsInNamespace(
      routeNamespace: string,
      slug: string,
      options: { excludeId?: string } = {},
    ): Promise<boolean> {
      const rows = await db
        .select({ id: contentEntries.id })
        .from(contentEntries)
        .where(
          and(
            eq(contentEntries.routeNamespace, routeNamespace),
            eq(contentEntries.slug, slug),
            isNull(contentEntries.deletedAt),
            ...(options.excludeId ? [ne(contentEntries.id, options.excludeId)] : []),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },
  };
}

export type ContentEntriesRepository = ReturnType<typeof createContentEntriesRepository>;
