export const prerender = true;

import type { APIRoute } from 'astro';
import config from 'virtual:kreiz/config';
import { buildRobotsTxt } from '../domain/seo/robots.js';

/**
 * robots.txt — `/robots.txt`, route **prérendue** (fichier statique).
 *
 * Politique de crawl du Core : l'espace public est indexable, les routes
 * système (`/admin` — back-office et preview, `/api` — endpoints) sont
 * exclues. L'URL absolue du sitemap n'est émise que quand le Project a
 * configuré sa base canonique (`seo.siteUrl`) — jamais dérivée d'un Host.
 *
 * Rappel de politique (mission §9) : robots.txt n'est **pas** une
 * protection — les routes privées restent gardées par la session et
 * `X-Robots-Tag: noindex` ; le fichier n'exprime que la convention de
 * crawl.
 */
export const GET: APIRoute = async () => {
  const site = config.seo ?? null;
  return new Response(
    buildRobotsTxt({
      sitemapUrl: site ? `${site.siteUrl}/sitemap.xml` : null,
      disallow: ['/admin', '/api'],
    }),
    {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=3600',
        'x-content-type-options': 'nosniff',
      },
    },
  );
};
