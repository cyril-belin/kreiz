/**
 * Clés d'objets storage (mission §6) — **générées**, jamais dérivées du nom
 * de fichier utilisateur : pas de traversal, pas de collision, pas de
 * caractères spéciaux. Le nom original, s'il est un jour utile, resterait
 * une metadata informative côté application — il ne structure jamais le
 * stockage.
 *
 * Format V1 :
 *
 * ```text
 * media/{mediaId}/original        — original privé (jamais d'URL publique)
 * media/{mediaId}/{width}.webp    — variantes publiques
 * media/{mediaId}/{width}.avif
 * ```
 *
 * Les clés sont immuables (mission §40) : une variante régénérée par un
 * retry écrit la même clé **seulement** tant que le média n'a jamais été
 * `ready` (donc jamais servi publiquement — aucun cache à invalider). Les
 * variantes portent `Cache-Control: public, max-age=31536000, immutable`.
 */

const SAFE_KEY_PATTERN = /^[a-z0-9][a-z0-9-_.\/]*$/;

/** Garde défensive : toute clé émise ici est sûre par construction. */
function assertSafeKey(key: string): string {
  // `..` est refusé même si tous ses caractères sont sinon autorisés —
  // pas de traversal, jamais (mission §6).
  if (!SAFE_KEY_PATTERN.test(key) || key.includes('..')) {
    throw new Error(`@kreiz/core : clé de stockage invalide « ${key} ».`);
  }
  return key;
}

/** Clé de l'original — privé (mission §42/§43 : jamais servi publiquement). */
export function mediaOriginalKey(mediaId: string): string {
  return assertSafeKey(`media/${mediaId}/original`);
}

/** Clé d'une variante — publique (CDN), immuable, extensible en suffixe. */
export function mediaVariantKey(mediaId: string, width: number, format: string): string {
  const normalizedFormat = format.replace(/^image\//, '');
  return assertSafeKey(`media/${mediaId}/${width}.${normalizedFormat}`);
}

/**
 * Objets d'un média à supprimer avec lui (mission §23/§26) : original +
 * variantes connues. Les variantes viennent de la ligne DB — un objet
 * orphelin (variante écrite puis échec avant markReady) est couvert par la
 * même liste : la suppression passe par le préfixe du média quand l'adapter
 * le permet, sinon par les clés listées + original.
 */
export function mediaObjectKeys(mediaId: string, variantKeys: readonly string[]): string[] {
  return [mediaOriginalKey(mediaId), ...variantKeys];
}
