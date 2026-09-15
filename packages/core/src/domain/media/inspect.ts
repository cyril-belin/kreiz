import type { KreizMediaAcceptedMime } from './policy.js';

/**
 * Détection du **type réel** d'un contenu image par ses magic bytes
 * (mission §5, §10) — l'extension et le content-type annoncé par le
 * navigateur ne sont jamais une preuve. Lecture pure d'un en-tête binaire :
 *
 * - JPEG : `FF D8 FF`
 * - PNG : `89 50 4E 47 0D 0A 1A 0A`
 * - WebP : `RIFF····WEBP` (header RIFF, fourcc WEBP)
 * - AVIF : boîte `ftyp` ISO-BMFF avec marque `avif`/`avis` (heic etc.
 *   exclus — pas des images acceptées en V1)
 *
 * Le type déclaré par le client doit être **cohérent** avec le type réel
 * (mission §10) ; le type réel devient la valeur stockée.
 */

export type DetectedImageMime = KreizMediaAcceptedMime;

/** Détecte le type réel du contenu, ou `null` si rien ne correspond. */
/** Accès indexé sûr (noUncheckedIndexedAccess) — -1 si hors bornes. */
function byteAt(bytes: Uint8Array, index: number): number {
  return bytes[index] ?? -1;
}

export function detectImageMime(bytes: Uint8Array): DetectedImageMime | null {
  if (bytes.length < 12) return null;

  if (byteAt(bytes, 0) === 0xff && byteAt(bytes, 1) === 0xd8 && byteAt(bytes, 2) === 0xff) {
    return 'image/jpeg';
  }

  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (pngSignature.every((value, index) => byteAt(bytes, index) === value)) {
    return 'image/png';
  }

  if (
    byteAt(bytes, 0) === 0x52 && // R
    byteAt(bytes, 1) === 0x49 && // I
    byteAt(bytes, 2) === 0x46 && // F
    byteAt(bytes, 3) === 0x46 && // F
    byteAt(bytes, 8) === 0x57 && // W
    byteAt(bytes, 9) === 0x45 && // E
    byteAt(bytes, 10) === 0x42 && // B
    byteAt(bytes, 11) === 0x50 // P
  ) {
    return 'image/webp';
  }

  // ISO-BMFF : taille de boîte (4 octets) + 'ftyp' + marque de marque.
  if (
    byteAt(bytes, 4) === 0x66 && // f
    byteAt(bytes, 5) === 0x74 && // t
    byteAt(bytes, 6) === 0x79 && // y
    byteAt(bytes, 7) === 0x70 // p
  ) {
    const brand = String.fromCharCode(byteAt(bytes, 8), byteAt(bytes, 9), byteAt(bytes, 10), byteAt(bytes, 11));
    if (brand === 'avif' || brand === 'avis') {
      return 'image/avif';
    }
  }

  return null;
}
