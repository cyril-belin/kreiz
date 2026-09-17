import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { KreizDatabase } from '../connection.js';
import {
  contentEntries,
  type KreizContentEntry,
  type KreizContentEntryInsert,
  type KreizContentSeo,
} from '../tables/content-entries.js';

/**
 * Repository du domaine contenus.
 *
 * Surface portée par les slices : création, lecture typée, lookup par slug
 * actif (slice 1) puis listing, édition de brouillon, soft delete et
 * vérification de collision de slug (slice 3), publication et lectures
 * orientées build public (slice 4), SEO éditorial (slice 9).
 *
 * Frontière de publication : `markPublished` / `markUnpublished` sont des
 * primitives d'état — la décision (validation, redirections, audit, rebuild)
 * appartient au service de publication, jamais ici. `updateDraft` ne touche
 * jamais les colonnes snapshot publiées (une édition ne modifie que l'état
 * éditorial courant — contrat « Save != Publish »).
 *
 * Le SQL brut (`db.execute`) n'apparaît que dans les tests ; les pages
 * admin passent par le service contenu, jamais par ce repository
 * directement (cadrage §6 : Drizzle confiné à data/repositories).
 */

/** Format UUID des colonnes uuid — un id non conforme est « introuvable »,
 * jamais une erreur SQL brute (22P02) remontée aux routes (même garde que
 * le repository médias ; l'URL d'une route admin ne fait pas foi). */
