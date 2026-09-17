import { defineSeoSiteConfig } from '@kreiz/core/seo';

/**
 * Configuration SEO du site — **déclarée en code par le projet** (slice 9),
 * même philosophie que les types de contenu. La même constante normalisée
 * est passée à `kreiz({ seo })` dans `astro.config.ts` (revalidation
 * idempotente, fail fast) et aux helpers de résolution des templates
 * (`resolveContentSeo` / `resolvePageSeo`).
 *
 * `siteUrl` est la **base canonique fiable** : les URLs canoniques et le
 * sitemap en dérivent, jamais d'un en-tête `Host`. En E2E, elle pointe le
 * serveur de test (`KREIZ_SITE_URL`) ; hors E2E, c'est l'URL publique du
 * site de démonstration.
 */
export const seoSite = defineSeoSiteConfig({
  siteName: 'Kreiz demo',
  siteUrl: process.env.KREIZ_SITE_URL ?? 'https://demo.kreiz.example',
  defaultDescription:
    'Application de démonstration de Kreiz, moteur éditorial pour Astro : contenus publiés, médias, formulaires et analytics privacy-first.',
  locale: 'fr-FR',
  organization: {
    name: 'Kreiz demo',
  },
  sitemap: {
    extraPaths: ['/', '/contact'],
  },
});
