import { normalizeCtaId } from '../domain/analytics/policy.js';

/**
 * Instrumentation CTA (slice 8) — attribut `data-kz-cta` posé par le beacon
 * sur les éléments cliquables que le Project veut compter
 * (`cta_click`). Attribut **déclaratif, sans JavaScript du Project** : le
 * beacon délègue un seul écouteur sur `document`.
 */

export const ANALYTICS_CTA_ATTRIBUTE = 'data-kz-cta';

/** Attributs à délayer sur l'élément CTA — identifiant borné et assaini.
 * Un id non normalisable (vide, caractères de contrôle, trop long) ne
 * produit **aucun** attribut (revue sécurité finale : jamais de valeur
 * brute non assainie délayée dans le DOM du Project). */
export function analyticsCtaAttributes(id: string): Record<string, string> {
  const value = normalizeCtaId(id);
  return value === null ? {} : { [ANALYTICS_CTA_ATTRIBUTE]: value };
}
