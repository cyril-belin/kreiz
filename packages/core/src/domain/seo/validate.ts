import { contentSeoSchema, type ValidatedContentSeo } from './content-seo.js';

/**
 * Validation SEO **côté services** (mission slice 9 §21) — le parseur de
 * formulaire structure, ce module valide : bornes, formats, clés inconnues.
 * Les erreurs sont affichables et posées **par champ de formulaire**
 * (`seo_title`, `seo_description`, `seo_canonical`, `seo_og_image`,
 * `seo_og_title`, `seo_og_description`) — même convention que les autres
 * champs système (titre, slug, couverture). Pur domaine : aucune dépendance
 * vers les services (type structurellement identique à `ContentFieldErrors`).
 */

/** Erreurs par champ de formulaire — même forme que `ContentFieldErrors`. */
export type SeoFieldErrors = Record<string, string>;

/** Clé JSONB → clé de champ de formulaire. */
export const CONTENT_SEO_FORM_ERROR_KEYS: Readonly<Record<string, string>> = {
  title: 'seo_title',
  description: 'seo_description',
  canonicalOverride: 'seo_canonical',
  ogImageMediaId: 'seo_og_image',
  ogTitle: 'seo_og_title',
  ogDescription: 'seo_og_description',
  noindex: '_form',
  nofollow: '_form',
};

/** Messages français pour les issues Zod du schéma SEO (même vocabulaire que le moteur de contenu). */
function seoIssueMessage(issue: { code: string; message: string; minimum?: number | bigint; maximum?: number | bigint }): string {
  switch (issue.code) {
    case 'unrecognized_keys':
      return 'Champ SEO non autorisé.';
    case 'too_small': {
      if (issue.minimum === 1) return 'Ce champ est requis (ou laissez-le vide).';
      return `Doit contenir au moins ${String(issue.minimum)} caractères.`;
    }
    case 'too_big':
      return `Doit contenir au plus ${String(issue.maximum)} caractères.`;
    default:
      return issue.message;
  }
}

/**
 * Valide un SEO de contenu brut et remplit `errors` par champ. Retourne le
 * SEO validé, ou `null` (au moins une erreur posée). Les champs booléens
 * (`noindex`/`nofollow`) ne peuvent pas être invalides — une issue les
 * concernant serait une corruption de formulaire : erreur générale.
 */
export function validateContentSeoFields(value: unknown, errors: SeoFieldErrors): ValidatedContentSeo | null {
  const parsed = contentSeoSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) {
    const key = issue.path[0];
    const formKey =
      typeof key === 'string' ? CONTENT_SEO_FORM_ERROR_KEYS[key] ?? '_form' : '_form';
    errors[formKey] ??= seoIssueMessage(issue);
  }
  return null;
}
