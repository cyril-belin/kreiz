import { describe, expect, it } from 'vitest';
import { buildSitemapXml } from '../src/domain/seo/sitemap';
import { buildRobotsTxt } from '../src/domain/seo/robots';

/**
 * Sitemap.xml et robots.txt (slice 9) — XML échappé (mission §27), URLs
 * dédupliquées, lastmod W3C fiable ; robots exprime la politique de crawl
 * du Core sans jamais servir de protection (mission §9).
 */

describe('buildSitemapXml', () => {
  it('émet un urlset valide avec lastmod W3C', () => {
    const xml = buildSitemapXml([
      { loc: 'https://demo.example/', lastmod: new Date('2026-01-02T03:04:05.000Z') },
      { loc: 'https://demo.example/articles/a' },
    ]);
    expect(xml).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        '  <url>',
        '    <loc>https://demo.example/</loc>',
        '    <lastmod>2026-01-02T03:04:05.000Z</lastmod>',
        '  </url>',
        '  <url>',
        '    <loc>https://demo.example/articles/a</loc>',
        '  </url>',
        '</urlset>',
        '',
      ].join('\n'),
    );
  });

  it('échappe le XML dans les loc (aucune injection par slug/chemin)', () => {
    const xml = buildSitemapXml([
      { loc: 'https://demo.example/a&b<c>"d\'e' },
    ]);
    expect(xml).toContain('https://demo.example/a&amp;b&lt;c&gt;&quot;d&apos;e');
    expect(xml).not.toContain('a&b<c>');
  });

  it('déduplique les URLs (chemin statique = page de contenu)', () => {
    const xml = buildSitemapXml([
      { loc: 'https://demo.example/' },
      { loc: 'https://demo.example/' },
      { loc: 'https://demo.example/articles/a' },
    ]);
    expect(xml.match(/<loc>/g)).toHaveLength(2);
  });

  it('lastmod invalide : omise, jamais une date NaN sérialisée', () => {
    const xml = buildSitemapXml([{ loc: 'https://demo.example/x', lastmod: new Date('nope') }]);
    expect(xml).not.toContain('lastmod');
  });

  it('sitemap vide (pas de base, pas de base de données) : urlset valide', () => {
    expect(buildSitemapXml([])).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        '</urlset>',
        '',
      ].join('\n'),
    );
  });
});

describe('buildRobotsTxt', () => {
  it('politique par défaut : public indexable, /admin et /api exclus, sitemap absolu', () => {
    expect(buildRobotsTxt({ sitemapUrl: 'https://demo.example/sitemap.xml' })).toBe(
      [
        'User-agent: *',
        'Allow: /',
        'Disallow: /admin',
        'Disallow: /api',
        '',
        'Sitemap: https://demo.example/sitemap.xml',
        '',
      ].join('\n'),
    );
  });

  it('sans base canonique : pas de ligne Sitemap (jamais dérivée d’un Host)', () => {
    const txt = buildRobotsTxt({});
    expect(txt).not.toContain('Sitemap:');
    expect(txt).toContain('Disallow: /admin');
  });
});
