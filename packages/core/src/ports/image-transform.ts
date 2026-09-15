/**
 * Port de transformation d'images (mission §12 ; cadrage §11) — séparé du
 * stockage : un projet peut remplacer Sharp par un service d'images externe
 * sans toucher au domaine ni aux repositories (cadrage §11).
 *
 * Le domaine ne connaît **pas** Sharp : il décrit des variantes cibles
 * (largeur maximale + format) et reçoit des variantes produites. Le
 * contract note explicitement la règle **sans upscale** : une source plus
 * étroite qu'une variante demandée ne produit pas cette variante (mission
 * §13) — le service n'a pas à filtrer lui-même.
 */

import type { KreizMediaVariantFormat } from '../domain/media/policy.js';

/** Variante demandée au transformer. */
export interface ImageVariantSpec {
  /** Largeur maximale (px) — ratio conservé, jamais d'agrandissement. */
  width: number;
  format: KreizMediaVariantFormat;
}

/** Résultat d'inspection de l'original (après correction d'orientation EXIF). */
export interface InspectedImage {
  width: number;
  height: number;
  /** Type réel décodé : `image/jpeg` | `image/png` | `image/webp` | `image/avif`. */
  format: string;
}

/** Variante produite — le service l'écrit dans le stockage. */
export interface TransformedVariant {
  width: number;
  format: KreizMediaVariantFormat;
  data: Uint8Array;
}

export interface TransformedImage {
  /** Dimensions de l'original, orientation EXIF corrigée. */
  original: InspectedImage;
  /** Variantes réellement produites (sans celles dépassées par la source). */
  variants: TransformedVariant[];
}

export interface ImageTransformer {
  /**
   * Transforme un original en variantes. Doit :
   * - corriger l'orientation EXIF ;
   * - retirer les métadonnées sensibles (EXIF/GPS) des sorties ;
   * - ne jamais agrandir (mission §13) ;
   * - refuser proprement un contenu non décodable (erreur — le service
   *   marque le média `failed`, jamais de crash du job).
   */
  transform(original: Uint8Array, variants: readonly ImageVariantSpec[]): Promise<TransformedImage>;
}
