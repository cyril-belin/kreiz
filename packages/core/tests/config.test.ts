import { describe, expect, it } from 'vitest';
import { kreizConfigSchema, normalizeKreizConfig } from '../src/config';
import { fields, defineContentType } from '../src/domain/content/declaration';
import type { ContentTypeDefinition } from '../src/domain/content/declaration';

function articleDefinition(): ContentTypeDefinition {
  return defineContentType({
    key: 'article',
    label: 'Article',
    labelPlural: 'Articles',
    routeNamespace: 'articles',
    fields: {
      excerpt: fields.text({ label: 'Accroche', required: true }),
      body: fields.textarea({ label: 'Corps', required: true }),
    },
    template: 'src/templates/ArticleContent.astro',
  });
}

describe('kreizConfigSchema', () => {
  it('accepte une configuration vide', () => {
    expect(normalizeKreizConfig({})).toEqual({});
    expect(normalizeKreizConfig(undefined)).toEqual({});
  });

  it('normalise les types de contenu déclarés par le Project', () => {
    const config = normalizeKreizConfig({ content: { types: [articleDefinition()] } });
    expect(config.content?.types).toHaveLength(1);
    expect(config.content?.types[0]?.key).toBe('article');
    expect(config.content?.types[0]?.routeNamespace).toBe('articles');
    expect(config.content?.types[0]?.template).toBe('src/templates/ArticleContent.astro');
    // Le schéma dérivé (non sérialisable) ne voyage pas dans la config.
    expect('dataSchema' in (config.content?.types[0] ?? {})).toBe(false);
  });

  it('rejette une clé inconnue — la configuration n’est jamais ignorée silencieusement', () => {
    expect(() => kreizConfigSchema.parse({ spike: { message: 'x' } })).toThrow();
    expect(() => kreizConfigSchema.parse({ unknownKey: true })).toThrow();
  });

  it('rejette une clé de type invalide', () => {
    expect(() =>
      kreizConfigSchema.parse({
        content: { types: [{ ...articleDefinition(), key: 'Mauvaise Clé' }] },
      }),
    ).toThrow();
  });

  it('rejette un namespace de route invalide', () => {
    expect(() =>
      kreizConfigSchema.parse({
        content: { types: [{ ...articleDefinition(), routeNamespace: 'Mes Articles' }] },
      }),
    ).toThrow();
  });

  it('rejette des champs hors vocabulaire V1', () => {
    expect(() =>
      kreizConfigSchema.parse({
        content: {
          types: [
            {
              ...articleDefinition(),
              fields: { body: { kind: 'pluginWidget', label: 'Corps' } },
            },
          ],
        },
      }),
    ).toThrow();
  });

  it('rejette un template manquant', () => {
    const { template: _template, ...withoutTemplate } = articleDefinition();
    void _template;
    expect(() => kreizConfigSchema.parse({ content: { types: [withoutTemplate] } })).toThrow();
  });
});
