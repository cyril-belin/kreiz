import { describe, expect, it } from 'vitest';
import Sharp from 'sharp';
import { createSharpImageTransformer } from '../src/adapters/image/sharp';
import { MEDIA_MAX_PIXELS } from '../src/domain/media/policy';
import { detectImageMime } from '../src/domain/media/inspect';
import type { ImageVariantSpec } from '../src/ports/image-transform';

/**
 * Adapter **Sharp réel** (mission §51) — fixtures générées
 * programmatiquement (aucun binaire commité), transformation exécutée
 * pour de vrai : dimensions, formats, orientation EXIF, pas d'upscale,
 * metadata nettoyées, bombe à la décompression refusée.
 */

const transformer = createSharpImageTransformer();

const ALL_VARIANTS: ImageVariantSpec[] = [400, 800, 1400, 2000].flatMap((width) =>
  (['webp', 'avif'] as const).map((format) => ({ width, format })),
);

async function fixturePng(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(
    await Sharp({
      create: { width, height, channels: 3, background: { r: 40, g: 90, b: 160 } },
    })
      .png()
      .toBuffer(),
  );
}

describe('transformer Sharp — transformation réelle', () => {
  it('génère les variantes WebP/AVIF aux largeurs ≤ source, dimensions d’origine correctes', async () => {
    const original = await fixturePng(1200, 800);
    const result = await transformer.transform(original, ALL_VARIANTS);

    expect(result.original).toEqual({ width: 1200, height: 800, format: 'image/png' });
    // 1200 px de source : 400 et 800 produits, 1400 et 2000 ignorés (mission §13).
    expect(result.variants.map((variant) => variant.width).sort((a, b) => a - b)).toEqual([400, 400, 800, 800]);

    for (const variant of result.variants) {
      // AVIF est un conteneur HEIF : Sharp le reporte 'heif' — la preuve du
      // type réel passe par les magic bytes du domaine (ftyp avif).
      if (variant.format === 'avif') {
        expect(detectImageMime(variant.data)).toBe('image/avif');
      } else {
        const meta = await Sharp(variant.data).metadata();
        expect(meta.format).toBe('webp');
      }
      const dims = await Sharp(variant.data).metadata();
      expect(dims.width).toBe(variant.width);
      // Ratio conservé (± 1 px d'arrondi) :
      expect(Math.abs((dims.height ?? 0) - Math.round((800 * variant.width) / 1200))).toBeLessThanOrEqual(1);
    }
  });

  it('une image source 900 px ne produit pas artificiellement du 1400/2000 (no upscale)', async () => {
    const original = await fixturePng(900, 600);
    const result = await transformer.transform(original, ALL_VARIANTS);
    expect(result.original.width).toBe(900);
    expect(result.variants.map((variant) => variant.width).sort((a, b) => a - b)).toEqual([400, 400, 800, 800]);
    expect(result.variants.some((variant) => variant.width > 900)).toBe(false);
  });

  it('corrige l’orientation EXIF : un portrait orienté 6 ressort en paysage', async () => {
    // Image stockée 400×600, orientation EXIF 6 (pivoter 90° pour afficher).
    const stored = await Sharp({
      create: { width: 400, height: 600, channels: 3, background: { r: 200, g: 30, b: 30 } },
    })
      .png()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const rawMeta = await Sharp(stored).metadata();
    expect(rawMeta.width).toBe(400);
    expect(rawMeta.height).toBe(600);
    expect(rawMeta.orientation).toBe(6);

    const result = await transformer.transform(new Uint8Array(stored), ALL_VARIANTS);
    // Dimensions « rendues » après correction : 600×400.
    expect(result.original).toMatchObject({ width: 600, height: 400 });
  });

  it('retire les métadonnées (EXIF/GPS) des variantes publiques (mission §42)', async () => {
    // EXIF embarque aussi le bloc GPS (IFD3) : il part avec le bloc EXIF.
    const withExif = await Sharp({
      create: { width: 800, height: 500, channels: 3, background: { r: 10, g: 10, b: 10 } },
    })
      .png()
      .withMetadata({ exif: { IFD0: { Copyright: 'Kreiz' } } })
      .toBuffer();

    const result = await transformer.transform(new Uint8Array(withExif), [
      { width: 400, format: 'webp' },
    ]);
    expect(result.variants).toHaveLength(1);
    const meta = await Sharp(result.variants[0]!.data).metadata();
    expect(meta.exif).toBeUndefined();
  });

  it('source plus étroite que la plus petite variante : une variante à la largeur naturelle est produite (revue sécurité finale)', async () => {
    // Une image < 400 px devenait `ready` avec zéro variante — publiable,
    // puis silencieusement invisible (aucune URL publique servable).
    const narrow = await Sharp({
      create: { width: 220, height: 90, channels: 3, background: '#3388cc' },
    })
      .png()
      .toBuffer();
    const transformed = await transformer.transform(new Uint8Array(narrow), ALL_VARIANTS);
    expect(transformed.variants.length).toBeGreaterThanOrEqual(1);
    expect(transformed.variants[0]!.width).toBe(220);
  });

  it('un fichier non image lève (media → failed côté service), pas de rendu silencieux', async () => {
    const notAnImage = new TextEncoder().encode('definitely not an image');
    await expect(transformer.transform(notAnImage, ALL_VARIANTS)).rejects.toThrow();
  });

  it('dépassement de pixels (bombe à la décompression) refusé par la limite Sharp', async () => {
    // 6000×6000 = 36 MP > limite politique (30 MP) — le PNG est minuscule
    // (couleur plate) mais son décodage serait géant : refus attendu.
    const bomb = await Sharp({
      create: { width: 6000, height: 6000, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    expect(6000 * 6000).toBeGreaterThan(MEDIA_MAX_PIXELS);
    await expect(transformer.transform(new Uint8Array(bomb), ALL_VARIANTS)).rejects.toThrow();
  });
});
