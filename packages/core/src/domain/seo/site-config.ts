import { z } from 'zod';

/**
 * Configuration SEO **du site** — déclarée en code par le Project
 * (cadrage §15, mission slice 9 §5/§34) et revalidée par le schéma de
 * `kreiz({ seo })`. Elle porte les **défauts** de la résolution publique :
 * nom du site, URL de base canonique, gabarit de titre, description par
 * défaut, image OG de repli, politique robots.
 *
 * La base canonique vient **exclusivement** de cette configuration (mission
 * §35) — jamais d'un en-tête `Host`, forgeable par le client. Elle est
 * validée ici (URL absolue http/https, sans query ni fragment, slash final
 * retiré) : une configuration fausse est une erreur au chargement, jamais
 * un canonical forgé au rendu.
 *
 * Ordre de résolution documenté (mission §5) :
 *
 *     défauts Project → valeurs dérivées du contenu → overrides SEO explicites
 *
 * (l'override explicite gagne toujours ; le défaut Project n'est utilisé
 * qu'en l'absence de valeur dérivée — voir `resolve.ts`).
 */

export const SEO_SITE_NAME_MAX_LENGTH = 120;
export const SEO_TITLE_TEMPLATE_MAX_LENGTH = 200;
export const SEO_DESCRIPTION_MAX_LENGTH = 300;
export const SEO_SITEMAP_EXTRA_PATH_MAX_COUNT = 100;
export const SEO_SITEMAP_EXTRA_PATH_MAX_LENGTH = 512;

/** Handle X/Twitter : 1–15 caractères alphanumériques/underscore. */
const TWITTER_HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
/** Tag de langue BCP-47 léger (`fr`, `fr-FR`) pour `og:locale` — aucun moteur multilingue. */
const SEO_LOCALE_PATTERN = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/;

/**
 * Chemin additionnel du sitemap — page **statique du Project** (accueil,
 * contact…). Visible ASCII sans espace ni crochet, commencement `/`, jamais
 * de montée `..` ni de protocol-relative `//` : le sitemap n'encode jamais
 * une URL forgée.
 */
export function isSitemapExtraPath(value: string): boolean {
  if (value.length === 0 || value.length > SEO_SITEMAP_EXTRA_PATH_MAX_LENGTH) return false;
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  if (/[\r\n\0<>"'\\^{}`]/.test(value)) return false;
  if (value.includes('..')) return false;
  if (value.includes('?') || value.includes('#')) return false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x21 || code === 0x7f) return false;
  }
  return true;
}

/** URL absolue http(s) — schéma fermé (jamais `javascript:`/`data:`/relatif). */
export function isAbsoluteHttpUrl(value: string): boolean {
  if (value.length === 0 || value.length > 2048) return false;
  if (/[\r\n\0<>"'^`\\\s]/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' || url.protocol === 'http:';
}

/**
 * Normalise l'URL de base canonique : protocole fermé http/https, query et
 * fragment interdits (une base avec query produirait des canonical
 * non canoniques), slash final retiré (`/` racine compris).
 */
export function normalizeSiteUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `@kreiz/core : configuration SEO invalide — siteUrl « ${trimmed.slice(0, 100)} » n'est pas une URL absolue valide.`,
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(
      '@kreiz/core : configuration SEO invalide — siteUrl doit être une URL http(s) absolue (schéma fermé, jamais javascript:/data:).',
    );
  }
  if (url.search || url.hash) {
    throw new Error(
      '@kreiz/core : configuration SEO invalide — siteUrl ne doit porter ni query ni fragment (la base canonique est une origine [+ chemin], propre).',
    );
  }
  return (url.origin + url.pathname).replace(/\/+$/, '');
}

/**
 * Normalise le handle X/Twitter : accepte `@handle` ou l'URL d'un profil
 * twitter.com/x.com — stocke toujours `@handle` (forme idempotente,
 * revalidable telle quelle).
 */
export function normalizeTwitterSite(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('@')) {
    return TWITTER_HANDLE_PATTERN.test(trimmed.slice(1)) ? trimmed : null;
  }
  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./, '');
    if ((host === 'twitter.com' || host === 'x.com') && url.protocol === 'https:') {
      const handle = url.pathname.split('/').filter(Boolean).at(0) ?? '';
      return TWITTER_HANDLE_PATTERN.test(handle) ? `@${handle}` : null;
    }
  } catch {
    // URL absente ou malformée → null (géré comme rejet par le schéma).
  }
  return null;
}

const seoOrganizationSchema = z.strictObject({
  name: z.string().trim().min(1).max(SEO_SITE_NAME_MAX_LENGTH),
  url: z.string().refine(isAbsoluteHttpUrl, 'URL http(s) absolue attendue').nullish(),
  logoUrl: z.string().refine(isAbsoluteHttpUrl, 'URL http(s) absolue attendue').nullish(),
});

/**
 * Schéma d'entrée de la configuration SEO Project — partagé par
 * `defineSeoSiteConfig` et `kreiz({ seo })`. Les champs sont `nullish` :
 * la **forme résolue** (champs absents = `null`, voir `SeoSiteConfig`)
 * repasse telle quelle dans ce schéma — la revalidation est idempotente,
 * comme pour les types de contenu.
 */
