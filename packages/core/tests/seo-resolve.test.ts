import { describe, expect, it } from 'vitest';
import { defineSeoSiteConfig } from '../src/domain/seo/site-config';
import {
  ogImageFromMediaView,
  resolveContentSeo,
  resolvePageSeo,
  resolveSeo,
  resolveSeoCanonical,
  resolveSeoTitle,
} from '../src/domain/seo/resolve';
import type { PublicMediaView } from '../src/domain/media/view-model';
import { parseRichTextDocument } from '../src/domain/content/rich-text/document';

/**
 * Résolution SEO (slice 9) — pure et déterministe. Ordre documenté :
 * override SEO explicite → valeur dérivée du contenu → défaut Project.
 * Hostile : canonical cross-origin/`javascript:`/CRLF écartées, pas de
 * double nom de site, pas de meta vide rendue.
 */

const site = defineSeoSiteConfig({
  siteName: 'Kreiz demo',
  siteUrl: 'https://demo.example',
  defaultDescription: 'Description par défaut du site.',
  defaultOgImageUrl: 'https://cdn.example/og-default.png',
  twitterSite: '@kreiz_cms',
  locale: 'fr-FR',
});

function mediaView(values: Partial<PublicMediaView> = {}): PublicMediaView {
  return {
    id: 'm1',
    alt: 'Image de couverture',
    width: 1600,
    height: 900,
    variants: [
      { url: 'https://cdn.example/m1/400.webp', width: 400, format: 'image/webp', height: 225 },
      { url: 'https://cdn.example/m1/800.webp', width: 800, format: 'image/webp', height: 450 },
      { url: 'https://cdn.example/m1/1400.avif', width: 1400, format: 'image/avif', height: 788 },
      { url: 'https://cdn.example/m1/1400.webp', width: 1400, format: 'image/webp', height: 788 },
    ],
    ...values,
  };
}

describe('title — override, dérivé, gabarit, double nom de site', () => {
  it('applique le gabarit au titre dérivé', () => {
    expect(resolveSeoTitle(site, 'Mon article', null)).toBe('Mon article | Kreiz demo');
  });

  it("l'override SEO explicite gagne sur le titre dérivé", () => {
    expect(resolveSeoTitle(site, 'Mon article', 'Titre SEO spécifique')).toBe(
      'Titre SEO spécifique | Kreiz demo',
    );
  });

  it("ne double jamais le nom du site (déjà présent dans le titre)", () => {
    expect(resolveSeoTitle(site, 'Kreiz demo — à propos', null)).toBe('Kreiz demo — à propos');
  });

  it('le titre égal au nom du site reste nu (accueil)', () => {
    expect(resolveSeoTitle(site, 'Kreiz demo', null)).toBe('Kreiz demo');
  });

  it('écarte le gabarit si le title rendu devient démesuré (bornes, mission §6)', () => {
    const longBase = 'x'.repeat(190);
    expect(resolveSeoTitle(site, longBase, null)).toBe(longBase);
  });

  it('normalise le whitespace de l’override', () => {
    expect(resolveSeoTitle(site, 'Titre', '  Titre   SEO\nspécifique  ')).toBe(
      'Titre SEO spécifique | Kreiz demo',
    );
  });
});

describe('description — override > dérivée > défaut Project, jamais vide', () => {
  it('utilise l’override SEO explicite', () => {
    const resolved = resolveSeo(site, { path: '/a', title: 'A', description: 'Dérivée.', seo: { description: 'Override.' } });
    expect(resolved.description).toBe('Override.');
  });

  it('retombe sur la valeur dérivée (accroche / plaintext)', () => {
    const resolved = resolveSeo(site, { path: '/a', title: 'A', description: 'Dérivée  propre.' });
    expect(resolved.description).toBe('Dérivée propre.');
  });

  it('retombe sur le défaut Project, sinon null (aucun meta vide émis)', () => {
    expect(resolveSeo(site, { path: '/a', title: 'A' }).description).toBe('Description par défaut du site.');
    const bare = defineSeoSiteConfig({ siteName: 'S', siteUrl: 'https://b.example' });
    expect(resolveSeo(bare, { path: '/a', title: 'A' }).description).toBeNull();
  });

  it('tronque la description dérivée sur une frontière de mot (300 max)', () => {
    const long = 'mot '.repeat(120).trim();
    const resolved = resolveSeo(site, { path: '/a', title: 'A', description: long });
    expect(resolved.description!.length).toBeLessThanOrEqual(300);
    expect(resolved.description!.endsWith('mot')).toBe(true);
  });
});

