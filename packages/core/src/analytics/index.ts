/**
 * API publique des analytics — sous-chemin `@kreiz/core/analytics` (slice
 * 8). C'est ici que le Project mesure son site public : le tag du beacon,
 * les points d'instrumentation (CTA) et les types de configuration.
 *
 * Ne sont **pas** exposés : repositories, agrégations SQL, service de
 * collecte, admin internals — le dashboard reste une page du Core, la
 * collecte une primitive interne.
 */

// Chemins publics (constantes canoniques des routes injectées)
export {
  PUBLIC_ANALYTICS_BEACON_PATTERN as ANALYTICS_BEACON_PATH,
  PUBLIC_ANALYTICS_EVENT_PATTERN as ANALYTICS_COLLECT_PATH,
} from '../http/admin-routes.js';

// Beacon — tag HTML prêt à insérer (`set:html`) + source pure (tests, mesure de poids)
export { analyticsBeaconScript, beaconModuleSource } from './beacon-source.js';

// Instrumentation CTA — attribut `data-kz-cta` typé et borné
export { analyticsCtaAttributes, ANALYTICS_CTA_ATTRIBUTE } from './cta.js';

// Configuration Project — type résolu (défauts privacy-safe appliqués)
export type { KreizAnalyticsConfig } from '../domain/analytics/config.js';

// Vocabulaire fermé des événements (utile aux dashboards du Project sans dupliquer l'union)
export {
  kreizAnalyticsEventNames,
  kreizClientAnalyticsEventNames,
  kreizServerAnalyticsEventNames,
  type KreizAnalyticsEventName,
} from '../data/tables/analytics-events.js';
export { kreizDeviceClasses, type KreizDeviceClass } from '../data/tables/analytics-events.js';
