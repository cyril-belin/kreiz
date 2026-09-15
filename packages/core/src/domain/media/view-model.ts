import type { KreizMedia } from '../../data/tables/media.js';
import { MediaNotReadyError } from './errors.js';

/**
 * Vue **publique** d'un média (mission §30) — structure simple et stable
 * reçue par les templates du Project, jamais un row Drizzle brut.
 *
 * Invariant fondateur : seul un média `ready` produit une vue publique
 * (mission §2, §29) — un média `uploading`/`processing`/`failed` n'apparaît
 * jamais dans une page publique, jamais dans une preview publiée.
 *
 * L'original est volontairement absent de la vue (mission §42/§43 : original
 * privé, seules les variantes transformées sont publiques) ; aucune URL
 * signée ni expirante (mission §39) — les URLs sont construites depuis la
 * base publique/CDN configurée côté serveur.
 */
export interface PublicMediaVariant {
  /** URL publique absolue de la variante. */
  readonly url: string;
  readonly width: number;
  /** Format MIME : `image/webp` | `image/avif`. */
  readonly format: string;
  /** Largeur maximale de la source (le `<picture>` du Project reste maître du layout). */
  readonly height: number | null;
}

export interface PublicMediaView {
  readonly id: string;
  /** Alt text saisi par l'admin (vide = image décorative assumée). */
  readonly alt: string;
  /** Dimensions de l'original (après correction d'orientation) — ratio des variantes. */
  readonly width: number;
  readonly height: number;
  /** Variantes triées par largeur croissante, tous formats confondus. */
  readonly variants: readonly PublicMediaVariant[];
}

/** Normalise une base publique : origine + préfixe, sans slash final. */
export function normalizeMediaPublicBaseUrl(publicBaseUrl: string): string {
  const trimmed = publicBaseUrl.trim().replace(/\/+$/, '');
  if (trimmed.length === 0) {
    throw new Error(
      '@kreiz/core : KREIZ_STORAGE_PUBLIC_BASE_URL invalide — une URL de base publique (CDN/bucket) est requise pour servir les médias.',
    );
  }
  return trimmed;
}

/**
 * Résout la vue publique d'un média `ready`. `publicBaseUrl` vient de
 * l'environnement du Project (jamais du client). Lève `MediaNotReadyError`
 * sur tout autre statut — le lecteur public et la publication appellent
 * cette fonction : un média non ready ne passe jamais.
 */
export function resolvePublicMediaView(
  media: Pick<KreizMedia, 'id' | 'status' | 'altText' | 'width' | 'height' | 'variants'>,
  options: { publicBaseUrl: string },
): PublicMediaView {
  if (media.status !== 'ready') {
    throw new MediaNotReadyError(media.id, media.status);
  }
  const base = normalizeMediaPublicBaseUrl(options.publicBaseUrl);
  const width = media.width;
  const height = media.height;
  if (width === null || height === null) {
    // Un média ready est passé par le transformer : ses dimensions sont posées.
    throw new MediaNotReadyError(media.id, `ready sans dimensions (${media.status})`);
  }
  const variants = [...media.variants]
    .sort((a, b) => a.width - b.width || a.format.localeCompare(b.format))
    .map((variant) => {
      const isAvif = variant.format === 'avif' || variant.format === 'image/avif';
      return {
        url: `${base}/${variant.key}`,
        width: variant.width,
        format: isAvif ? 'image/avif' : 'image/webp',
        height: width > 0 && variant.width > 0 ? Math.round((height * variant.width) / width) : null,
      } satisfies PublicMediaVariant;
    });
  return {
    id: media.id,
    alt: media.altText,
    width,
    height,
    variants,
  };
}
