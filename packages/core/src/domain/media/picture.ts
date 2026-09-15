import type { PublicMediaView } from './view-model.js';

/**
 * Helpers de rendu **responsive** (mission §31) — fonctions pures qui
 * préparent les attributs d'un `<picture>` HTML. Le Core ne rend pas le
 * markup : le Project reste maître du layout (principe §1) — il compose
 *
 * ```astro
 * {view.cover && (
 *   <picture>
 *     {mediaSources(view.cover).map((source) => (
 *       <source type={source.type} srcset={source.srcset} sizes={source.sizes} />
 *     ))}
 *     <img
 *       src={mediaFallbackSrc(view.cover)}
 *       alt={view.cover.alt}
 *       width={view.cover.width}
 *       height={view.cover.height}
 *       loading="lazy"
 *     />
 *   </picture>
 * )}
 * ```
 *
 * - une `<source>` par format présent (AVIF d'abord — meilleur ratio
 *   qualité/poids, le navigateur prend la première qu'il supporte) ;
 * - srcset croissant sur les largeurs disponibles, `sizes` au choix du
 *   Project (dépend de son layout) ;
 * - le fallback `<img>` est la **plus grande variante WebP** (le format
 *   raster le mieux supporté, la meilleure résolution produite) — jamais
 *   l'original, jamais une URL signée.
 */

export interface MediaPictureSource {
  readonly type: 'image/avif' | 'image/webp';
  readonly srcset: string;
}

/** Sources `<source>` triées AVIF puis WebP ; srcset « url largeur, … ». */
export function mediaSources(view: PublicMediaView): MediaPictureSource[] {
  const sources: MediaPictureSource[] = [];
  for (const type of ['image/avif', 'image/webp'] as const) {
    const variants = view.variants.filter((variant) => variant.format === type);
    if (variants.length === 0) continue;
    sources.push({
      type,
      srcset: variants.map((variant) => `${variant.url} ${variant.width}w`).join(', '),
    });
  }
  return sources;
}

/** URL du fallback `<img>` : la plus grande variante WebP disponible. */
export function mediaFallbackSrc(view: PublicMediaView): string | null {
  const webp = view.variants.filter((variant) => variant.format === 'image/webp');
  const best = webp.at(-1) ?? view.variants.at(-1);
  return best?.url ?? null;
}
