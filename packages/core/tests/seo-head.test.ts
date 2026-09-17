import { describe, expect, it } from 'vitest';
import { seoHeadTags } from '../src/domain/seo/head';
import { resolvePageSeo, resolveSeo, type ResolvedSeoViewModel } from '../src/domain/seo/resolve';
import { defineSeoSiteConfig } from '../src/domain/seo/site-config';

/**
 * Rendu head (slice 9) — déterministe, échappé, sans doublon ni meta vide
 * (mission §19/§28/§41). Toute valeur hostile (HTML, guillemets, CRLF)
 * reste du texte d'attribut.
 */

const site = defineSeoSiteConfig({
  siteName: 'Kreiz demo',
  siteUrl: 'https://demo.example',
  locale: 'fr-FR',
  twitterSite: '@kreiz_cms',
});

function resolved(values: Record<string, unknown> = {}): ResolvedSeoViewModel {
  return resolveSeo(site, { path: '/a', title: 'A', ...values } as never);
}

describe('seoHeadTags — sortie déterministe complète', () => {
  it('émet chaque balise une seule fois, dans un ordre fixe', () => {
    const html = seoHeadTags(
      resolveSeo(site, {
        path: '/articles/slug',
        title: 'Mon article',
        description: 'Description.',
        image: { url: 'https://cdn.example/og.webp', width: 1400, height: 788, alt: 'Alt' },
        jsonLd: [],
      }),
    );
    expect(html).toBe(
      [
        '<title>Mon article | Kreiz demo</title>',
        '<meta name="description" content="Description." />',
        '<meta name="robots" content="index, follow" />',
        '<link rel="canonical" href="https://demo.example/articles/slug" />',
        '<meta name="referrer" content="strict-origin-when-cross-origin" />',
        '<meta property="og:title" content="Mon article | Kreiz demo" />',
        '<meta property="og:description" content="Description." />',
        '<meta property="og:url" content="https://demo.example/articles/slug" />',
        '<meta property="og:type" content="website" />',
        '<meta property="og:site_name" content="Kreiz demo" />',
        '<meta property="og:locale" content="fr-FR" />',
        '<meta property="og:image" content="https://cdn.example/og.webp" />',
        '<meta property="og:image:width" content="1400" />',
        '<meta property="og:image:height" content="788" />',
        '<meta property="og:image:alt" content="Alt" />',
        '<meta name="twitter:card" content="summary_large_image" />',
        '<meta name="twitter:site" content="@kreiz_cms" />',
        '',
      ].join('\n'),
    );
  });

  it('aucune valeur vide : description/OG/defaults absents ⇒ balises omises, canonical présente', () => {
    const html = seoHeadTags(
      resolveSeo(defineSeoSiteConfig({ siteName: 'S', siteUrl: 'https://b.example' }), {
        path: '/a',
        title: 'A',
      }),
    );
    expect(html).not.toContain('name="description"');
    expect(html).not.toContain('og:image');
    expect(html).not.toContain('og:description');
    expect(html).not.toContain('og:locale');
    expect(html).not.toContain('twitter:site');
    // canonical dérivée du chemin : présente avec og:url.
    expect(html).toContain('rel="canonical" href="https://b.example/a"');
    expect(html).toContain('og:url" content="https://b.example/a"');
  });

  it('un seul <title> et un seul canonical par page', () => {
    const html = seoHeadTags(resolved());
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html.match(/rel="canonical"/g) ?? []).toHaveLength(1);
  });
});

describe('seoHeadTags — hostilité (mission §41)', () => {
  it('HTML/script dans title, description et alt : échappé, jamais interprété', () => {
    const html = seoHeadTags(
      resolveSeo(site, {
        path: '/a',
        title: '<script>alert(1)</script>',
        description: '"onclick="x" onmouseover="evil',
        image: { url: 'https://cdn.example/a.png', alt: '<b>alt</b>' },
      }),
    );
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;onclick=&quot;x&quot; onmouseover=&quot;evil');
    expect(html).toContain('content="&lt;b&gt;alt&lt;/b&gt;"');
  });

  it('noindex rendu en meta robots ; canonical/og:url absents', () => {
    const html = seoHeadTags(resolved({ seo: { noindex: true } }));
    expect(html).toContain('<meta name="robots" content="noindex, follow" />');
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain('og:url');
  });

  it('nofollow rendu', () => {
    const html = seoHeadTags(resolved({ seo: { nofollow: true } }));
    expect(html).toContain('<meta name="robots" content="index, nofollow" />');
  });

  it('page noindex du Project (merci/404) : head minimale non indexable', () => {
    const html = seoHeadTags(resolvePageSeo(site, { path: '/contact/merci', title: 'Merci', noindex: true }));
    expect(html).toContain('<meta name="robots" content="noindex, follow" />');
    expect(html).not.toContain('rel="canonical"');
  });
});
