import type { z } from 'zod';
import type {
  KreizContentEntry,
  KreizContentSeo,
  KreizContentStatus,
} from '../../data/tables/content-entries.js';
import type { PublicMediaView } from '../media/view-model.js';
import { ContentDataCorruptedError, UnknownContentTypeError } from './errors.js';

/**
 * Vue de contenu **mutualisée** (mission §23) : le mapping entrée DB → props
 * de template est unique. La preview SSR (`/admin/preview/[id]`) et le rendu
 * public (build Astro des pages du Project) appellent le même
 * `resolveContentViewModel` et passent **exactement les mêmes données
 * structurées** au **même composant** de template du Project. Aucun
 * renderer de preview parallèle.
 *
 * `cover` (slice 5) : la vue publique du média de couverture — `ready`
 * uniquement (mission §29), résolue par l'appelant (service de contenu pour
 * la preview, lecteur de build pour le public) qui passe la vue déjà
 * résolue en option. `null` = pas de couverture (ou couverture non prête en
 * preview — jamais rendue comme image valide).
 */
export interface ContentView<TData> {
  readonly id: string;
  readonly contentType: string;
  readonly routeNamespace: string;
  readonly title: string;
  readonly slug: string;
  readonly status: KreizContentStatus;
  readonly publishedAt: Date | null;
  readonly updatedAt: Date;
  readonly createdAt: Date;
  readonly seo: KreizContentSeo;
  /** Couverture résolue (`ready` uniquement), ou `null`. */
  readonly cover: PublicMediaView | null;
  /** Données spécifiques du type, validées par le schéma de la déclaration. */
  readonly data: TData;
}

type ContentEntryLike = Pick<
  KreizContentEntry,
  | 'id'
  | 'contentType'
  | 'routeNamespace'
  | 'title'
  | 'slug'
  | 'status'
  | 'publishedAt'
  | 'updatedAt'
  | 'createdAt'
  | 'seo'
  | 'data'
>;

/**
 * Résout la vue typée d'une entrée :
 * 1. `content_type` de l'entrée = clé de la déclaration (une entrée n'est
 *    jamais rendue sous un autre type — isolation des types, mission §35) ;
 * 2. `route_namespace` cohérent avec la déclaration (imposé serveur) ;
 * 3. `data` validé par le schéma strict du type — une entrée en base avec
 *    un type inconnu ou des données invalides lève une erreur de domaine
 *    propre, jamais un rendu silencieux de contenu invalide (mission §4).
 */
export function resolveContentViewModel<TData>(
  declaration: { key: string; routeNamespace: string; dataSchema: z.ZodType<TData> },
  entry: ContentEntryLike,
  options: { cover?: PublicMediaView | null } = {},
): ContentView<TData> {
  if (entry.contentType !== declaration.key) {
    throw new UnknownContentTypeError(
      `${entry.contentType} (entrée ${entry.id}, attendu « ${declaration.key} »)`,
    );
  }
  if (entry.routeNamespace !== declaration.routeNamespace) {
    throw new ContentDataCorruptedError(
      entry.id,
      `route_namespace « ${entry.routeNamespace} » incohérent avec la déclaration « ${declaration.routeNamespace} »`,
    );
  }
  const parsed = declaration.dataSchema.safeParse(entry.data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const detail = issue ? `${issue.path.join('.') || '(racine)'} : ${issue.message}` : 'schéma invalide';
    throw new ContentDataCorruptedError(entry.id, `data invalid — ${detail}`);
  }
  return {
    id: entry.id,
    contentType: entry.contentType,
    routeNamespace: entry.routeNamespace,
    title: entry.title,
    slug: entry.slug,
    status: entry.status,
    publishedAt: entry.publishedAt,
    updatedAt: entry.updatedAt,
    createdAt: entry.createdAt,
    seo: entry.seo,
    cover: options.cover ?? null,
    data: parsed.data,
  };
}
