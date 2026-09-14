import { describe, expect, it } from 'vitest';
import { fields } from '../src/domain/content/fields';
import { dataSchemaFromFields } from '../src/domain/content/schema';
import { resolveContentViewModel } from '../src/domain/content/view-model';
import { ContentDataCorruptedError, UnknownContentTypeError } from '../src/domain/content/errors';
import { stubContentEntry } from './helpers/in-memory-content';

/**
 * Vue mutualisée preview ⇄ public (mission §23) — le mapping entrée DB →
 * props de template est unique et refuse tout contenu non conforme à sa
 * déclaration (mission §4).
 */

const declaration = {
  key: 'article',
  routeNamespace: 'articles',
  // Le schéma réel est dérivé des descripteurs (même fonction que le runtime).
  dataSchema: dataSchemaFromFields({
    excerpt: fields.text({ label: 'Accroche', required: true }),
  }),
};

describe('resolveContentViewModel', () => {
  it('mappe l’entrée en vue typée (mapping unique preview/public)', () => {
    const entry = stubContentEntry({
      contentType: 'article',
      routeNamespace: 'articles',
      title: 'Titre de test',
      slug: 'titre-de-test',
      data: { excerpt: 'Accroche' },
      publishedAt: new Date('2026-09-01T10:00:00Z'),
    });
    const view = resolveContentViewModel(declaration, entry);
    expect(view).toMatchObject({
      id: entry.id,
      contentType: 'article',
      routeNamespace: 'articles',
      title: 'Titre de test',
      slug: 'titre-de-test',
      status: 'draft',
      data: { excerpt: 'Accroche' },
    });
    expect(view.publishedAt).toBeInstanceOf(Date);
    expect(view.seo).toEqual({});
  });

  it('refuse de rendre une entrée sous un autre type (isolation)', () => {
    const entry = stubContentEntry({ contentType: 'guide', routeNamespace: 'guides' });
    expect(() => resolveContentViewModel(declaration, entry)).toThrow(UnknownContentTypeError);
  });

  it('refuse un namespace incohérent avec la déclaration', () => {
    const entry = stubContentEntry({ contentType: 'article', routeNamespace: 'guides' });
    expect(() => resolveContentViewModel(declaration, entry)).toThrow(ContentDataCorruptedError);
  });

  it('refuse des data invalides pour le schéma du type', () => {
    const entry = stubContentEntry({ data: {} }); // excerpt requis absent
    expect(() => resolveContentViewModel(declaration, entry)).toThrow(ContentDataCorruptedError);
    const corrupted = stubContentEntry({ data: { excerpt: 'ok', injected: true } });
    expect(() => resolveContentViewModel(declaration, corrupted)).toThrow(ContentDataCorruptedError);
  });
});