const CONTENT_ENTRY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      if (!CONTENT_ENTRY_ID_PATTERN.test(id)) return Promise.resolve(null);
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
     * (titre, slug, data, traçabilité) plus la couverture (slice 5 — champ
     * système `cover_media_id`, jamais stockée dans `data`) sont acceptés :
     * le contenu_type, le namespace, le statut et les dates de publication
     * ne passent jamais par cette méthode. Retourne `null` si l'entrée est
     * absente ou déjà supprimée (soft).
     */
    async updateDraft(
      id: string,
      patch: {
        title?: string;
        slug?: string;
        data?: Record<string, unknown>;
        /** Couverture éditoriale — `null` = retirer la couverture. */
        coverMediaId?: string | null;
        /** SEO éditorial validé (slice 9) — objet complet, jamais un merge partiel. */
        seo?: Record<string, unknown>;
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
          ...(patch.coverMediaId !== undefined ? { coverMediaId: patch.coverMediaId } : {}),
          ...(patch.seo !== undefined ? { seo: patch.seo } : {}),
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

    /**
     * Publie : `status = published`, fige le dernier état public (snapshots
     * `published_*`) et pose la traçabilité. `publishedAt` est calculé par
     * le service (`entry.publishedAt ?? now` — la date de première
     * publication n'est jamais réécrite, mission §6). Les écritures
     * publiques (redirections) restent des opérations séparées du service :
     * le driver neon-http ne supporte pas de transaction interactive
     * (mission §32) — le point de bascule est ce single UPDATE. Retourne
     * `null` si l'entrée est absente ou déjà supprimée.
     */
    async markPublished(
      id: string,
      patch: {
        publishedAt: Date;
        publishedSlug: string;
        publishedTitle: string;
        publishedData: Record<string, unknown>;
        publishedSeo: KreizContentSeo;
        /** Snapshot de la couverture au moment de la publication (slice 5). */
        publishedCoverMediaId: string | null;
        updatedBy: string;
        updatedAt: Date;
      },
    ): Promise<KreizContentEntry | null> {
      const rows = await db
        .update(contentEntries)
        .set({
          status: 'published',
          publishedAt: patch.publishedAt,
          publishedSlug: patch.publishedSlug,
          publishedTitle: patch.publishedTitle,
          publishedData: patch.publishedData,
          publishedSeo: patch.publishedSeo,
          publishedCoverMediaId: patch.publishedCoverMediaId,
          updatedBy: patch.updatedBy,
          updatedAt: patch.updatedAt,
        })
        .where(and(eq(contentEntries.id, id), isNull(contentEntries.deletedAt)))
        .returning();
      return rows.at(0) ?? null;
    },

    /**
     * Dépublie : `status = draft`. Conserve le contenu **et** l'historique
     * public (`published_at`, snapshots `published_*`) — la date de première
     * publication et le dernier chemin public ne sont jamais perdus
     * (mission §6, §7). Retourne `null` si l'entrée est absente ou déjà
     * supprimée.
     */
    async markUnpublished(
      id: string,
      patch: { updatedBy: string; updatedAt: Date },
    ): Promise<KreizContentEntry | null> {
      const rows = await db
        .update(contentEntries)
        .set({
          status: 'draft',
          updatedBy: patch.updatedBy,
          updatedAt: patch.updatedAt,
        })
        .where(and(eq(contentEntries.id, id), isNull(contentEntries.deletedAt)))
        .returning();
      return rows.at(0) ?? null;
    },

    /**
     * Listing **publié** d'un type, du plus récemment publié au plus ancien —
     * lecteur de build public (pages prérendues). Chaque ligne porte son
     * dernier état public (snapshots) : la projection est résolue par le
     * domaine (`resolvePublishedProjection`), pas ici.
     */
    listPublishedByType(
      contentType: string,
      options: { limit?: number } = {},
    ): Promise<KreizContentEntry[]> {
      return db
        .select()
        .from(contentEntries)
        .where(
          and(
            eq(contentEntries.contentType, contentType),
            eq(contentEntries.status, 'published'),
            isNull(contentEntries.deletedAt),
          ),
        )
        .orderBy(desc(contentEntries.publishedAt))
        .limit(options.limit ?? 500);
    },

    /**
     * Contenu publié par **slug public** (`published_slug`) — l'espace d'URL
     * public est celui du dernier état figé, jamais du slug éditorial
     * courant (un slug modifié non publié ne résout aucune page).
     */
    findPublishedByNamespaceAndPublishedSlug(
      routeNamespace: string,
      publishedSlug: string,
    ): Promise<KreizContentEntry | null> {
      return db
        .select()
        .from(contentEntries)
        .where(
          and(
            eq(contentEntries.routeNamespace, routeNamespace),
            eq(contentEntries.publishedSlug, publishedSlug),
            eq(contentEntries.status, 'published'),
            isNull(contentEntries.deletedAt),
          ),
        )
        .limit(1)
        .then((rows) => rows.at(0) ?? null);
    },

    /** Tous les chemins publiés vivants — matérialisation des redirections au build. */
    listPublishedRoutes(): Promise<Array<{ routeNamespace: string; slug: string }>> {
      return db
        .select({ routeNamespace: contentEntries.routeNamespace, slug: contentEntries.publishedSlug })
        .from(contentEntries)
        .where(
          and(eq(contentEntries.status, 'published'), isNull(contentEntries.deletedAt)),
        )
        .then((rows) =>
          rows.flatMap((row) => (row.slug === null ? [] : [{ routeNamespace: row.routeNamespace, slug: row.slug }])),
        );
    },

    /**
     * Contenus publiés **indexables** pour le sitemap (slice 9) : snapshots
     * publics uniquement, soft-deleted et noindex exclus (`published_seo
     * ->> 'noindex'` — une page exclue de l'indexation n'appartient pas au
     * sitemap). `lastmod` fiable = `published_at` (date de publication ;
     * les Saves non publiés ne la touchent jamais).
     */
    listPublishedForSitemap(): Promise<
      Array<{ routeNamespace: string; publishedSlug: string; publishedAt: Date | null }>
    > {
      return db
        .select({
          routeNamespace: contentEntries.routeNamespace,
          publishedSlug: contentEntries.publishedSlug,
          publishedAt: contentEntries.publishedAt,
        })
        .from(contentEntries)
        .where(
          and(
            eq(contentEntries.status, 'published'),
            isNull(contentEntries.deletedAt),
            sql`coalesce(${contentEntries.publishedSeo} ->> 'noindex', 'false') <> 'true'`,
          ),
        )
        .then((rows) =>
          rows.flatMap((row) =>
            row.publishedSlug === null
              ? []
              : [{ routeNamespace: row.routeNamespace, publishedSlug: row.publishedSlug, publishedAt: row.publishedAt }],
          ),
        );
    },
  };
}

export type ContentEntriesRepository = ReturnType<typeof createContentEntriesRepository>;
