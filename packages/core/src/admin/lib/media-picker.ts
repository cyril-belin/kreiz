import type { KreizMedia } from '../../data/tables/media.js';
import { normalizeMediaPublicBaseUrl } from '../../domain/media/view-model.js';

/**
 * Items du **picker média du rich text** (slice 6 §11) — réutilisation du
 * pipeline slice 5 sans duplication : seuls les médias `ready` sont
 * proposés, la miniature est la plus petite variante WebP servie depuis la
 * base publique (l'original privé n'apparaît jamais, mission §42/§43).
 *
 * Le picker ne gère **pas** d'upload inline : l'upload vit dans la
 * médiathèque (présign, confirm, processing, polling — code non dupliqué).
 * Décision V1 documentée dans docs/slices/slice-6.md.
 */

export interface RichTextPickerItem {
  id: string;
  alt: string;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
}

export function readyPickerItems(
  rows: ReadonlyArray<KreizMedia>,
  publicBaseUrl: string | null,
): RichTextPickerItem[] {
  if (!publicBaseUrl) return [];
  const base = normalizeMediaPublicBaseUrl(publicBaseUrl);
  return rows
    .filter((row) => row.status === 'ready')
    .map((row) => {
      const webp = row.variants
        .filter((variant) => variant.format === 'webp')
        .sort((a, b) => a.width - b.width);
      const best = webp[0] ?? row.variants[0];
      return {
        id: row.id,
        alt: row.altText,
        thumbnailUrl: best ? `${base}/${best.key}` : null,
        width: best?.width ?? null,
        // La hauteur exacte des variantes n'est pas stockée (dérivée du
        // ratio original au rendu) : la miniature admin vit sans height.
        height: null,
      };
    });
}
