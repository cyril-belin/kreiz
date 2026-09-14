import { createKreizDatabase, type KreizDatabase } from '../data/connection.js';
import { createContentEntriesRepository } from '../data/repositories/content-entries.js';
import type { ContentTypeDefinition, InferContentTypeData } from '../domain/content/declaration.js';
import { resolvePublishedProjection } from '../domain/content/publication-state.js';
import { resolveContentViewModel, type ContentView } from '../domain/content/view-model.js';

/**
 * Lecteur de contenu **public** pour le build Astro du Project (cadrage §9 :
 * « les pages publiques consomment les données via les repositories au
 * build »). Le Project appelle ce lecteur dans `getStaticPaths` :
 *
 * ```ts
 * // apps/…/pages/articles/[slug].astro
 * export async function getStaticPaths() {
 *   if (!process.env.KREIZ_DATABASE_URL) return []; // pas de base au build → 0 page
 *   const reader = createContentReader({ databaseUrl: process.env.KREIZ_DATABASE_URL });
 *   return reader.listPublishedViews({ declaration: articleType })
 *     .then((views) => views.map((view) => ({ params: { slug: view.slug }, props: { view } })));
 * }
 * ```
 *
 * Seuls les contenus `published` non supprimés sont exposés, et **uniquement
 * leur dernier état effectivement public** (colonnes snapshot `published_*`,
 * figées par Publish — mission §5, §20) : l'URL générée est `published_slug`,
 * jamais le slug éditorial courant. Un Save — même sur un contenu publié —
 * ne change donc jamais la sortie du build (contrat Save != Publish).
 *
 * Les données publiées invalides en base font **échouer le build**
 * (`resolveContentViewModel` / `resolvePublishedProjection` lèvent) : on ne
 * prérend jamais silencieusement du contenu invalide ou incohérent. Zéro
 * requête Neon au moment de servir : ces pages sont du HTML statique.
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

export function createContentReader(options: { databaseUrl: string }): ContentReader {
  const db: KreizDatabase = createKreizDatabase({ databaseUrl: options.databaseUrl });
  const entries = createContentEntriesRepository(db);

  return {
    async listPublishedViews({ declaration, limit = 500 }) {
      const rows = await entries.listPublishedByType(declaration.key, { limit });
      const views: Array<ContentView<InferContentTypeData<typeof declaration>>> = [];
      for (const row of rows) {
        const published = resolvePublishedProjection(row);
        views.push(
          resolveContentViewModel(declaration, {
            ...row,
            title: published.title,
            slug: published.slug,
            data: published.data,
            seo: published.seo,
          }),
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
      return resolveContentViewModel(declaration, {
        ...row,
        title: published.title,
        slug: published.slug,
        data: published.data,
        seo: published.seo,
      });
    },
  };
}
