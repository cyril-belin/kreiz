import type { KreizContentSeo } from '../../data/tables/content-entries.js';
import type { PublicMediaView } from '../media/view-model.js';
import { publicPath } from '../content/redirect-engine.js';
import { richTextDocumentToPlainText } from './description.js';
import {
  SEO_DESCRIPTION_MAX_LENGTH,
  SEO_RENDERED_TITLE_MAX_LENGTH,
} from './content-seo.js';
import type { SeoSiteConfig } from './site-config.js';

/**
 * Résolution SEO **pure et déterministe** (mission slice 9 §17) — la
 * représentation publique finale d'une page, dérivée de données
 * structurées (jamais du HTML arbitraire) :
 *
 *     défauts Project → valeurs dérivées du contenu → overrides SEO explicites
 *
 * L'override explicite (`seo` du contenu) gagne toujours ; les valeurs
 * dérivées (titre du contenu, texte du rich text, couverture) comblent
 * les absences ; les défauts Project ferment la chaîne. Mêmes entrées ⇒
 * même sortie, octet pour octet — le build la consomme, jamais une
 * requête.
 */

/** Image OG résolue — URL absolue + dimensions/alt quand un média les porte. */
export interface SeoResolvedImage {
  readonly url: string;
  readonly width?: number;
  readonly height?: number;
  readonly alt?: string;
}

/** Vue SEO finale — consommée par `seoHeadTags()` et les templates. */
export interface ResolvedSeoViewModel {
  /** Title complet (gabarit appliqué, jamais double nom de site). */
  readonly title: string;
  /** Description finale, ou `null` — un meta vide n'est jamais émis. */
  readonly description: string | null;
  /** URL canonique absolue, ou `null` (noindex, ou override invalide écarté). */
  readonly canonical: string | null;
  readonly robots: { readonly index: boolean; readonly follow: boolean };
  readonly og: {
    readonly title: string;
    readonly description: string | null;
    readonly url: string | null;
    readonly type: string;
    readonly siteName: string | null;
    readonly locale: string | null;
    readonly image: SeoResolvedImage | null;
  };
  /** Twitter/X — minimal : card + handle ; le reste retombe sur l'OG. */
  readonly twitter: { readonly card: string; readonly site: string | null };
  /** Données structurées validées (builders typés du Core), émises en JSON-LD. */
  readonly jsonLd: readonly object[];
}

export interface SeoResolutionRequest {
  /** Chemin public (`/articles/slug`, `/` pour l'accueil) — base du canonical. */
  readonly path: string;
  /** Titre dérivé (titre du contenu / de la page) — la base du title. */
  readonly title: string;
  /** Description dérivée (champ d'accroche du Project, texte du rich text…). */
  readonly description?: string | null;
  /** Image dérivée (couverture publiée) — après l'image OG explicite. */
  readonly image?: SeoResolvedImage | null;
  /** `og:type` mappé par le Project (déclaration → `article`…). Défaut `website`. */
  readonly ogType?: string;
  /** Overrides SEO explicites — gagnent sur tout ce qui précède. */
  readonly seo?: KreizContentSeo | null;
  /** Données structurées construites par le template (builders typés). */
  readonly jsonLd?: readonly object[];
}

export interface ContentSeoOptions {
  /** Mapping `og:type` choisi par le Project (mission §33) — ex. `article`. */
  readonly ogType?: string;
  /**
   * Description dérivée par le Project (ex. son champ d'accroche déclaré) —
   * prioritaire sur le repli générique « texte du rich text », après
   * l'override SEO explicite.
   */
  readonly description?: string | null;
  /** Données structurées du template (BreadcrumbList, Article…). */
  readonly jsonLd?: readonly object[];
}

