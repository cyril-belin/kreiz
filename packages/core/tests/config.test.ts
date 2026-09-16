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

// ——— Formulaires de contact (slice 7) ———

import { defineContactForm } from '../src/domain/forms/declaration';
import { formFields } from '../src/domain/forms/fields';
import type { ContactFormDefinition } from '../src/domain/forms/declaration';

function contactDefinition(): ContactFormDefinition {
  return defineContactForm({
    key: 'contact',
    label: 'Contact',
    fields: {
      name: formFields.text({ label: 'Nom', required: true }),
      email: formFields.email({ label: 'Email', required: true }),
    },
    confirmationPath: '/contact/merci',
    notification: { recipients: ['dest@example.test'], subject: 'Sujet' },
  });
}

describe('kreizConfigSchema — formulaires', () => {
  it('normalise les formulaires déclarés (payloadSchema non sérialisé)', () => {
    const config = normalizeKreizConfig({ forms: [contactDefinition()] });
    expect(config.forms).toHaveLength(1);
    expect(config.forms?.[0]?.key).toBe('contact');
    expect(config.forms?.[0]?.confirmationPath).toBe('/contact/merci');
    expect(config.forms?.[0]?.notification?.recipients).toEqual(['dest@example.test']);
    expect('payloadSchema' in (config.forms?.[0] ?? {})).toBe(false);
  });

  it('rejette une clé de formulaire invalide', () => {
    expect(() =>
      kreizConfigSchema.parse({ forms: [{ ...contactDefinition(), key: 'Bad Key' }] }),
    ).toThrow();
  });

  it('rejette un chemin de confirmation externe', () => {
    expect(() =>
      kreizConfigSchema.parse({
        forms: [{ ...contactDefinition(), confirmationPath: 'https://evil.example' }],
      }),
    ).toThrow();
  });

  it('rejette des destinataires hors borne ou invalides', () => {
    expect(() =>
      kreizConfigSchema.parse({
        forms: [
          {
            ...contactDefinition(),
            notification: { recipients: ['nope'], subject: 's' },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      kreizConfigSchema.parse({
        forms: [
          {
            ...contactDefinition(),
            notification: { recipients: [], subject: 's' },
          },
        ],
      }),
    ).toThrow();
  });

  it('rejette un sujet avec caractère de contrôle', () => {
    expect(() =>
      kreizConfigSchema.parse({
        forms: [
          {
            ...contactDefinition(),
            notification: { recipients: ['a@b.test'], subject: 's\r\nX: y' },
          },
        ],
      }),
    ).toThrow();
  });

  it('rejette des champs hors vocabulaire formulaires', () => {
    expect(() =>
      kreizConfigSchema.parse({
        forms: [
          {
            ...contactDefinition(),
            fields: { x: { kind: 'richText', label: 'x' } },
          },
        ],
      }),
    ).toThrow();
  });
});
