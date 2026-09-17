/**
 * Données structurées JSON-LD (mission slice 9 §15/§16) — **builders typés**
 * : le Project ne fournit jamais un objet JSON arbitraire, il appelle ces
 * constructeurs avec des paramètres primitifs bornés. La sérialisation
 * (`serializeJsonLd`) neutralise les séquences dangereuses pour un contexte
 * `<script>` : `<` (donc `</script>`), U+2028/2029 — testées de façon
 * hostile (mission §41).
 *
 * Le HTML complet (`jsonLdScriptTag`) est inséré par le template du Project
 * via `set:html` — même mécanisme que le beacon analytics : aucun runtime,
 * tout est figé au build.
 */

/** Sérialisation sûre pour un contexte script : `<` échappé en `\u003c`. */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

/** Balise `<script type="application/ld+json">` complète et sûre. */
export function jsonLdScriptTag(data: object): string {
  return `<script type="application/ld+json">${serializeJsonLd(data)}</script>`;
}

const SCHEMA_ORG_CONTEXT = 'https://schema.org';
const TEXT_MAX_LENGTH = 300;

function text(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`@kreiz/core : JSON-LD « ${label} » requis (texte non vide).`);
  }
  return trimmed.slice(0, TEXT_MAX_LENGTH);
}

function optionalText(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, TEXT_MAX_LENGTH) : undefined;
}

function httpUrl(value: string, label: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`@kreiz/core : JSON-LD « ${label} » doit être une URL absolue valide.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`@kreiz/core : JSON-LD « ${label} » doit être une URL http(s).`);
  }
  return trimmed.slice(0, 2048);
}

function optionalHttpUrl(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value.trim().length === 0) return undefined;
  return httpUrl(value, 'url');
}

function isoDate(value: Date, label: string): string {
  if (Number.isNaN(value.getTime())) {
    throw new Error(`@kreiz/core : JSON-LD « ${label} » est une date invalide.`);
  }
  return value.toISOString();
}

/** `WebSite` — racine du site (page d'accueil). */
export function websiteJsonLd(input: { name: string; url: string; description?: string | null }): object {
  return {
    '@context': SCHEMA_ORG_CONTEXT,
    '@type': 'WebSite',
    name: text(input.name, 'name'),
    url: httpUrl(input.url, 'url'),
    ...(optionalText(input.description) ? { description: optionalText(input.description) } : {}),
  };
}

/** `Organization` — émise seulement si le Project la configure. */
export function organizationJsonLd(input: {
  name: string;
  url?: string | null;
  logoUrl?: string | null;
}): object {
  return {
    '@context': SCHEMA_ORG_CONTEXT,
    '@type': 'Organization',
    name: text(input.name, 'name'),
    ...(optionalHttpUrl(input.url) ? { url: optionalHttpUrl(input.url) } : {}),
    ...(optionalHttpUrl(input.logoUrl) ? { logo: optionalHttpUrl(input.logoUrl) } : {}),
  };
}

export interface BreadcrumbEntry {
  /** Libellé du niveau (texte pur — échappé par la sérialisation). */
  readonly name: string;
  /** URL absolue du niveau (omise en preview — canonical non résolue). */
  readonly url?: string | null;
}

/** `BreadcrumbList` — fil d'Ariane ; 1 à 20 niveaux, positions stables. */
export function breadcrumbJsonLd(entries: ReadonlyArray<BreadcrumbEntry>): object {
  if (entries.length === 0 || entries.length > 20) {
    throw new Error('@kreiz/core : JSON-LD BreadcrumbList attend 1 à 20 niveaux.');
  }
  return {
    '@context': SCHEMA_ORG_CONTEXT,
    '@type': 'BreadcrumbList',
    itemListElement: entries.map((entry, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: text(entry.name, 'name'),
      ...(optionalHttpUrl(entry.url) ? { item: optionalHttpUrl(entry.url) } : {}),
    })),
  };
}

/**
 * `BlogPosting` — contenu éditorial (mission §15 : émis quand le Project
 * mappe son type sur un schema.org éditorial). `datePublished` provient de
 * `published_at` (première publication — stable), `dateModified` de la
 * dernière publication connue du template.
 */
export function articleJsonLd(input: {
  headline: string;
  url?: string | null;
  datePublished: Date;
  dateModified?: Date | null;
  authorName?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  publisherName?: string | null;
}): object {
  const dateModified =
    input.dateModified && !Number.isNaN(input.dateModified.getTime()) ? input.dateModified : null;
  return {
    '@context': SCHEMA_ORG_CONTEXT,
    '@type': 'BlogPosting',
    headline: text(input.headline, 'headline'),
    ...(optionalHttpUrl(input.url) ? { url: optionalHttpUrl(input.url) } : {}),
    ...(dateModified ? { dateModified: dateModified.toISOString() } : {}),
    datePublished: isoDate(input.datePublished, 'datePublished'),
    ...(optionalText(input.authorName)
      ? { author: { '@type': 'Person', name: optionalText(input.authorName) } }
      : {}),
    ...(optionalText(input.description) ? { description: optionalText(input.description) } : {}),
    ...(optionalHttpUrl(input.imageUrl) ? { image: optionalHttpUrl(input.imageUrl) } : {}),
    ...(optionalText(input.publisherName)
      ? { publisher: { '@type': 'Organization', name: optionalText(input.publisherName) } }
      : {}),
  };
}
