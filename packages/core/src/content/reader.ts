import { createKreizDatabase, type KreizDatabase } from '../data/connection.js';
import { createContentEntriesRepository } from '../data/repositories/content-entries.js';
import { createMediaRepository } from '../data/repositories/media.js';
import type { ContentTypeDefinition, InferContentTypeData } from '../domain/content/declaration.js';
import { ContentDataCorruptedError } from '../domain/content/errors.js';
import { resolvePublishedProjection } from '../domain/content/publication-state.js';
import {
  collectRichTextMediaIds,
  resolveContentViewModel,
  type ContentView,
} from '../domain/content/view-model.js';
import { resolvePublicMediaView } from '../domain/media/view-model.js';
import { buildRichTextMediaMap, loadRichTextMediaMap } from './rich-text-media.js';

/**
 * Lecteur de contenu **public** pour le build Astro du Project (cadrage §9 :
 * « les pages publiques consomment les données via les repositories au
 * build »). Le Project appelle ce lecteur dans `getStaticPaths` :
 *
 * ```ts
 * // apps/…/pages/articles/[slug].astro
 * export async function getStaticPaths() {
 *   if (!process.env.KREIZ_DATABASE_URL) return []; // pas de base au build → 0 page
 *   const reader = createContentReader({
 *     databaseUrl: process.env.KREIZ_DATABASE_URL,
 *     mediaPublicBaseUrl: process.env.KREIZ_STORAGE_PUBLIC_BASE_URL,
 *   });
 *   return reader.listPublishedViews({ declaration: articleType })
 *     .then((views) => views.map((view) => ({ params: { slug: view.slug }, props: { view } })));
 * }
 * ```
 *
 * Seuls les contenus `published` non supprimés sont exposés, et **uniquement
 * leur dernier état effectivement public** (colonnes snapshot `published_*`,
 * figées par Publish — mission §5, §20) : l'URL générée est `published_slug`,
 * jamais le slug éditorial courant. Un Save — même sur un contenu publié —
 * ne change jamais la sortie du build (contrat Save != Publish),
 * **couverture et médias du rich text compris** : la page lit
 * `published_cover_media_id` et `published_data` (mission slice 5 §28,
 * slice 6), jamais l'état éditorial courant.
 *
 * La couverture est résolue **batch** (une requête pour toutes les pages) et
 * **`ready` uniquement** (mission §29) : un snapshot pointant un média
 * absent ou non prêt est une corruption — le build échoue explicitement
 * (même contrat que les données publiées invalides). Zéro requête Neon au
 * moment de servir : ces pages sont du HTML statique.
 */
export interface ContentReader {
  /** Contenus publiés d'un type (dernier état public), du plus récemment publié au plus ancien. */
  listPublishedViews<D extends ContentTypeDefinition>(options: {
    declaration: D;
    /** Nombre maximal d'entrées lues (défaut 500 — garde-fou de build). */
    limit?: number;
  }): Promise<Array<ContentView<InferContentTypeData<D>>>>;

  /** Un contenu publié par **slug public**, ou `null` (404 au build). */
  getPublishedViewBySlug<D extends ContentTypeDefinition>(options: {
    declaration: D;
    slug: string;
  }): Promise<ContentView<InferContentTypeData<D>> | null>;
}

