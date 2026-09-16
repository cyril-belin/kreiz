import { ANALYTICS_CTA_ID_MAX_LENGTH, normalizeCtaId } from '../domain/analytics/policy.js';

/**
 * Instrumentation CTA (slice 8) — attribut `data-kz-cta` posé par le beacon
 * sur les éléments cliquables que le Project veut compter
 * (`cta_click`). Attribut **déclaratif, sans JavaScript du Project** : le
 * beacon délègue un seul écouteur sur `document`.
 */

export const ANALYTICS_CTA_ATTRIBUTE = 'data-kz-cta';

/** Attributs à délayer sur l'élément CTA — identifiant borné et assaini. */
export function analyticsCtaAttributes(id: string): Record<string, string> {
  const value = normalizeCtaId(id) ?? id.slice(0, ANALYTICS_CTA_ID_MAX_LENGTH);
  return { [ANALYTICS_CTA_ATTRIBUTE]: value };
}