/** Segments de texte séparés par un espace unique, whitespace normalisé. */
function normalizeDescriptionText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Tronque **sur une frontière de mot** à la borne (aucun caractère ajouté,
 * aucune coupure au milieu d'un mot) — déterministe, sans score SEO.
 */
function truncateDescription(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const slice = value.slice(0, maxLength);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trimEnd();
}

/**
 * Title résolu : override SEO → titre dérivé, puis gabarit — **sauf** si le
 * titre porte déjà le nom du site (jamais de double site name, mission §6)
 * ou est le nom du site lui-même ; un gabarit produisant un title démesuré
 * est écarté (le titre brut borné par la validation reste servi).
 */
export function resolveSeoTitle(site: SeoSiteConfig, derivedTitle: string, seoTitle?: string | null): string {
  const base = normalizeDescriptionText(seoTitle ?? derivedTitle);
  if (base.length === 0) return site.siteName;
  if (base === site.siteName || base.includes(site.siteName)) return base;
  const rendered = site.titleTemplate.replace('%s', base);
  return rendered.length <= SEO_RENDERED_TITLE_MAX_LENGTH ? rendered : base;
}

/**
 * Canonical stricte (mission §8) : absolue, construite sur la base fiable,
 * query et fragment systématiquement retirés, slash final normalisé (la
 * racine garde le sien). Un override absolu hors origine ou malformé est
 * **écarté** (canonical omise) — jamais rendu, jamais une erreur 500 au
 * build : la validation au Save/Publish est la barrière normale, ceci est
 * la défense en profondeur du rendu.
 */
export function resolveSeoCanonical(site: SeoSiteConfig, path: string, canonicalOverride?: string | null, noindex?: boolean): string | null {
  if (noindex) return null;
  if (canonicalOverride && canonicalOverride.length > 0) {
    if (canonicalOverride.startsWith('/')) {
      const normalized = normalizeSeoPath(canonicalOverride);
      return normalized === null ? null : `${site.siteUrl}${normalized}`;
    }
    let url: URL;
    try {
      url = new URL(canonicalOverride);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.origin !== siteOrigin(site)) return null;
    return `${site.siteUrl}${normalizeUrlPath(url.pathname)}`;
  }
  const normalized = normalizeSeoPath(path);
  return normalized === null ? null : `${site.siteUrl}${normalized}`;
}

let cachedSiteOrigin: { url: string; origin: string } | null = null;

function siteOrigin(site: SeoSiteConfig): string {
  if (cachedSiteOrigin?.url === site.siteUrl) return cachedSiteOrigin.origin;
  const origin = new URL(site.siteUrl).origin;
  cachedSiteOrigin = { url: site.siteUrl, origin };
  return origin;
}

/** Normalise un chemin public : `/…` sans query/fragment ni contrôle, slash final retiré (racine ` /` préservée). */
function normalizeSeoPath(path: string): string | null {
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  const clean = path.split(/[?#]/, 1)[0] ?? '';
  if (clean.length === 0 || clean === '/') return '/';
  if (clean.includes('\\') || clean.includes('..')) return null;
  // Défense en profondeur : aucun caractère de contrôle (CRLF, NUL) dans une
  // URL rendue — la validation au Save est la barrière normale, ceci la
  // redouble au rendu (mission §41).
  if (/[\r\n\0\u2028\u2029]/.test(clean)) return null;
  return normalizeUrlPath(clean);
}

/** Slash final retiré (`/racine` préservée), slashes consécutifs dédoublonnés — déduplication du contenu dupliqué (mission §25). */
function normalizeUrlPath(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, '/');
  const stripped = collapsed.replace(/\/+$/, '');
  return stripped.length === 0 ? '/' : stripped;
}

/**
 * Image OG depuis une vue média publique (`ready`) : la **plus grande
 * variante WebP** (qualité maximale pour les plateformes, qui redimensionnent),
 * repli sur la plus grande variante quelconque ; dimensions portées par la
 * variante choisie (`og:image:width/height` décrivent l'URL émise), alt du
 * média (omis si vide — image décorative assumée, politique slice 6).
 */
export function ogImageFromMediaView(view: PublicMediaView): SeoResolvedImage | null {
  const webp = view.variants.filter((variant) => variant.format === 'image/webp');
  const largest = webp.at(-1) ?? view.variants.at(-1);
  if (!largest) return null;
  return {
    url: largest.url,
    ...(largest.width > 0 ? { width: largest.width } : {}),
    ...(largest.height != null && largest.height > 0 ? { height: largest.height } : {}),
    ...(view.alt.length > 0 ? { alt: view.alt } : {}),
  };
}

/** Résolution générique d'une page (contenu ou page statique du Project). */
export function resolveSeo(site: SeoSiteConfig, request: SeoResolutionRequest): ResolvedSeoViewModel {
  const seo = request.seo ?? {};
  const noindex = seo.noindex === true;
  const follow = seo.nofollow !== true;

  const title = resolveSeoTitle(site, request.title, seo.title);

  // Description : override → dérivée (normalisée, tronquée) → défaut Project → null.
  const derived = request.description != null && request.description.trim().length > 0
    ? truncateDescription(normalizeDescriptionText(request.description), SEO_DESCRIPTION_MAX_LENGTH)
    : null;
  const description = normalizeDescriptionText(seo.description ?? '') || derived || site.defaultDescription;

  const canonical = resolveSeoCanonical(site, request.path, seo.canonicalOverride, noindex);

  // Image OG : explicite (déjà résolue par l'appelant depuis le média référencé)
  // → dérivée (couverture) → défaut Project (URL seule).
  const image = request.image ?? (site.defaultOgImageUrl ? { url: site.defaultOgImageUrl } : null);

  return {
    title,
    description: description != null && description.length > 0 ? description : null,
    canonical,
    robots: { index: !noindex, follow },
    og: {
      title: seo.ogTitle && seo.ogTitle.trim().length > 0 ? seo.ogTitle.trim() : title,
      description:
        seo.ogDescription && seo.ogDescription.trim().length > 0
          ? seo.ogDescription.trim()
          : (description != null && description.length > 0 ? description : null),
      url: canonical,
      type: request.ogType ?? 'website',
      siteName: site.siteName,
      locale: site.locale,
      image,
    },
    twitter: {
      // summary_large_image dès qu'une image existe, sinon summary — le
      // titre/description/image ne sont **pas** dupliqués : les plateformes
      // retombent sur l'OG (mission §14).
      card: image ? 'summary_large_image' : 'summary',
      site: site.twitterSite,
    },
    jsonLd: request.jsonLd ?? [],
  };
}

/**
 * Résolution d'une **page de contenu publiée** — le chemin vient du slug
 * **publié** (la vue du lecteur de build porte `published_slug`) : après un
 * changement de slug, le canonical pointe la nouvelle URL, jamais l'ancienne
 * (mission §24). La description dérivée : champ du Project (option) → texte
 * du premier champ richText → défaut Project ; l'image : OG explicite
 * (`view.seoImage`) → couverture publiée → défaut Project.
 */
export function resolveContentSeo(
  site: SeoSiteConfig,
  view: {
    readonly routeNamespace: string;
    readonly slug: string;
    readonly title: string;
    readonly seo: KreizContentSeo;
    readonly cover: PublicMediaView | null;
    /** Image OG explicite résolue par le lecteur (`ready`) — prioritaire sur la couverture. */
    readonly seoImage?: PublicMediaView | null;
    readonly richText?: Readonly<Record<string, { readonly document: unknown }>>;
  },
  options: ContentSeoOptions = {},
): ResolvedSeoViewModel {
  const derivedDescription =
    options.description ??
    firstRichTextPlainText(view.richText) ?? 
    null;
  const image = view.seoImage
    ? ogImageFromMediaView(view.seoImage)
    : view.cover
      ? ogImageFromMediaView(view.cover)
      : null;
  return resolveSeo(site, {
    path: publicPath(view.routeNamespace, view.slug),
    title: view.title,
    description: derivedDescription,
    image,
    ogType: options.ogType,
    seo: view.seo,
    jsonLd: options.jsonLd,
  });
}

/** Résolution d'une **page statique** du Project (accueil, contact…). */
export function resolvePageSeo(
  site: SeoSiteConfig,
  request: {
    readonly path: string;
    readonly title?: string;
    readonly description?: string | null;
    readonly image?: SeoResolvedImage | null;
    readonly ogType?: string;
    readonly noindex?: boolean;
    readonly jsonLd?: readonly object[];
  },
): ResolvedSeoViewModel {
  return resolveSeo(site, {
    path: request.path,
    title: request.title ?? site.siteName,
    description: request.description ?? null,
    image: request.image ?? null,
    ogType: request.ogType,
    jsonLd: request.jsonLd,
    seo: request.noindex === true ? { noindex: true } : {},
  });
}

/** Texte du premier champ richText présent (ordre de déclaration = ordre des clés). */
function firstRichTextPlainText(
  richText: Readonly<Record<string, { readonly document: unknown }>> | undefined,
): string | null {
  if (!richText) return null;
  for (const field of Object.values(richText)) {
    const document = field?.document;
    if (!document || typeof document !== 'object') continue;
    const plain = richTextDocumentToPlainText(
      document as Parameters<typeof richTextDocumentToPlainText>[0],
      SEO_DESCRIPTION_MAX_LENGTH,
    );
    if (plain.length > 0) return plain;
  }
  return null;
}
