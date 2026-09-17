import type { ResolvedSeoViewModel } from './resolve.js';

/**
 * Rendu **déterministe** des balises head publiques (mission slice 9 §19/
 * §28) — pure fonction : même vue résolue ⇒ même HTML, octet pour octet.
 *
 * - ordre d'émission fixe (title → description → robots → canonical →
 *   referrer → Open Graph → Twitter) — aucun doublon possible (une seule
 *   source, aucune valeur vide n'est émise) ;
 * - **tout** attribut est échappé (mission §19/§41) : le HTML dans un
 *   title/description est du texte, jamais du balisage ;
 * - `referrer` privacy-safe posé dans le head (les pages publiques sont
 *   statiques : les en-têtes de réponse relèvent du CDN — le meta est la
 *   seule garantie portable, cohérente avec la politique des routes admin).
 */

/** Échappement d'attribut HTML — même politique que le renderer rich text. */
function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function seoHeadTags(resolved: ResolvedSeoViewModel): string {
  const tags: string[] = [];
  tags.push(`<title>${escapeAttribute(resolved.title)}</title>`);
  if (resolved.description !== null && resolved.description.length > 0) {
    tags.push(`<meta name="description" content="${escapeAttribute(resolved.description)}" />`);
  }
  tags.push(`<meta name="robots" content="${robotsContent(resolved.robots.index, resolved.robots.follow)}" />`);
  if (resolved.canonical !== null) {
    tags.push(`<link rel="canonical" href="${escapeAttribute(resolved.canonical)}" />`);
  }
  tags.push('<meta name="referrer" content="strict-origin-when-cross-origin" />');

  tags.push(`<meta property="og:title" content="${escapeAttribute(resolved.og.title)}" />`);
  if (resolved.og.description !== null && resolved.og.description.length > 0) {
    tags.push(`<meta property="og:description" content="${escapeAttribute(resolved.og.description)}" />`);
  }
  if (resolved.og.url !== null) {
    tags.push(`<meta property="og:url" content="${escapeAttribute(resolved.og.url)}" />`);
  }
  tags.push(`<meta property="og:type" content="${escapeAttribute(resolved.og.type)}" />`);
  if (resolved.og.siteName !== null) {
    tags.push(`<meta property="og:site_name" content="${escapeAttribute(resolved.og.siteName)}" />`);
  }
  if (resolved.og.locale !== null) {
    tags.push(`<meta property="og:locale" content="${escapeAttribute(resolved.og.locale)}" />`);
  }
  const image = resolved.og.image;
  if (image) {
    tags.push(`<meta property="og:image" content="${escapeAttribute(image.url)}" />`);
    if (image.width !== undefined) {
      tags.push(`<meta property="og:image:width" content="${image.width}" />`);
    }
    if (image.height !== undefined) {
      tags.push(`<meta property="og:image:height" content="${image.height}" />`);
    }
    if (image.alt !== undefined && image.alt.length > 0) {
      tags.push(`<meta property="og:image:alt" content="${escapeAttribute(image.alt)}" />`);
    }
  }

  tags.push(`<meta name="twitter:card" content="${escapeAttribute(resolved.twitter.card)}" />`);
  if (resolved.twitter.site !== null) {
    tags.push(`<meta name="twitter:site" content="${escapeAttribute(resolved.twitter.site)}" />`);
  }

  return `${tags.join('\n')}\n`;
}

/** Contenu du meta robots — `index`/`noindex` × `follow`/`nofollow` (ordre canonique). */
function robotsContent(index: boolean, follow: boolean): string {
  return `${index ? 'index' : 'noindex'}, ${follow ? 'follow' : 'nofollow'}`;
}
