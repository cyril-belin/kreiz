import { z } from 'zod';

/**
 * Configuration fournie par l'application consommatrice à l'intégration Astro.
 *
 * Slice 0 : uniquement la section du spike. Les slices suivants y ajouteront
 * les sections documentées du cadrage (types de contenu, médias, rebuild,
 * formulaires, analytics…). Toute clé inconnue est rejetée : la configuration
 * n'est jamais silencieusement ignorée.
 */
export const kreizConfigSchema = z.strictObject({
  spike: z
    .strictObject({
      message: z.string().min(1),
    })
    .optional(),
});

export type KreizConfig = z.infer<typeof kreizConfigSchema>;

export function normalizeKreizConfig(input: unknown): KreizConfig {
  return kreizConfigSchema.parse(input ?? {});
}
