import { z } from 'zod';

/**
 * SEO **d'un contenu** — forme validée du JSONB `kreiz_content_entries.seo`
 * (et de son snapshot `published_seo`). Le JSONB est la source : aucune
 * nouvelle colonne n'est nécessaire (mission slice 9 §4/§37) — le type
 * métier vit dans `data/tables/content-entries.ts`, ce module porte le
 * **schéma de validation** et les bornes.
 *
 * Clés plates en camelCase (convention JSONB existante), toutes optionnelles
 * : un SEO vide `{}` est l'état par défaut de tout contenu. Clés inconnues
 * rejetées (strictObject) — le JSONB n'est jamais un sac arbitraire.
 *
 * L'image Open Graph est une **référence média stable** (`ogImageMediaId`)
 * — jamais une URL S3 ni une URL présignée (mission §12) ; sa suppression
 * est gardée par le comptage de références du repository médias.
 *
 * `noindex`/`nofollow` : la politique robots d'un contenu publié. Les
 * routes système (admin, preview, API) ne passent jamais par ce modèle —
 * elles sont exclues de l'indexation par construction (robots.txt, headers).
 */

/** Bornes « raisonnables, sans score SEO » (mission §6/§7) : le title SEO
 * est un override court ; la description tient dans un extrait affichable. */
export const SEO_TITLE_MAX_LENGTH = 120;
export const SEO_DESCRIPTION_MAX_LENGTH = 300;
export const SEO_OG_TITLE_MAX_LENGTH = 120;
export const SEO_OG_DESCRIPTION_MAX_LENGTH = 300;
export const SEO_CANONICAL_OVERRIDE_MAX_LENGTH = 2048;

/** Longueur maximale du title rendu par le gabarit — au-delà, le gabarit
 * est écarté au profit du titre brut (borné par la validation du contenu). */
export const SEO_RENDERED_TITLE_MAX_LENGTH = 200;

/** Format UUID des colonnes uuid — un id non conforme est « absent », jamais une erreur SQL. */
export const SEO_MEDIA_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Forme d'un override canonique : soit un chemin interne (`/…`, résolu sur
 * la base fiable), soit une URL absolue **http(s)** — tout autre schéma
 * (`javascript:`, `data:`, …) est rejeté ici, avant même la vérification
 * d'origine de la résolution (mission §8/§41).
 */
export function isCanonicalOverrideShape(value: string): boolean {
  if (value.length === 0 || value.length > SEO_CANONICAL_OVERRIDE_MAX_LENGTH) return false;
  if (/[\r\n\0]/.test(value)) return false;
  if (value.startsWith('/')) {
    if (value.startsWith('//') || value.includes('\\')) return false;
    // Jamais de montée de chemin : un override ne peut pas sortir du site.
    return !value.includes('..');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' || url.protocol === 'http:';
}

/** Schéma du JSONB `seo` — appliqué au Save et revalidé au Publish. */
export const contentSeoSchema = z.strictObject({
  /** Title SEO spécifique (override du titre du contenu). */
  title: z.string().trim().min(1).max(SEO_TITLE_MAX_LENGTH).optional(),
  /** Meta description spécifique — texte pur, le rendu échappe tout. */
  description: z.string().trim().min(1).max(SEO_DESCRIPTION_MAX_LENGTH).optional(),
  /** Override canonique — chemin interne ou URL absolue même origine (service). */
  canonicalOverride: z
    .string()
    .trim()
    .refine(isCanonicalOverrideShape, 'canonical invalide — chemin interne ou URL http(s) absolue attendu')
    .optional(),
  /** Image Open Graph — référence média stable (jamais d'URL brute). */
  ogImageMediaId: z.string().regex(SEO_MEDIA_ID_PATTERN, 'identifiant de média invalide').optional(),
  /** Overrides Open Graph (fallback : OG → titre/description résolus). */
  ogTitle: z.string().trim().min(1).max(SEO_OG_TITLE_MAX_LENGTH).optional(),
  ogDescription: z.string().trim().min(1).max(SEO_OG_DESCRIPTION_MAX_LENGTH).optional(),
  /** Politique robots du contenu publié (défaut : index, follow). */
  noindex: z.boolean().optional(),
  nofollow: z.boolean().optional(),
});

/** SEO de contenu validé — même forme que `KreizContentSeo` (tables). */
export type ValidatedContentSeo = z.output<typeof contentSeoSchema>;

/** Clés du JSONB `seo`, pour la cartographie vers les erreurs de formulaire. */
export const CONTENT_SEO_FIELD_KEYS = [
  'title',
  'description',
  'canonicalOverride',
  'ogImageMediaId',
  'ogTitle',
  'ogDescription',
  'noindex',
  'nofollow',
] as const;

/**
 * Valide et normalise un SEO de contenu brut (JSONB ou formulaire) —
 * `undefined` conservé tel quel (absence = ne pas toucher), clés vides
 * rejetées (un champ vide se **retire**, il ne se stocke pas vide).
 */
export function parseContentSeo(value: unknown): { ok: true; seo: ValidatedContentSeo } | { ok: false } {
  if (value === undefined) return { ok: false };
  const parsed = contentSeoSchema.safeParse(value);
  return parsed.success ? { ok: true, seo: parsed.data } : { ok: false };
}
