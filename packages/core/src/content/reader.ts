import { createKreizDatabase, type KreizDatabase } from '../data/connection.js';
import { createContentEntriesRepository } from '../data/repositories/content-entries.js';
import type { ContentTypeDefinition, InferContentTypeData } from '../domain/content/declaration.js';
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
 * Seuls les contenus `published` non supprimés sont exposés (au slice 3,
 * rien n'est encore publié — les routes publiques émettent 0 page tant que
 * la publication n'existe pas, mission §22 option A). Les données invalides
 * en base font **échouer le build** (`resolveContentViewModel` lève) : on ne
 * prérend jamais silencieusement du contenu invalide. Zéro requête Neon au
 * moment de servir : ces pages sont du HTML statique.
 */
export interface ContentReader {
  /** Contenus publiés d'un type, du plus récemment publié au plus ancien. */
  listPublishedViews<D extends ContentTypeDefinition>(options: {
    declaration: D;
    /** Nombre maximal d'entrées lues (défaut 500 — garde-fou de build). */
    limit?: number;
  }): Promise<Array<ContentView<InferContentTypeData<D>>>>;

  /** Un contenu publié par slug, ou `null` (404 au build). */
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
      const rows = await entries.listByType(declaration.key, { limit });
      const views: Array<ContentView<InferContentTypeData<typeof declaration>>> = [];
      for (const row of rows) {
        if (row.status !== 'published') continue;
        views.push(resolveContentViewModel(declaration, row));
      }
      views.sort(
        (a, b) =>
          (b.publishedAt?.getTime() ?? b.updatedAt.getTime()) -
          (a.publishedAt?.getTime() ?? a.updatedAt.getTime()),
      );
      return views;
    },

    async getPublishedViewBySlug({ declaration, slug }) {
      const row = await entries.findActiveByNamespaceAndSlug(declaration.routeNamespace, slug);
      if (!row || row.status !== 'published') return null;
      return resolveContentViewModel(declaration, row);
    },
  };
}