export function createContentReader(options: {
  databaseUrl: string;
  /** Base publique des variantes média — requise dès qu'une couverture publiée existe. */
  mediaPublicBaseUrl?: string | null;
}): ContentReader {
  const db: KreizDatabase = createKreizDatabase({ databaseUrl: options.databaseUrl });
  const entries = createContentEntriesRepository(db);
  const media = createMediaRepository(db);

  /**
   * Résout les vues publiques des couvertures **et** des images Open Graph
   * explicites (slice 9 — `ready` uniquement, un seul lot) — absente ou non
   * prête ⇒ `ContentDataCorruptedError` : la publication a validé `ready` au
   * moment du Publish ; une divergence est une corruption (suppression
   * physique hors service…) et ne se rend jamais en silence.
   */
  async function resolveMediaViews(
    mediaIds: ReadonlyArray<string | null>,
  ): Promise<Map<string, ContentView<unknown>['cover']>> {
    const ids = [...new Set(mediaIds.filter((id): id is string => id !== null))];
    const resolved = new Map<string, ContentView<unknown>['cover']>();
    if (ids.length === 0) return resolved;
    const rows = await media.listReadyByIds(ids);
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) {
        throw new ContentDataCorruptedError(id, 'média publié absent ou non prêt (media)');
      }
      const publicBaseUrl = options.mediaPublicBaseUrl;
      if (!publicBaseUrl) {
        throw new ContentDataCorruptedError(
          id,
          'média publié sans base publique configurée (KREIZ_STORAGE_PUBLIC_BASE_URL absente)',
        );
      }
      resolved.set(id, resolvePublicMediaView(row, { publicBaseUrl }));
    }
    return resolved;
  }

  return {
    async listPublishedViews({ declaration, limit = 500 }) {
      const rows = await entries.listPublishedByType(declaration.key, { limit });
      const projections = rows.map((row) => ({
        row,
        published: resolvePublishedProjection(row),
      }));
      // Couvertures + images OG explicites — **un seul** appel batch
      // (slice 9 : l'image OG est un média publié comme les autres).
      const mediaViews = await resolveMediaViews([
        ...projections.map(({ published }) => published.coverMediaId),
        ...projections.map(({ published }) => published.seo.ogImageMediaId ?? null),
      ]);
      const covers = mediaViews;
      // Médias du rich text — **un seul** appel batch pour toutes les pages
      // du type (slice 6 §15) : un snapshot référençant un média absent ou
      // non prêt est une corruption, le build échoue explicitement.
      const richTextIds = [
        ...new Set(
          projections.flatMap(({ published }) =>
            collectRichTextMediaIds(declaration.fields, published.data),
          ),
        ),
      ];
      const richTextMedia = await buildRichTextMediaMap(
        media,
        options.mediaPublicBaseUrl ?? null,
        richTextIds,
      );
      const views: Array<ContentView<InferContentTypeData<typeof declaration>>> = [];
      for (const { row, published } of projections) {
        const seoImageId = published.seo.ogImageMediaId ?? null;
        views.push(
          resolveContentViewModel(
            declaration,
            {
              ...row,
              title: published.title,
              slug: published.slug,
              data: published.data,
              seo: published.seo,
            },
            {
              cover: published.coverMediaId ? covers.get(published.coverMediaId) ?? null : null,
              richTextMedia,
              seoImage: seoImageId ? covers.get(seoImageId) ?? null : null,
            },
          ),
        );
      }
      views.sort(
        (a, b) =>
          (b.publishedAt?.getTime() ?? b.updatedAt.getTime()) -
          (a.publishedAt?.getTime() ?? a.updatedAt.getTime()),
      );
      return views;
    },

    async getPublishedViewBySlug({ declaration, slug }) {
      const row = await entries.findPublishedByNamespaceAndPublishedSlug(
        declaration.routeNamespace,
        slug,
      );
      if (!row) return null;
      const published = resolvePublishedProjection(row);
      const mediaViews = await resolveMediaViews([
        published.coverMediaId,
        published.seo.ogImageMediaId ?? null,
      ]);
      const richTextMedia = await loadRichTextMediaMap(
        media,
        options.mediaPublicBaseUrl ?? null,
        declaration.fields,
        published.data,
      );
      const seoImageId = published.seo.ogImageMediaId ?? null;
      return resolveContentViewModel(
        declaration,
        {
          ...row,
          title: published.title,
          slug: published.slug,
          data: published.data,
          seo: published.seo,
        },
        {
          cover: published.coverMediaId ? mediaViews.get(published.coverMediaId) ?? null : null,
          richTextMedia,
          seoImage: seoImageId ? mediaViews.get(seoImageId) ?? null : null,
        },
      );
    },
  };
}
