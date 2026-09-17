/**
 * API publique du SEO — sous-chemin `@kreiz/core/seo` (slice 9). C'est ici
 * que le Project déclare la configuration SEO de son site et rend la head
 * publique de ses pages : configuration typée, résolution déterministe
 * (défauts Project → valeurs dérivées du contenu → overrides SEO
 * explicites), rendu échappé, JSON-LD via builders typés.
 *
 * Ne sont **pas** exposés : repositories, sitemap/robots routes (injectées
 * par l'intégration), validation des services, admin internals. Le Project
 * n'écrit jamais de balise `<meta>` depuis du HTML arbitraire — il appelle
 * les helpers, le HTML reste produit par le Core.
 */

// Configuration Project — déclaration typée (fail fast) + forme résolue
export { defineSeoSiteConfig } from '../domain/seo/site-config.js';
export type { SeoSiteConfig, SeoSiteConfigInput } from '../domain/seo/site-config.js';

// Résolution déterministe (title, description, canonical, robots, OG, Twitter)
export {
  resolveSeo,
  resolveSeoTitle,
  resolveSeoCanonical,
  resolveContentSeo,
  resolvePageSeo,
  ogImageFromMediaView,
} from '../domain/seo/resolve.js';
export type {
  ResolvedSeoViewModel,
  SeoResolvedImage,
  SeoResolutionRequest,
} from '../domain/seo/resolve.js';

// Rendu head déterministe et échappé (insérer via <Fragment set:html>)
export { seoHeadTags } from '../domain/seo/head.js';

// Données structurées — builders typés + sérialisation sûre pour <script>
export {
  jsonLdScriptTag,
  serializeJsonLd,
  websiteJsonLd,
  organizationJsonLd,
  breadcrumbJsonLd,
  articleJsonLd,
} from '../domain/seo/jsonld.js';

// Repli description depuis un document rich text (utile aux tests du Project)
export { richTextDocumentToPlainText } from '../domain/seo/description.js';

// Chemins publics des fichiers SEO générés (constantes canoniques)
export {
  PUBLIC_SITEMAP_PATH as SITEMAP_PATH,
  PUBLIC_ROBOTS_PATH as ROBOTS_PATH,
} from '../http/admin-routes.js';