describe('canonical — base fiable, slash, encodage, host ignoré', () => {
  it('canonical = siteUrl + chemin public, slash final normalisé', () => {
    expect(resolveSeoCanonical(site, '/articles/mon-article')).toBe('https://demo.example/articles/mon-article');
    expect(resolveSeoCanonical(site, '/')).toBe('https://demo.example/');
  });

  it('override chemin interne : résolu sur la base fiable, query/fragment retirés', () => {
    expect(resolveSeoCanonical(site, '/a', '/editions/speciale')).toBe('https://demo.example/editions/speciale');
    expect(resolveSeoCanonical(site, '/a', '/editions/speciale/?utm=x#top')).toBe(
      'https://demo.example/editions/speciale',
    );
  });

  it('override absolu même origine accepté, cross-origin écarté', () => {
    expect(resolveSeoCanonical(site, '/a', 'https://demo.example/autrement')).toBe(
      'https://demo.example/autrement',
    );
    expect(resolveSeoCanonical(site, '/a', 'https://autre.example/page')).toBeNull();
  });

  it('hostile : javascript:, data:, CRLF, URL malformée — jamais rendus', () => {
    expect(resolveSeoCanonical(site, '/a', 'javascript:alert(1)')).toBeNull();
    expect(resolveSeoCanonical(site, '/a', 'data:text/html,<script>')).toBeNull();
    expect(resolveSeoCanonical(site, '/a', '/a\r\nX-Injected: 1')).toBeNull();
    expect(resolveSeoCanonical(site, '/a', '::pas une url::')).toBeNull();
  });

  it('hostile : montée de chemin (..) et slashes doublés — normalisés/rejetés', () => {
    expect(resolveSeoCanonical(site, '/a', '/../secret')).toBeNull();
    expect(resolveSeoCanonical(site, '/articles/x/', '/a//b///c')).toBe('https://demo.example/a/b/c');
    // L'URL absolue même origine est normalisée par le parseur URL (points résolus).
    expect(resolveSeoCanonical(site, '/a', 'https://demo.example/x/../y/')).toBe(
      'https://demo.example/y',
    );
  });

  it('caractères encodés conservés tels quels (slug système propre)', () => {
    expect(resolveSeoCanonical(site, '/articles/l-ete-%C3%A0-la-mer')).toBe(
      'https://demo.example/articles/l-ete-%C3%A0-la-mer',
    );
  });

  it('la base canonique ne dépend jamais d’un Host client (mission §35)', () => {
    // La résolution ne reçoit aucune requête : le Host ne peut pas entrer.
    expect(resolveSeo(site, { path: '/a', title: 'A' }).canonical).toBe('https://demo.example/a');
  });
});

