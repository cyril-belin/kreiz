import { describe, expect, it } from 'vitest';
import {
  articleJsonLd,
  breadcrumbJsonLd,
  jsonLdScriptTag,
  organizationJsonLd,
  serializeJsonLd,
  websiteJsonLd,
} from '../src/domain/seo/jsonld';

/**
 * JSON-LD (slice 9) — builders typés uniquement (jamais d'objet arbitraire
 * d'utilisateur final) et sérialisation **sûre pour un contexte `<script>`** :
 * `</script>`, `<`, U+2028/2029 neutralisés (mission §16/§41).
 */

describe('sérialisation sûre', () => {
  it('échappe < (donc </script>) sans casser le JSON', () => {
    const serialized = serializeJsonLd({ name: '</script><script>alert(1)</script>' });
    expect(serialized).not.toContain('</script>');
    expect(JSON.parse(serialized.replaceAll('\\u003c', '<'))).toEqual({
      name: '</script><script>alert(1)</script>',
    });
  });

  it('échappe les séparateurs Unicode U+2028/U+2029 (JSON valide en JS inline)', () => {
    const serialized = serializeJsonLd({ text: 'a\u2028b\u2029c' });
    expect(serialized).not.toContain('\u2028');
    expect(serialized).not.toContain('\u2029');
    expect(JSON.parse(serialized)).toEqual({ text: 'a\u2028b\u2029c' });
  });

  it('la balise complète porte le type application/ld+json', () => {
    const tag = jsonLdScriptTag({ '@type': 'WebSite', name: 'A<b>' });
    expect(tag.startsWith('<script type="application/ld+json">')).toBe(true);
    expect(tag.endsWith('</script>')).toBe(true);
    // `<` est échappé (le `>` isolé est inoffensif dans un contexte script) :
    // la séquence `</script>` ne peut plus apparaître dans la sortie.
    expect(tag).toContain('"name":"A\\u003cb>"');
  });
});

describe('builders typés', () => {
  it('WebSite / Organization', () => {
    expect(websiteJsonLd({ name: 'Site', url: 'https://a.example', description: 'Desc.' })).toEqual({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'Site',
      url: 'https://a.example',
      description: 'Desc.',
    });
    expect(
      organizationJsonLd({ name: 'Org', url: 'https://a.example', logoUrl: 'https://a.example/l.png' }),
    ).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'Org',
      url: 'https://a.example',
      logo: 'https://a.example/l.png',
    });
  });

  it('BreadcrumbList : positions stables, item omis sans URL (preview)', () => {
    const ld = breadcrumbJsonLd([
      { name: 'Accueil', url: 'https://a.example/' },
      { name: 'Article', url: null },
    ]) as { '@type': string; itemListElement: Array<Record<string, unknown>> };
    expect(ld['@type']).toBe('BreadcrumbList');
    expect(ld.itemListElement[0]).toMatchObject({ position: 1, name: 'Accueil' });
    expect(ld.itemListElement[1]).toMatchObject({ position: 2, name: 'Article' });
    expect(ld.itemListElement[1]).not.toHaveProperty('item');
  });

  it('BlogPosting : dates ISO, auteur/publisher typés', () => {
    const ld = articleJsonLd({
      headline: 'Titre',
      url: 'https://a.example/x',
      datePublished: new Date('2026-01-02T03:04:05.000Z'),
      authorName: 'Auteure',
      publisherName: 'Org',
    }) as Record<string, unknown>;
    expect(ld['@type']).toBe('BlogPosting');
    expect(ld.datePublished).toBe('2026-01-02T03:04:05.000Z');
    expect(ld).not.toHaveProperty('dateModified');
    expect(ld.author).toEqual({ '@type': 'Person', name: 'Auteure' });
    expect(ld.publisher).toEqual({ '@type': 'Organization', name: 'Org' });
  });

  it('refus des entrées invalides (texte vide, URL non http, 0 niveau)', () => {
    expect(() => websiteJsonLd({ name: '  ', url: 'https://a.example' })).toThrow();
    expect(() => websiteJsonLd({ name: 'S', url: 'javascript:alert(1)' })).toThrow();
    expect(() => breadcrumbJsonLd([])).toThrow();
    expect(() =>
      articleJsonLd({ headline: 'T', datePublished: new Date('pas-une-date') }),
    ).toThrow();
  });
});
