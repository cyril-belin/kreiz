import { describe, expect, it } from 'vitest';
import { fields } from '../src/domain/content/declaration';
import { contentLabelPlural } from '../src/domain/content/declaration';
import {
  createContentTypeRegistry,
  validateDeclarationCrossConstraints,
  type ContentTypeRegistryInput,
} from '../src/domain/content/registry';
import { UnknownContentTypeError } from '../src/domain/content/errors';
import type { ContentTypeDeclaration } from '../src/domain/content/declaration';

/**
 * Registre des types de contenu (mission §8/§33) — fonction pure : joint
 * les déclarations sérialisées (module virtuel) aux composants de template
 * et revalide tout. La navigation admin est **générée depuis le registre**
 * (mission §25) : le Core ne hardcode aucun type de demo.
 */

function declaration(overrides: Partial<ContentTypeDeclaration> = {}): ContentTypeDeclaration {
  return {
    key: 'article',
    label: 'Article',
    labelPlural: 'Articles',
    routeNamespace: 'articles',
    fields: { excerpt: fields.text({ label: 'Accroche' }) },
    template: 'src/templates/ArticleContent.astro',
    ...overrides,
  };
}

function fakeTemplate(key: string): unknown {
  return function KreizFakeTemplate() {
    return key;
  };
}

function registryInput(declarations: ContentTypeDeclaration[]): ContentTypeRegistryInput {
  return {
    declarations,
    templates: Object.fromEntries(declarations.map((d) => [d.key, fakeTemplate(d.key)])),
  };
}

describe('createContentTypeRegistry', () => {
  it('résout les déclarations avec leur composant et leur schéma dérivé', () => {
    const template = fakeTemplate('article');
    const registry = createContentTypeRegistry({
      declarations: [declaration()],
      templates: { article: template },
    });
    const resolved = registry.requireByKey('article');
    expect(typeof resolved.template).toBe('function');
    expect(resolved.template).toBe(template);
    expect(resolved.dataSchema.safeParse({ excerpt: 'ok' }).success).toBe(true);
  });

  it('list() conserve l’ordre de déclaration — base de la navigation admin', () => {
    const registry = createContentTypeRegistry(
      registryInput([
        declaration(),
        declaration({ key: 'guide', label: 'Guide', labelPlural: 'Guides', routeNamespace: 'guides' }),
        declaration({ key: 'case_study', label: 'Case Study', labelPlural: 'Réalisations', routeNamespace: 'realisations' }),
      ]),
    );
    // Exactement ce dont AdminShell a besoin pour générer « Contenu ».
    expect(registry.list().map((type) => [type.labelPlural, type.key, type.routeNamespace])).toEqual([
      ['Articles', 'article', 'articles'],
      ['Guides', 'guide', 'guides'],
      ['Réalisations', 'case_study', 'realisations'],
    ]);
  });

  it('labelPlural par défaut = label + « s » (français courant)', () => {
    expect(
      contentLabelPlural(declaration({ label: 'Service', labelPlural: undefined })),
    ).toBe('Services');
  });

  it('findByKey retourne null sur un type inconnu, requireByKey lève une erreur de domaine', () => {
    const registry = createContentTypeRegistry(registryInput([declaration()]));
    expect(registry.findByKey('inconnu')).toBeNull();
    expect(() => registry.requireByKey('inconnu')).toThrow(UnknownContentTypeError);
  });

  it('requireByNamespace résout par namespace — cohérence type ⇔ namespace', () => {
    const registry = createContentTypeRegistry(registryInput([declaration()]));
    expect(registry.requireByNamespace('articles').key).toBe('article');
    expect(registry.findByNamespace('guides')).toBeNull();
  });

  it('rejette une clé dupliquée', () => {
    expect(() =>
      createContentTypeRegistry(registryInput([declaration(), declaration()])),
    ).toThrow(/dupliquée/);
  });

  it('rejette un namespace dupliqué — deux types ne peuvent pas partager une route', () => {
    expect(() =>
      createContentTypeRegistry(
        registryInput([
          declaration(),
          declaration({ key: 'guide', label: 'Guide', routeNamespace: 'articles' }),
        ]),
      ),
    ).toThrow(/namespace de route dupliqué/);
  });

  it('rejette une déclaration mal formée', () => {
    expect(() =>
      createContentTypeRegistry(registryInput([declaration({ key: 'BAD KEY' })])),
    ).toThrow(/clé de type invalide/);
    expect(() =>
      createContentTypeRegistry(
        registryInput([declaration({ fields: { x: { kind: 'bloc', label: 'X' } as never } })]),
      ),
    ).toThrow(/vocabulaire V1/);
  });

  it('rejette un template non résolu — chaque type doit avoir son composant', () => {
    expect(() =>
      createContentTypeRegistry({ declarations: [declaration()], templates: {} }),
    ).toThrow(/template du type « article » non résolu/);
    expect(() =>
      createContentTypeRegistry({
        declarations: [declaration()],
        templates: { article: 'pas-un-composant' },
      }),
    ).toThrow(/non résolu/);
  });

  it('un registre vide est valide — un Project peut ne rien déclarer', () => {
    const registry = createContentTypeRegistry({ declarations: [], templates: {} });
    expect(registry.list()).toEqual([]);
  });
});

describe('validateDeclarationCrossConstraints — fail fast sans composants', () => {
  it('valide des clés et namespaces uniques (appelé dès la config Astro)', () => {
    expect(() =>
      validateDeclarationCrossConstraints([declaration(), declaration({ key: 'guide', routeNamespace: 'guides' })]),
    ).not.toThrow();
    expect(() => validateDeclarationCrossConstraints([declaration(), declaration()])).toThrow(
      /dupliquée/,
    );
  });
});
