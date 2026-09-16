import { z } from 'zod';
import {
  ANALYTICS_RETENTION_DEFAULT_DAYS,
  ANALYTICS_RETENTION_MAX_DAYS,
  ANALYTICS_RETENTION_MIN_DAYS,
} from './policy.js';

/**
 * Configuration analytics déclarée par le Project (slice 8) — revalidée au
 * chargement de la config (fail fast, même traitement que les types de
 * contenu et les formulaires). Défauts **privacy-safe** : activé (mesure
 * sans cookie ni PII), signaux DNT/GPC respectés, rétention 90 jours,
 * aucun chemin exclus supplémentaire, aucun domaine interne supplémentaire.
 */

/** Préfixe de chemin exclusif déclaré — forme validée d'un préfixe d'URL interne. */
const excludedPathSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.startsWith('/') && !value.startsWith('//'), 'préfixe requis (commence par « / »)')
  .refine((value) => !/[\r\n\0?#]/.test(value), 'préfixe de chemin invalide')
  .refine((value) => value === '/' || !value.endsWith('/'), 'préfixe sans slash final');

/** Domaine interne déclaré — forme hostname (comparaison insensible à la casse). */
const internalDomainSchema = z
  .string()
  .min(3)
  .max(253)
  .refine((value) => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(value.toLowerCase()), 'domaine invalide');

export const analyticsDeclarationSchema = z.strictObject({
  /** Collecte activée — `false` : endpoint muet (aucun stockage), beacon stub. */
  enabled: z.boolean().default(true),
  /** Purge des événements plus vieux que N jours (purge opportuniste + cron futur). */
  retentionDays: z
    .number()
    .int()
    .min(ANALYTICS_RETENTION_MIN_DAYS)
    .max(ANALYTICS_RETENTION_MAX_DAYS)
    .default(ANALYTICS_RETENTION_DEFAULT_DAYS),
  /** DNT / GPC ⇒ aucune collecte (politique conservative par défaut). */
  respectPrivacySignals: z.boolean().default(true),
  /** Préfixes exclus supplémentaires (routes privées du Project). */
  excludedPaths: z.array(excludedPathSchema).max(20).default([]),
  /** Domaines traités comme navigation interne pour la classification des referrers. */
  internalDomains: z.array(internalDomainSchema).max(20).default([]),
});

/** Configuration analytics résolue — forme sérialisée vers le module virtuel. */
export type KreizAnalyticsConfig = z.infer<typeof analyticsDeclarationSchema>;

export function resolveAnalyticsConfig(input: unknown): KreizAnalyticsConfig {
  return analyticsDeclarationSchema.parse(input ?? {});
}
