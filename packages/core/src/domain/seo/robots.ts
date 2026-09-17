/**
 * Génération de **robots.txt** (mission slice 9 §9/§26) — pure fonction.
 * La politique est celle du Core : l'espace public est indexable, les
 * routes système (back-office `/admin`, endpoints `/api`) sont exclues.
 *
 * robots.txt est une **convention de crawl**, pas une protection : les
 * pages privées restent gardées par la session (et noindex en en-tête) —
 * le fichier n'est jamais la seule barrière (mission §9).
 */
export function buildRobotsTxt(options: {
  /** URL absolue du sitemap — omise quand le site n'a pas de base canonique. */
  sitemapUrl?: string | null;
  /** Préfixes exclus du crawl (défaut : `/admin`, `/api`). */
  disallow?: ReadonlyArray<string>;
}): string {
  const lines: string[] = ['User-agent: *', 'Allow: /'];
  for (const path of options.disallow ?? ['/admin', '/api']) {
    if (!path.startsWith('/') || path.includes('\n') || path.includes('\r')) continue;
    lines.push(`Disallow: ${path}`);
  }
  if (options.sitemapUrl && /^https?:\/\//.test(options.sitemapUrl)) {
    lines.push('');
    lines.push(`Sitemap: ${options.sitemapUrl}`);
  }
  return `${lines.join('\n')}\n`;
}
