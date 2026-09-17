/**
 * Génération du **sitemap.xml** (mission slice 9 §10) — pure fonction :
 * URLs canoniques valides uniquement (la sélection — publiés, non supprimés,
 * indexables — est faite en amont par le lecteur de build), XML échappé
 * (mission §27 : aucune injection par slug/chemin), `lastmod` au format
 * W3C quand une valeur fiable existe (`published_at`).
 */

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Entrée du sitemap — `loc` absolu, `lastmod` fiable facultatif. */
export interface SitemapUrl {
  readonly loc: string;
  readonly lastmod?: Date | null;
}

/** XML `urlset` complet — URLs dédupliquées, ordre d'appel conservé. */
export function buildSitemapXml(urls: ReadonlyArray<SitemapUrl>): string {
  const seen = new Set<string>();
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const url of urls) {
    if (seen.has(url.loc)) continue;
    seen.add(url.loc);
    lines.push('  <url>');
    lines.push(`    <loc>${escapeXml(url.loc)}</loc>`);
    if (url.lastmod && !Number.isNaN(url.lastmod.getTime())) {
      lines.push(`    <lastmod>${url.lastmod.toISOString()}</lastmod>`);
    }
    lines.push('  </url>');
  }
  lines.push('</urlset>');
  return `${lines.join('\n')}\n`;
}