export const seoSiteInputSchema = z.strictObject({
  siteName: z.string().trim().min(1).max(SEO_SITE_NAME_MAX_LENGTH),
  siteUrl: z
    .string()
    .min(1)
    .transform((value, ctx) => {
      try {
        return normalizeSiteUrl(value);
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: (error as Error).message });
        return z.NEVER;
      }
    }),
  /**
   * Gabarit de titre — doit contenir exactement un `%s` (ex. `%s | Mon site`).
   * Absent : `%s | siteName`. Le rendu évite de lui-même le double nom de
   * site (voir `resolve.ts`).
   */
  titleTemplate: z
    .string()
    .trim()
    .min(1)
    .max(SEO_TITLE_TEMPLATE_MAX_LENGTH)
    .refine((value) => value.split('%s').length === 2, 'le gabarit doit contenir exactement un « %s »')
    .nullish(),
  defaultDescription: z.string().trim().min(1).max(SEO_DESCRIPTION_MAX_LENGTH).nullish(),
  defaultOgImageUrl: z.string().refine(isAbsoluteHttpUrl, 'URL http(s) absolue attendue').nullish(),
  twitterSite: z
    .string()
    .transform((value, ctx) => {
      const normalized = normalizeTwitterSite(value);
      if (normalized === null) {
        ctx.addIssue({
          code: 'custom',
          message: 'handle X/Twitter invalide (@handle ou URL https de profil twitter.com/x.com)',
        });
        return z.NEVER;
      }
      return normalized;
    })
    .nullish(),
  locale: z
    .string()
    .refine((value) => SEO_LOCALE_PATTERN.test(value.trim()), 'tag de langue invalide (ex. fr-FR)')
    .nullish(),
  organization: seoOrganizationSchema.nullish(),
  sitemap: z
    .strictObject({
      /** Pages statiques du Project à ajouter au sitemap (accueil, contact…). */
      extraPaths: z
        .array(z.string().refine(isSitemapExtraPath, 'chemin invalide (commence par « / », ASCII visible, sans « .. » ni query)'))
        .max(SEO_SITEMAP_EXTRA_PATH_MAX_COUNT)
        .nullish(),
    })
    .nullish(),
});

/** Entrée brute acceptée (avant normalisation) — forme du littéral Project. */
export type SeoSiteConfigInput = z.input<typeof seoSiteInputSchema>;

/**
 * Configuration SEO **résolue** — forme normalisée (défauts appliqués,
 * `siteUrl` sans slash final, handle `@…`), sérialisable vers le module
 * virtuel et réinjectable telle quelle dans `kreiz({ seo })`.
 */
export interface SeoSiteConfig {
  readonly siteName: string;
  /** Base canonique fiable — jamais l'en-tête Host (mission §35). */
  readonly siteUrl: string;
  /** Gabarit de titre (contient exactement un `%s`). */
  readonly titleTemplate: string;
  readonly defaultDescription: string | null;
  readonly defaultOgImageUrl: string | null;
  readonly twitterSite: string | null;
  /** Tag `og:locale`, ou `null` — le Core n'a pas d'autre notion de locale. */
  readonly locale: string | null;
  readonly organization: Readonly<{ name: string; url: string | null; logoUrl: string | null }> | null;
  /** Chemins statiques du Project ajoutés au sitemap (`/…`, normalisés). */
  readonly sitemap: { readonly extraPaths: readonly string[] };
}

/**
 * Déclare la configuration SEO du site — validation **à la définition**
 * (fail fast au chargement du module Project, même contrat que
 * `defineContentType`). Retourne la forme normalisée : la même constante
 * est passée à `kreiz({ seo })` (revalidation idempotente) et aux helpers
 * de résolution des templates (`@kreiz/core/seo`).
 */
export function defineSeoSiteConfig(input: SeoSiteConfigInput): SeoSiteConfig {
  return resolveSeoSiteConfig(input);
}

/** Résout/normalise une configuration SEO brute — erreurs FR explicites. */
export function resolveSeoSiteConfig(input: unknown): SeoSiteConfig {
  const parsed = seoSiteInputSchema.safeParse(input ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(racine)'} : ${issue.message}`)
      .join(' ; ');
    throw new Error(`@kreiz/core : configuration SEO invalide — ${issues}.`);
  }
  const data = parsed.data;
  return {
    siteName: data.siteName,
    siteUrl: data.siteUrl,
    titleTemplate: data.titleTemplate ?? `%s | ${data.siteName}`,
    defaultDescription: data.defaultDescription ?? null,
    defaultOgImageUrl: data.defaultOgImageUrl ?? null,
    twitterSite: data.twitterSite ?? null,
    locale: data.locale?.trim() ?? null,
    organization: data.organization
      ? {
          name: data.organization.name,
          url: data.organization.url ?? null,
          logoUrl: data.organization.logoUrl ?? null,
        }
      : null,
    sitemap: {
      extraPaths: data.sitemap?.extraPaths ?? [],
    },
  };
}
