import Sharp from 'sharp';
import {
  MEDIA_MAX_PIXELS,
  type KreizMediaVariantFormat,
} from '../../domain/media/policy.js';
import type {
  ImageTransformer,
  ImageVariantSpec,
  TransformedImage,
} from '../../ports/image-transform.js';

/**
 * Adapter **Sharp** de référence du port `ImageTransformer` (mission §13 ;
 * cadrage §11). Confiné à l'adapter : le domaine ne connaît pas Sharp
 * (risque cadrage §24 — binaire natif en serverless — mitigé par le job
 * asynchrone, jamais dans le chemin d'une requête utilisateur).
 *
 * Décisions V1 (documentées, mission §14) :
 * - **Qualités** : WebP 80, AVIF 50 — bonnes qualité visuelle et compression
 *   sans sur-optimisation (temps de transformation raisonnables en lambda) ;
 * - **Pas d'upscale** : une variante dont la largeur cible dépasse la
 *   largeur de la source n'est pas produite (`withoutEnlargement` +
 *   filtrage en amont — pas de fichier dupliqué à taille identique) ;
 * - **Orientation EXIF corrigée** (`.rotate()` sans argument) ;
 * - **Metadata nettoyées** : Sharp retire par défaut EXIF/GPS/ profils
 *   couleurs exotiques des sorties — pas de donnée de localisation dans
 *   les variantes publiques (mission §42) ;
 * - **Decompression bombs** : `limitInputPixels` fixé à la limite de
 *   pixels de la politique média (mission §41).
 */

export function createSharpImageTransformer(): ImageTransformer {
  return {
    async transform(
      original: Uint8Array,
      variants: readonly ImageVariantSpec[],
    ): Promise<TransformedImage> {
      const pipelineBase = Sharp(original, {
        limitInputPixels: MEDIA_MAX_PIXELS,
        // Un fichier non décodable doit lever (media → failed), jamais
        // produire une image tronquée : erreur par défaut sur entrée
        // tronquée, avertissements ignorés (exif foireux) tant que le
        // décodage est sain.
        failOn: 'error',
      });

      const metadata = await pipelineBase.metadata();
      const width = metadata.width;
      const height = metadata.height;
      const format = metadata.format;
      // L'entrée réelle est déjà validée par magic bytes au confirm (allowlist
      // jpeg/png/webp/avif) : toute autre valeur est une anomalie — échec
      // propre du job, jamais un décodage au doigt mouillé.
      if (
        width === undefined ||
        height === undefined ||
        !format ||
        !['jpeg', 'png', 'webp', 'avif'].includes(format)
      ) {
        throw new Error('@kreiz/core : image originale non inspectable — décodage impossible.');
      }

      // Orientation EXIF réelle appliquée : les dimensions « rendues »
      // peuvent être permutées par rapport aux metadata brutes.
      const oriented = await pipelineBase.clone().rotate().toBuffer({ resolveWithObject: true });
      const originalWidth = oriented.info.width;
      const originalHeight = oriented.info.height;

      const produced = [];
      for (const spec of variants) {
        if (spec.width > originalWidth) continue; // pas d'upscale (mission §13)
        const buffer = await Sharp(oriented.data, { limitInputPixels: MEDIA_MAX_PIXELS })
          .resize({ width: spec.width, withoutEnlargement: true })
          .toFormat(toSharpFormat(spec.format), formatOptions(spec.format))
          .toBuffer();
        produced.push({ width: spec.width, format: spec.format, data: new Uint8Array(buffer) });
      }

      return {
        original: {
          width: originalWidth,
          height: originalHeight,
          format: `image/${format}`,
        },
        variants: produced,
      };
    },
  };
}

function toSharpFormat(format: KreizMediaVariantFormat): 'webp' | 'avif' {
  switch (format) {
    case 'avif':
      return 'avif';
    case 'webp':
    default:
      return 'webp';
  }
}

function formatOptions(format: KreizMediaVariantFormat): { quality: number } {
  return { quality: format === 'avif' ? AVIF_QUALITY : WEBP_QUALITY };
}

const WEBP_QUALITY = 80;
const AVIF_QUALITY = 50;
