/**
 * Règles pures des slugs (mission §11) — aucune I/O : la collision en base
 * est vérifiée par le service via le repository ; ici, uniquement la
 * normalisation, les bornes et le suffixage déterministe.
 *
 * Décisions de comportement (documentées dans docs/slices/slice-3.md) :
 * - slug auto à la création depuis le titre, éditable ensuite — une édition
 *   ne régénère jamais le slug ;
 * - suffixage automatique `foo`, `foo-2`, `foo-3` **uniquement pour les
 *   slugs générés** ; un slug saisi manuellement en collision est une erreur
 *   (le choix explicite d'un admin ne doit pas être modifié en silence) ;
 * - soft-deleted libère le slug (index unique partiel côté DB) ;
 * - pas de redirection au changement de slug : slice 4 (ce slice ne
 *   publie pas, un changement de slug de draft n'a aucun effet public).
 */

export const SLUG_MAX_LENGTH = 120;
/** Repli quand le titre ne produit aucun caractère sluggable (ex. « ??? »). */
export const SLUG_FALLBACK = 'contenu';
/** Nombre maximal de candidats testés contre la base avant abandon. */
export const SLUG_MAX_SUFFIX_ATTEMPTS = 50;

/**
 * Normalise un texte en slug : Unicode NFKD (suppression des diacritiques :
 * é → e, œ → oe via translittération raisonnable), minuscules, séparateurs
 * cohérents, caractères invalides supprimés, tirets compacts, borné à
 * `SLUG_MAX_LENGTH`. Retourne `''` si aucun caractère sluggable —
 * l'appelant applique le repli (`SLUG_FALLBACK`) ou signale l'erreur pour
 * une saisie manuelle.
 */
export function slugify(input: string): string {
  const normalized = input
    .normalize('NFKD')
    // Diacritiques : les marques combinantes sont retirées après décomposition.
    .replace(/[\u0300-\u036f]/g, '')
    // Ligatures et ponctuations courantes qui survivent à NFKD.
    .replace(/œ/g, 'oe')
    .replace(/Œ/g, 'Oe')
    .replace(/æ/g, 'ae')
    .replace(/Æ/g, 'Ae')
    .replace(/ß/g, 'ss')
    .replace(/ø/g, 'o')
    .replace(/Ø/g, 'O')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .replace(/ħ/g, 'h')
    .replace(/Ħ/g, 'H')
    .replace(/ŧ/g, 't')
    .replace(/Ŧ/g, 'T')
    .toLowerCase()
    // Tout ce qui n'est pas alphanumérique devient un séparateur.
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (normalized.length <= SLUG_MAX_LENGTH) return normalized;
  // Troncature sans terminer par un tiret.
  return normalized.slice(0, SLUG_MAX_LENGTH).replace(/-+$/g, '');
}

/**
 * Normalise un slug **saisi manuellement** : le même pipeline que
 * `slugify` — un admin peut taper « Mon Super Article ! » et obtenir
 * `mon-super-article` sans devoir connaître les règles. Une saisie qui ne
 * produit rien de valide est rejetée par l'appelant (erreur de validation),
 * jamais silencieusement remplacée.
 */
export function normalizeSlugInput(input: string): string {
  return slugify(input);
}

/**
 * Candidats successifs pour un slug de base : `foo`, `foo-2`, `foo-3`…
 * Le premier candidat est le slug non suffixé (la première occurrence ne
 * porte jamais de suffixe). Générateur borné : l'appelant (service) limite
 * les tentatives et la course concurrentielle finale est arbitraire par
 * l'index unique PostgreSQL (23505 → candidat suivant).
 */
export function* slugCandidates(base: string): Generator<string> {
  let suffix = 1;
  while (suffix <= SLUG_MAX_SUFFIX_ATTEMPTS + 1) {
    // La base est bornée par `slugify`, mais le suffixe la rallonge : on
    // tronque la partie variable pour respecter `SLUG_MAX_LENGTH` (cohérence
    // avec la borne des slugs saisis manuellement — revue sécurité finale).
    if (suffix === 1) {
      yield base;
    } else {
      const stem = base.slice(0, SLUG_MAX_LENGTH - String(suffix).length - 1).replace(/-+$/g, '');
      yield `${stem}-${suffix}`;
    }
    suffix += 1;
  }
}

/**
 * Résout un slug **généré** : teste les candidats contre `exists` (le
 * repository vérifie dans le namespace, actifs uniquement — même sémantique
 * que l'index unique partiel) et retourne le premier libre.
 * Retourne `null` si tous les candidats sont pris (irréaliste mais borné).
 */
export async function resolveGeneratedSlug(
  base: string,
  exists: (slug: string) => Promise<boolean>,
): Promise<string | null> {
  for (const candidate of slugCandidates(base)) {
    if (!(await exists(candidate))) return candidate;
  }
  return null;
}
