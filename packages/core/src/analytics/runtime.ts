import config from 'virtual:kreiz/config';
import type { KreizAnalyticsConfig } from '../domain/analytics/config.js';

/**
 * Configuration analytics runtime — lecture memoïsée du module virtuel
 * (forme sérialisée, défauts privacy-safe déjà appliqués par
 * `normalizeKreizConfig`). Ce module n'est importable **que** dans un
 * contexte Vite/Astro ; les services et tests reçoivent la configuration
 * injectée.
 */
export function getAnalyticsConfig(): KreizAnalyticsConfig {
  return config.analytics;
}
