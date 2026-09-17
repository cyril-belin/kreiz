export const prerender = true;

import type { APIRoute } from 'astro';
import config from 'virtual:kreiz/config';
import { publicPath } from '../domain/content/redirect-engine.js';
import { buildSitemapXml, type SitemapUrl } from '../domain/seo/sitemap.js';
import { createKreizDatabase } from '../data/connection.js';
import { createContentEntriesRepository } from '../data/repositories/content-entries.js';

/**
 * Sitemap du site — `/sitemap.xml`, route **prérendue** (fichier statique
 * au build, servi par le CDN : zéro requête pour le servir, zéro runtime).
 *
 * Sources des URLs — uniquement des routes publiques :
 * 1. les contenus **publiés, non supprimés et indexables** (snapshots
 *    `published_*` lus au build ; brouillons, soft-deleted et noindex
 *    exclus par la requête — mission §10) ;
 * 2. les chemins statiques déclarés du Project (`seo.sitemap.extraPaths`,
 *    validés — jamais déduits d'un listing de fichiers).
 *
 * La base canonique vient **exclusivement** de la configuration Project
 * (mission §35) : sans bloc `seo`, aucun URL absolue ne peut être construite
 * — le sitemap est émis vide (urlset valide) plutôt que d'inventer une base
 * depuis un Host. Les URLs sont dédupliquées (un chemin statique peut
 * égaler une page de contenu).
 */
export const GET: APIRoute = async () => {
  const site = config.seo ?? null;
  const urls: SitemapUrl[] = [];

  if (site) {
    const origin = site.siteUrl;
    for (const path of site.sitemap.extraPaths) {
      urls.push({ loc: `${origin}${path}` });
    }

    const databaseUrl = process.env.KREIZ_DATABASE_URL;
    if (databaseUrl) {
      const entries = createContentEntriesRepository(createKreizDatabase({ databaseUrl }));
      const rows = await entries.listPublishedForSitemap();
      for (const row of rows) {
        urls.push({
          loc: `${origin}${publicPath(row.routeNamespace, row.publishedSlug)}`,
          lastmod: row.publishedAt,
        });
      }
    }
  }

  return new Response(buildSitemapXml(urls), {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      // Le sitemap lui-même n'est pas une page indexable.
      'x-robots-tag': 'noindex',
      'x-content-type-options': 'nosniff',
    },
  });
};
