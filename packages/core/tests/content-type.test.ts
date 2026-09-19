import { describe, expect, it } from 'vitest';
import { defineContentType, fields } from '../src/domain/content/declaration';
import { dataSchemaFromFields } from '../src/domain/content/schema';

/**
 * API `defineContentType` — déclarations de types en code (mission §3/§4).
 * Le schéma Zod du JSONB `data` est **dérivé** des descripteurs : même
 * fonction côté Project et côté runtime, les validations ne peuvent pas
 * diverger. Toute clé inconnue du JSONB est invalide (schéma strict).
 */

describe('defineContentType — déclaration valide', () => {
  const article = defineContentType({
    key: 'article',
    label: 'Article',
    labelPlural: 'Articles',
    routeNamespace: 'articles',
    fields: {
      excerpt: fields.text({ label: 'Accroche', required: true, maxLength: 100 }),
      body: fields.textarea({ label: 'Corps', required: true }),
      author: fields.text({ label: 'Auteur' }),
    },
    template: 'src/templates/ArticleContent.astro',
  });

  it('conserve la déclaration et attache le schéma dérivé', () => {
    expect(article.key).toBe('article');
    expect(article.routeNamespace).toBe('articles');
    expect(article.template).toBe('src/templates/ArticleContent.astro');
    expect(article.dataSchema).toBeDefined();
  });

  it('les builders posent le kind — les déclarations ne portent que du sens', () => {
    expect(article.fields.excerpt).toMatchObject({ kind: 'text', required: true });
    expect(article.fields.body).toMatchObject({ kind: 'textarea' });
  });

  it('le labelPlural est optionnel (défaut label + « s » côté registre)', () => {
    expect(article.labelPlural).toBe('Articles');
    const simple = defineContentType({
      key: 'note',
      label: 'Note',
      routeNamespace: 'notes',
      fields: {},
      template: 't.astro',
    });
    expect(simple.labelPlural).toBeUndefined();
  });
});

describe('defineContentType — déclarations invalides (fail fast)', () => {
  it('rejette une clé non conforme', () => {
    expect(() =>
      defineContentType({
        key: 'Article',
        label: 'Article',
        routeNamespace: 'articles',
        fields: {},
        template: 't.astro',
      }),
    ).toThrow(/clé invalide/);
  });

  it('rejette un namespace de route non conforme', () => {
    expect(() =>
      defineContentType({
        key: 'article',
        label: 'Article',
        routeNamespace: 'Mes Articles',
        fields: {},
        template: 't.astro',
      }),
    ).toThrow(/namespace de route invalide/);
  });

  it('rejette les namespaces réservés au Core (revue sécurité finale)', () => {
    for (const namespace of ['admin', 'api']) {
      expect(() =>
        defineContentType({
          key: 'article',
          label: 'Article',
          routeNamespace: namespace,
          fields: {},
          template: 't.astro',
        }),
      ).toThrow(/namespace de route réservé/);
    }
  });

  it('rejette un template manquant', () => {
    expect(() =>
      defineContentType({
        key: 'article',
        label: 'Article',
        routeNamespace: 'articles',
        fields: {},
        template: '',
      }),
    ).toThrow(/template requis/);
  });

  it('rejette un champ de kind inconnu (vocabulaire borné, mission §5)', () => {
    expect(() =>
      defineContentType({
        key: 'article',
        label: 'Article',
        routeNamespace: 'articles',
        fields: {
          body: { kind: 'pluginWidget', label: 'Corps' } as never,
        },
        template: 't.astro',
      }),
    ).toThrow(/vocabulaire V1/);
  });

  it('rejette un select sans choix', () => {
    expect(() =>
      defineContentType({
        key: 'article',
        label: 'Article',
        routeNamespace: 'articles',
        fields: { category: fields.select({ label: 'Catégorie', choices: [] }) },
        template: 't.astro',
      }),
    ).toThrow(/vocabulaire V1/);
  });
});

describe('schéma dérivé du JSONB data (strict)', () => {
  const article = defineContentType({
    key: 'article',
    label: 'Article',
    routeNamespace: 'articles',
    fields: {
      excerpt: fields.text({ label: 'Accroche', required: true, maxLength: 50 }),
      author: fields.text({ label: 'Auteur' }),
      category: fields.select({
        label: 'Catégorie',
        required: true,
        choices: [
          { value: 'seo', label: 'SEO' },
          { value: 'web', label: 'Web' },
        ],
      }),
      link: fields.url({ label: 'Lien' }),
      publishedOn: fields.date({ label: 'Publié le' }),
      weight: fields.metric({ label: 'Poids' }),
      tags: fields.list({ label: 'Tags', item: fields.text({ label: 'Tag' }) }),
    },
    template: 't.astro',
  });

  it('accepte des données valides', () => {
    const parsed = article.dataSchema.parse({
      excerpt: 'Accroche',
      category: 'seo',
      link: 'https://example.com/page',
      publishedOn: '2026-09-05',
      weight: { label: 'Poids', value: '42 kg' },
      tags: ['a', 'b'],
    });
    expect(parsed).toMatchObject({ excerpt: 'Accroche', category: 'seo' });
  });

  it('rejette une clé inconnue — le JSONB n’accepte que les champs déclarés', () => {
    expect(
      article.dataSchema.safeParse({ excerpt: 'ok', category: 'web', injected: 'x' }).success,
    ).toBe(false);
  });

  it('rejette un champ requis vide ou absent', () => {
    expect(article.dataSchema.safeParse({ excerpt: '', category: 'web' }).success).toBe(false);
    expect(article.dataSchema.safeParse({ category: 'web' }).success).toBe(false);
  });

  it('rejette une valeur de select hors liste fermée', () => {
    expect(
      article.dataSchema.safeParse({ excerpt: 'ok', category: 'inconnu' }).success,
    ).toBe(false);
  });

  it('rejette une URL relative ou non http(s)', () => {
    expect(
      article.dataSchema.safeParse({ excerpt: 'ok', category: 'web', link: '/relative' }).success,
    ).toBe(false);
    expect(
      article.dataSchema.safeParse({ excerpt: 'ok', category: 'web', link: 'ftp://x' }).success,
    ).toBe(false);
  });

  it('rejette une date non ISO', () => {
    expect(
      article.dataSchema.safeParse({ excerpt: 'ok', category: 'web', publishedOn: '05/09/2026' })
        .success,
    ).toBe(false);
  });

  it('rejette une métrique incomplète', () => {
    expect(
      article.dataSchema.safeParse({ excerpt: 'ok', category: 'web', weight: { label: 'Poids' } })
        .success,
    ).toBe(false);
  });

  it('les champs optionnels peuvent être absents', () => {
    expect(article.dataSchema.safeParse({ excerpt: 'ok', category: 'web' }).success).toBe(true);
  });

  it('un type sans champ produit un schéma acceptant un objet vide', () => {
    const schema = dataSchemaFromFields({});
    expect(schema.parse({})).toEqual({});
    expect(schema.safeParse({ extra: 1 }).success).toBe(false);
  });
});
