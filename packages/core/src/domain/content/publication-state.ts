import type { KreizContentEntry } from '../../data/tables/content-entries.js';
import { ContentDataCorruptedError } from './errors.js';

/**
 * État de publication (mission §5, §20, §29) — règles pures.
 *
 * Le moteur distingue conceptuellement **l'état éditorial courant** (colonnes
 * `title`, `slug`, `data`, `seo` — modifiées par chaque Save) du **dernier
 * état effectivement public** (colonnes `published_*` — écrites uniquement
 * par Publish). Le site statique ne lit que le second : un Save sur un
 * contenu publié ne change donc jamais la sortie publique, même au prochain
 * rebuild déclenché par un autre contenu (contrat « Save != Publish »).
 */

/**
 * Projection publique d'une entrée **publiée** : la vue telle que le dernier
 * Publish l'a figée. Lève `ContentDataCorruptedError` si les colonnes
 * snapshot sont absentes — une ligne `published` sans snapshot est un état
 * incohérent (le Publish est l'unique écrivain) : échec explicite, jamais un
 * rendu silencieux (mission §39, même contrat que le lecteur de build).
 */
export function resolvePublishedProjection(
  entry: Pick<
    KreizContentEntry,
    'id' | 'status' | 'title' | 'slug' | 'data' | 'seo' | 'publishedSlug' | 'publishedTitle' | 'publishedData' | 'publishedSeo'
  >,
): { title: string; slug: string; data: Record<string, unknown>; seo: KreizContentEntry['seo'] } {
  if (entry.status !== 'published') {
    throw new ContentDataCorruptedError(entry.id, 'projection publique demandée sur un contenu non publié');
  }
  if (
    entry.publishedSlug === null ||
    entry.publishedTitle === null ||
    entry.publishedData === null ||
    entry.publishedSeo === null
  ) {
    throw new ContentDataCorruptedError(
      entry.id,
      'contenu publié sans état public figé (published_slug/title/data/seo absents)',
    );
  }
  return {
    title: entry.publishedTitle,
    slug: entry.publishedSlug,
    data: entry.publishedData,
    seo: entry.publishedSeo,
  };
}

/**
 * « Modifications non publiées » — **calcul**, pas un état en base
 * (mission §29) : vrai quand l'état éditorial courant diverge du dernier
 * état public figé. Comparaison JSON canonique (l'ordre des clés est stable :
 * les deux projections sortent du même pipeline de validation) ; une
 * divergence masquée par un ordre de clés différent est une fausse négative
 * d'indicateur UI sans conséquence de correction.
 */
export function hasUnpublishedChanges(
  entry: Pick<
    KreizContentEntry,
    'status' | 'title' | 'slug' | 'data' | 'seo' | 'publishedSlug' | 'publishedTitle' | 'publishedData' | 'publishedSeo'
  >,
): boolean {
  if (entry.status !== 'published') return false;
  if (entry.publishedSlug === null) return false;
  return (
    entry.slug !== entry.publishedSlug ||
    entry.title !== entry.publishedTitle ||
    entry.publishedData === null ||
    entry.publishedSeo === null ||
    canonicalJson(entry.data) !== canonicalJson(entry.publishedData) ||
    canonicalJson(entry.seo) !== canonicalJson(entry.publishedSeo)
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}
