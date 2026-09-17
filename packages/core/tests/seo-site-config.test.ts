import { describe, expect, it } from 'vitest';
import {
  defineSeoSiteConfig,
  isAbsoluteHttpUrl,
  isSitemapExtraPath,
  normalizeSiteUrl,
  resolveSeoSiteConfig,
} from '../src/domain/seo/site-config';

/**
 * Configuration SEO du site (slice 9) — validation stricte à la
 * déclaration (fail fast), normalisation idempotente (la forme résolue
 * repasse dans `kreiz({ seo })`), schémas fermés (clés inconnues rejetées).
 */

describe('defineSeoSiteConfig — résolution et défauts', () => {
  it('résout la configuration minimale avec les défauts', () => {
    const site = defineSeoSiteConfig({ siteName: 'Kreiz demo', siteUrl: 'https://demo.example' });
    expect(site.siteName).toBe('Kreiz demo');
    expect(site.siteUrl).toBe('https://demo.example');
    expect(site.titleTemplate).toBe('%s | Kreiz demo');
    expect(site.defaultDescription).toBeNull();
    expect(site.defaultOgImageUrl).toBeNull();
    expect(site.twitterSite).toBeNull();
    expect(site.locale).toBeNull();
    expect(site.organization).toBeNull();
    expect(site.sitemap.extraPaths).toEqual([]);
  });

  it('normalise siteUrl (slash final retiré, chemin conservé)', () => {
    expect(defineSeoSiteConfig({ siteName: 'S', siteUrl: 'https://demo.example/' }).siteUrl).toBe(
      'https://demo.example',
    );
    expect(
      defineSeoSiteConfig({ siteName: 'S', siteUrl: 'https://demo.example/blog///' }).siteUrl,
    ).toBe('https://demo.example/blog');
  });

  it('normalise le handle X/Twitter depuis @handle ou URL de profil', () => {
    expect(defineSeoSiteConfig({ siteName: 'S', siteUrl: 'https://a.example', twitterSite: '@kreiz_cms' }).twitterSite).toBe('@kreiz_cms');
    expect(
      defineSeoSiteConfig({ siteName: 'S', siteUrl: 'https://a.example', twitterSite: 'https://twitter.com/kreiz' }).twitterSite,
    ).toBe('@kreiz');
    expect(
      defineSeoSiteConfig({ siteName: 'S', siteUrl: 'https://a.example', twitterSite: 'https://x.com/kreiz' }).twitterSite,
    ).toBe('@kreiz');
  });

  it('est idempotent : la forme résolue repasse telle quelle', () => {
    const site = defineSeoSiteConfig({
      siteName: 'Kreiz demo',
      siteUrl: 'https://demo.example',
      defaultDescription: 'Description du site.',
      locale: 'fr-FR',
      organization: { name: 'Kreiz', url: 'https://demo.example', logoUrl: null },
      sitemap: { extraPaths: ['/'] },
    });
    const reparsed = resolveSeoSiteConfig(site);
    expect(reparsed).toEqual(site);
  });

  it('rejette les clés inconnues (jamais de config ignorée en silence)', () => {
    expect(() =>
      defineSeoSiteConfig({ siteName: 'S', siteUrl: 'https://a.example', keyword: 'x' } as never),
    ).toThrow(/configuration SEO invalide/);
  });

  it('rejette un siteUrl invalide (non URL, schéma fermé, query/fragment)', () => {
    expect(() => defineSeoSiteConfig({ siteName: 'S', siteUrl: 'pas-une-url' })).toThrow(/configuration SEO invalide/);
    expect(() => defineSeoSiteConfig({ siteName: 'S', siteUrl: 'javascript:alert(1)' })).toThrow(/http\(s\)/);
    expect(() => defineSeoSiteConfig({ siteName: 'S', siteUrl: 'https://a.example/?q=1' })).toThrow(/query ni fragment/);
    expect(() => defineSeoSiteConfig({ siteName: 'S', siteUrl: 'https://a.example/#ancre' })).toThrow(/query ni fragment/);
  });

  it('rejette un gabarit de titre sans %s ou avec plusieurs %s', () => {
    expect(() =>
      defineSeoSiteConfig({ siteName: 'S', siteUrl: 'https://a.example', titleTemplate: 'pas de placeholder' }),
    ).toThrow(/exactement un « %s »/);
    expect(() =>
      defineSeoSiteConfig({ siteName: 'S', siteUrl: 'https://a.example', titleTemplate: '%s | %s' }),
    ).toThrow(/exactement un « %s »/);
  });

  it('rejette un handle Twitter invalide et une locale malformée', () => {
    expect(() =>
      defineSeoSiteConfig({ siteName: 'S', siteUrl: 'https://a.example', twitterSite: 'https://evil.example/x' }),
    ).toThrow(/configuration SEO invalide/);
    expect(() =>
      defineSeoSiteConfig({ siteName: 'S', siteUrl: 'https://a.example', locale: 'pas une locale!' }),
    ).toThrow(/configuration SEO invalide/);
  });

  it('rejette un chemin sitemap hostile (montée, protocol-relative, query)', () => {
    expect(isSitemapExtraPath('/')).toBe(true);
    expect(isSitemapExtraPath('/contact')).toBe(true);
    expect(isSitemapExtraPath('/a-propos/')).toBe(true);
    expect(isSitemapExtraPath('contact')).toBe(false);
    expect(isSitemapExtraPath('//evil.example')).toBe(false);
    expect(isSitemapExtraPath('/../secret')).toBe(false);
    expect(isSitemapExtraPath('/x?q=1')).toBe(false);
    expect(isSitemapExtraPath('/x#y')).toBe(false);
    expect(isSitemapExtraPath('/x y')).toBe(false);
    expect(isSitemapExtraPath(`/x${'<'}script${'>'}`)).toBe(false);
  });

  it('isAbsoluteHttpUrl ferme le schéma (jamais javascript:/data:)', () => {
    expect(isAbsoluteHttpUrl('https://media.example/x.png')).toBe(true);
    expect(isAbsoluteHttpUrl('http://127.0.0.1:9333/x.png')).toBe(true);
    expect(isAbsoluteHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isAbsoluteHttpUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isAbsoluteHttpUrl('/relative.png')).toBe(false);
    expect(isAbsoluteHttpUrl('https://x.example/a b')).toBe(false);
  });

  it('normalizeSiteUrl lève une erreur FR explicite sur entrée absurde', () => {
    expect(() => normalizeSiteUrl('')).toThrow(/configuration SEO invalide/);
  });
});