describe('robots / OG / Twitter — fallback documenté', () => {
  it('défaut : index, follow ; noindex/nofollow explicites', () => {
    expect(resolveSeo(site, { path: '/a', title: 'A' }).robots).toEqual({ index: true, follow: true });
    expect(resolveSeo(site, { path: '/a', title: 'A', seo: { noindex: true } }).robots).toEqual({
      index: false,
      follow: true,
    });
    expect(resolveSeo(site, { path: '/a', title: 'A', seo: { noindex: true, nofollow: true } }).robots).toEqual({
      index: false,
      follow: false,
    });
  });

  it('noindex ⇒ canonical et og:url omis (aucun signal contradictoire)', () => {
    const resolved = resolveSeo(site, { path: '/a', title: 'A', seo: { noindex: true } });
    expect(resolved.canonical).toBeNull();
    expect(resolved.og.url).toBeNull();
  });

  it('image OG : explicite > couverture > défaut Project ; card selon image', () => {
    const cover = ogImageFromMediaView(mediaView({ id: 'cover' }))!;
    const withCover = resolveSeo(site, { path: '/a', title: 'A', image: cover });
    expect(withCover.og.image?.url).toBe('https://cdn.example/m1/1400.webp');
    expect(withCover.twitter.card).toBe('summary_large_image');

    const withExplicit = resolveSeo(site, {
      path: '/a',
      title: 'A',
      image: cover,
      seo: {},
    });
    expect(withExplicit.og.image?.url).toBe('https://cdn.example/m1/1400.webp');

    const defaultOnly = resolveSeo(site, { path: '/a', title: 'A' });
    expect(defaultOnly.og.image?.url).toBe('https://cdn.example/og-default.png');
    expect(defaultOnly.twitter.card).toBe('summary_large_image');

    const bare = resolveSeo(defineSeoSiteConfig({ siteName: 'S', siteUrl: 'https://b.example' }), {
      path: '/a',
      title: 'A',
    });
    expect(bare.og.image).toBeNull();
    expect(bare.twitter.card).toBe('summary');
  });

  it('og:title/og:description : override puis valeurs résolues', () => {
    const resolved = resolveSeo(site, {
      path: '/a',
      title: 'A',
      description: 'Description.',
      seo: { ogTitle: 'Titre social', ogDescription: 'Description sociale' },
    });
    expect(resolved.og.title).toBe('Titre social');
    expect(resolved.og.description).toBe('Description sociale');
    const fallback = resolveSeo(site, { path: '/a', title: 'A', description: 'Description.' });
    expect(fallback.og.title).toBe('A | Kreiz demo');
    expect(fallback.og.description).toBe('Description.');
  });

  it('og:type par défaut website, mappé par le Project sinon', () => {
    expect(resolveSeo(site, { path: '/a', title: 'A' }).og.type).toBe('website');
    expect(resolveSeo(site, { path: '/a', title: 'A', ogType: 'article' }).og.type).toBe('article');
  });

  it('og:site_name + locale + twitter:site viennent de la config', () => {
    const resolved = resolveSeo(site, { path: '/a', title: 'A' });
    expect(resolved.og.siteName).toBe('Kreiz demo');
    expect(resolved.og.locale).toBe('fr-FR');
    expect(resolved.twitter.site).toBe('@kreiz_cms');
  });

  it('ogImageFromMediaView : plus grande variante WebP, dimensions/alt portés', () => {
    const image = ogImageFromMediaView(mediaView())!;
    expect(image).toEqual({
      url: 'https://cdn.example/m1/1400.webp',
      width: 1400,
      height: 788,
      alt: 'Image de couverture',
    });
    // Sans variante WebP : la plus grande variante quelconque.
    const avifOnly = ogImageFromMediaView(
      mediaView({
        alt: '',
        variants: [{ url: 'https://cdn.example/m1/800.avif', width: 800, format: 'image/avif', height: 450 }],
      }),
    )!;
    expect(avifOnly.url).toBe('https://cdn.example/m1/800.avif');
    expect(avifOnly.alt).toBeUndefined();
    // Aucune variante : pas d'image rendue.
    expect(ogImageFromMediaView(mediaView({ variants: [] }))).toBeNull();
  });
});

describe('resolveContentSeo / resolvePageSeo — chemin publié et pages statiques', () => {
  it('chemin issu du slug publié ; description projet > rich text ; JSON-LD porté', () => {
    const document = parseRichTextDocument({
      version: 1,
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Premier paragraphe du corps.' }] },
      ],
    });
    const resolved = resolveContentSeo(
      site,
      {
        routeNamespace: 'articles',
        slug: 'mon-article',
        title: 'Mon article',
        seo: {},
        cover: null,
        richText: { body: { document } },
      },
      { ogType: 'article' },
    );
    expect(resolved.canonical).toBe('https://demo.example/articles/mon-article');
    expect(resolved.description).toBe('Premier paragraphe du corps.');
    expect(resolved.og.type).toBe('article');
  });

  it('la description projet (accroche) est prioritaire sur le plaintext rich text', () => {
    const document = parseRichTextDocument({
      version: 1,
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Corps.' }] }],
    });
    const resolved = resolveContentSeo(
      site,
      {
        routeNamespace: 'articles',
        slug: 'a',
        title: 'A',
        seo: {},
        cover: null,
        richText: { body: { document } },
      },
      { description: 'Accroche du projet.' },
    );
    expect(resolved.description).toBe('Accroche du projet.');
  });

  it('page statique : canonical sur le chemin, noindex possible', () => {
    const home = resolvePageSeo(site, { path: '/', description: 'Accueil.' });
    expect(home.canonical).toBe('https://demo.example/');
    expect(home.title).toBe('Kreiz demo');
    const merci = resolvePageSeo(site, { path: '/contact/merci', title: 'Merci', noindex: true });
    expect(merci.robots.index).toBe(false);
    expect(merci.canonical).toBeNull();
  });
});
