import { describe, expect, it } from 'vitest';
import { fields, type ContentTypeDeclaration } from '../src/domain/content/declaration';
import {
  createContentTypeRegistry,
  type ContentTypeRegistryInput,
} from '../src/domain/content/registry';
import {
  ContentDataCorruptedError,
  ContentDeletedError,
  ContentNotFoundError,
  UnknownContentTypeError,
} from '../src/domain/content/errors';
import { createContentService, CONTENT_AUDIT_ACTIONS, CONTENT_TITLE_MAX_LENGTH } from '../src/services/content';
import {
  createInMemoryAuditRepository,
  createInMemoryContentRepository,
  stubContentEntry,
  type InMemoryContentState,
} from './helpers/in-memory-content';
import { createRebuildTriggerStub } from './helpers/stub-rebuild-trigger';

/**
 * Service contenu — orchestration testée **sans PostgreSQL** (doubles en
 * mémoire) : résolution du type déclaré, validation, imposition du
 * namespace serveur, slugs (auto + suffixage, collision manuelle), soft
 * delete, audit avec le vrai acteur (mission §13/§14/§33). Les comportements
 * PostgreSQL réels (index unique partiel, course 23505) sont en intégration.
 */

const actorId = crypto.randomUUID();

function articleRegistryInput(): ContentTypeRegistryInput {
  const declarations: ContentTypeDeclaration[] = [
    {
      key: 'article',
      label: 'Article',
      labelPlural: 'Articles',
      routeNamespace: 'articles',
      fields: {
        excerpt: fields.text({ label: 'Accroche', required: true }),
        body: fields.textarea({ label: 'Corps', required: true }),
      },
      template: 'src/templates/ArticleContent.astro',
    },
    {
      key: 'guide',
      label: 'Guide',
      labelPlural: 'Guides',
      routeNamespace: 'guides',
      fields: { body: fields.textarea({ label: 'Corps', required: true }) },
      template: 'src/templates/GuideContent.astro',
    },
  ];
  return {
    declarations,
    templates: Object.fromEntries(
      declarations.map((d) => [d.key, function KreizFakeTemplate() {}]),
    ),
  };
}

function createService(state?: InMemoryContentState) {
  const contentState: InMemoryContentState = state ?? {
    entries: new Map(),
    redirects: new Map(),
    auditRows: [],
  };
  const rebuild = createRebuildTriggerStub();
  const service = createContentService({
    entries: createInMemoryContentRepository(contentState),
    audit: createInMemoryAuditRepository(contentState),
    registry: createContentTypeRegistry(articleRegistryInput()),
    rebuild,
  });
  return { service, state: contentState, rebuild };
}

const validArticleData = { excerpt: 'Accroche', body: 'Corps du texte.' };

describe('createDraft', () => {
  it('crée un brouillon avec le namespace imposé par la déclaration', async () => {
    const { service, state } = createService();
    const outcome = await service.createDraft({
      contentTypeKey: 'article',
      title: 'Mon premier article',
      data: validArticleData,
      actorAdminId: actorId,
    });
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.entry.contentType).toBe('article');
    // Le namespace vient de la déclaration — le client ne peut pas en imposer un autre.
    expect(outcome.entry.routeNamespace).toBe('articles');
    expect(outcome.entry.status).toBe('draft');
    expect(outcome.entry.createdBy).toBe(actorId);
    expect(outcome.entry.updatedBy).toBe(actorId);
    expect(outcome.entry.data).toEqual(validArticleData);
    expect(state.entries.size).toBe(1);
  });

  it('génère le slug depuis le titre', async () => {
    const { service } = createService();
    const outcome = await service.createDraft({
      contentTypeKey: 'article',
      title: 'À propos des slugs !',
      data: validArticleData,
      actorAdminId: actorId,
    });
    expect(outcome.kind === 'created' && outcome.entry.slug).toBe('a-propos-des-slugs');
  });

  it('suffixe automatiquement les slugs générés en collision (foo, foo-2, foo-3)', async () => {
    const { service } = createService();
    const slugs: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const outcome = await service.createDraft({
        contentTypeKey: 'article',
        title: 'Même titre',
        data: validArticleData,
        actorAdminId: actorId,
      });
      expect(outcome.kind).toBe('created');
      if (outcome.kind === 'created') slugs.push(outcome.entry.slug);
    }
    expect(slugs).toEqual(['meme-titre', 'meme-titre-2', 'meme-titre-3']);
  });

  it('un slug saisi manuellement en collision est une erreur (jamais suffixé en silence)', async () => {
    const { service } = createService();
    await service.createDraft({
      contentTypeKey: 'article',
      title: 'Premier',
      data: validArticleData,
      actorAdminId: actorId,
    });
    const outcome = await service.createDraft({
      contentTypeKey: 'article',
      title: 'Second',
      slug: 'premier',
      data: validArticleData,
      actorAdminId: actorId,
    });
    expect(outcome).toMatchObject({ kind: 'invalid', errors: { slug: /déjà utilisé/ } });
  });

  it('un slug manuel est normalisé (même pipeline que le slug auto)', async () => {
    const { service } = createService();
    const outcome = await service.createDraft({
      contentTypeKey: 'article',
      title: 'Titre',
      slug: '  Mon Slug Choisi  ',
      data: validArticleData,
      actorAdminId: actorId,
    });
    expect(outcome.kind === 'created' && outcome.entry.slug).toBe('mon-slug-choisi');
  });

  it('valide le titre et les données spécifiques avant écriture', async () => {
    const { service, state } = createService();
    const noTitle = await service.createDraft({
      contentTypeKey: 'article',
      title: '   ',
      data: validArticleData,
      actorAdminId: actorId,
    });
    expect(noTitle).toMatchObject({ kind: 'invalid', errors: { title: /requis/ } });

    const badData = await service.createDraft({
      contentTypeKey: 'article',
      title: 'Titre',
      data: { excerpt: '', body: '' },
      actorAdminId: actorId,
    });
    expect(badData.kind).toBe('invalid');
    if (badData.kind === 'invalid') {
      expect(Object.keys(badData.errors).sort()).toEqual(['body', 'excerpt']);
    }
    // Aucune donnée invalide persistée.
    expect(state.entries.size).toBe(0);
  });

  it('rejette un titre trop long', async () => {
    const { service } = createService();
    const outcome = await service.createDraft({
      contentTypeKey: 'article',
      title: 'a'.repeat(CONTENT_TITLE_MAX_LENGTH + 1),
      data: validArticleData,
      actorAdminId: actorId,
    });
    expect(outcome.kind === 'invalid' && outcome.errors.title).toMatch(/ne doit pas dépasser/);
  });

  it('un type inconnu lève une erreur de domaine propre', async () => {
    const { service } = createService();
    await expect(
      service.createDraft({
        contentTypeKey: 'inconnu',
        title: 'Titre',
        data: {},
        actorAdminId: actorId,
      }),
    ).rejects.toThrow(UnknownContentTypeError);
  });

  it('isole les types : les données d’un article ne mélangent jamais un guide', async () => {
    const { service, state } = createService();
    await service.createDraft({
      contentTypeKey: 'article',
      title: 'Article un',
      data: validArticleData,
      actorAdminId: actorId,
    });
    const guide = await service.createDraft({
      contentTypeKey: 'guide',
      title: 'Article un', // même titre, autre namespace → même slug, sans collision
      data: { body: 'Corps guide.' },
      actorAdminId: actorId,
    });
    expect(guide.kind === 'created' && guide.entry.routeNamespace).toBe('guides');
    expect(guide.kind === 'created' && guide.entry.data).toEqual({ body: 'Corps guide.' });
    expect(state.entries.size).toBe(2);
  });

  it('écrit l’audit content.created avec le vrai acteur', async () => {
    const { service, state } = createService();
    const outcome = await service.createDraft({
      contentTypeKey: 'article',
      title: 'Titre',
      data: validArticleData,
      actorAdminId: actorId,
    });
    expect(outcome.kind).toBe('created');
    const row = state.auditRows.at(-1);
    expect(row).toMatchObject({
      actorAdminId: actorId,
      action: CONTENT_AUDIT_ACTIONS.created,
      entityType: 'content_entry',
    });
    expect(row?.metadata).toMatchObject({ contentType: 'article', slug: 'titre' });
  });
});

describe('updateDraft', () => {
  async function createExisting() {
    const { service, state } = createService();
    const outcome = await service.createDraft({
      contentTypeKey: 'article',
      title: 'Version initiale',
      data: validArticleData,
      actorAdminId: actorId,
    });
    if (outcome.kind !== 'created') throw new Error('setup: création attendue');
    return { service, state, entry: outcome.entry };
  }

  it('modifie le titre et les données, trace updated_by et l’audit', async () => {
    const { service, state, entry } = await createExisting();
    const secondActor = crypto.randomUUID();
    const outcome = await service.updateDraft({
      entryId: entry.id,
      title: 'Version modifiée',
      data: { excerpt: 'Nouvelle accroche', body: 'Nouveau corps.' },
      actorAdminId: secondActor,
    });
    expect(outcome.kind).toBe('updated');
    if (outcome.kind !== 'updated') return;
    expect(outcome.entry.title).toBe('Version modifiée');
    expect(outcome.entry.updatedBy).toBe(secondActor);
    expect(state.auditRows.at(-1)?.action).toBe(CONTENT_AUDIT_ACTIONS.updated);
    expect(state.auditRows.at(-1)?.actorAdminId).toBe(secondActor);
  });

  it('conserve le slug si aucun n’est soumis ; le modifie s’il est fourni', async () => {
    const { service, entry } = await createExisting();
    const unchanged = await service.updateDraft({
      entryId: entry.id,
      title: entry.title,
      data: validArticleData,
      actorAdminId: actorId,
    });
    expect(unchanged.kind === 'updated' && unchanged.entry.slug).toBe('version-initiale');

    const changed = await service.updateDraft({
      entryId: entry.id,
      title: entry.title,
      slug: 'nouveau-slug',
      data: validArticleData,
      actorAdminId: actorId,
    });
    expect(changed.kind === 'updated' && changed.entry.slug).toBe('nouveau-slug');
  });

  it('un slug modifié en collision est une erreur de validation', async () => {
    const { service, entry } = await createExisting();
    await service.createDraft({
      contentTypeKey: 'article',
      title: 'Autre article',
      data: validArticleData,
      actorAdminId: actorId,
    });
    const outcome = await service.updateDraft({
      entryId: entry.id,
      title: entry.title,
      slug: 'autre-article',
      data: validArticleData,
      actorAdminId: actorId,
    });
    expect(outcome).toMatchObject({ kind: 'invalid', errors: { slug: /déjà utilisé/ } });
  });

  it('conserver son propre slug n’est pas une collision', async () => {
    const { service, entry } = await createExisting();
    const outcome = await service.updateDraft({
      entryId: entry.id,
      title: entry.title,
      slug: entry.slug,
      data: validArticleData,
      actorAdminId: actorId,
    });
    expect(outcome.kind).toBe('updated');
  });

  it('contenu introuvable → ContentNotFoundError ; supprimé → ContentDeletedError', async () => {
    const { service, entry } = await createExisting();
    await expect(
      service.updateDraft({ entryId: '00000000-0000-0000-0000-000000000000', title: 'x', data: validArticleData, actorAdminId: actorId }),
    ).rejects.toThrow(ContentNotFoundError);

    await service.deleteDraft({ entryId: entry.id, actorAdminId: actorId });
    await expect(
      service.updateDraft({ entryId: entry.id, title: 'x', data: validArticleData, actorAdminId: actorId }),
    ).rejects.toThrow(ContentDeletedError);
  });

  it('valide les données contre le schéma du type de l’entrée (source de vérité en base)', async () => {
    const { service, entry } = await createExisting();
    const outcome = await service.updateDraft({
      entryId: entry.id,
      title: entry.title,
      data: { excerpt: 'ok' }, // body requis manquant
      actorAdminId: actorId,
    });
    expect(outcome).toMatchObject({ kind: 'invalid', errors: { body: /requis/ } });
  });
});

describe('listContent', () => {
  it('liste les contenus actifs du type, hors supprimés, hors autres types', async () => {
    const { service } = createService();
    const article = await service.createDraft({
      contentTypeKey: 'article',
      title: 'Article actif',
      data: validArticleData,
      actorAdminId: actorId,
    });
    await service.createDraft({ contentTypeKey: 'guide', title: 'Guide', data: { body: 'x' }, actorAdminId: actorId });
    if (article.kind !== 'created') throw new Error('setup');
    await service.deleteDraft({ entryId: article.entry.id, actorAdminId: actorId });
    await service.createDraft({
      contentTypeKey: 'article',
      title: 'Article après suppression',
      data: validArticleData,
      actorAdminId: actorId,
    });

    const rows = await service.listContent('article');
    expect(rows.map((row) => row.title)).toEqual(['Article après suppression']);
  });

  it('lève UnknownContentTypeError sur une clé non déclarée', async () => {
    const { service } = createService();
    await expect(service.listContent('inconnu')).rejects.toThrow(UnknownContentTypeError);
  });
});

describe('getContentForEdit / getContentForPreview', () => {
  it('retourne l’entrée, la déclaration et la vue validée', async () => {
    const { service } = createService();
    const created = await service.createDraft({
      contentTypeKey: 'article',
      title: 'Éditable',
      data: validArticleData,
      actorAdminId: actorId,
    });
    if (created.kind !== 'created') throw new Error('setup');
    const loaded = await service.getContentForEdit(created.entry.id);
    expect(loaded.declaration.key).toBe('article');
    expect(loaded.view.title).toBe('Éditable');
    expect(loaded.view.data).toEqual(validArticleData);
    const preview = await service.getContentForPreview(created.entry.id);
    expect(preview.view.id).toBe(created.entry.id);
  });

  it('des données invalides en base lèvent ContentDataCorruptedError — jamais un rendu silencieux', async () => {
    const { service, state } = createService();
    const created = await service.createDraft({
      contentTypeKey: 'article',
      title: 'Corrompu',
      data: validArticleData,
      actorAdminId: actorId,
    });
    if (created.kind !== 'created') throw new Error('setup');
    // Écriture directe « en base » (équivalent SQL brut) : data invalide.
    state.entries.set(created.entry.id, stubContentEntry({
      ...created.entry,
      data: { excerpt: 'ok' } as Record<string, unknown>, // body requis manquant
    }));
    await expect(service.getContentForEdit(created.entry.id)).rejects.toThrow(
      ContentDataCorruptedError,
    );
  });

  it('un contenu supprimé n’est plus éditable ni prévisualisable', async () => {
    const { service } = createService();
    const created = await service.createDraft({
      contentTypeKey: 'article',
      title: 'Supprimé',
      data: validArticleData,
      actorAdminId: actorId,
    });
    if (created.kind !== 'created') throw new Error('setup');
    await service.deleteDraft({ entryId: created.entry.id, actorAdminId: actorId });
    await expect(service.getContentForEdit(created.entry.id)).rejects.toThrow(ContentDeletedError);
    await expect(service.getContentForPreview(created.entry.id)).rejects.toThrow(ContentDeletedError);
  });

  it('un contenu absent lève ContentNotFoundError', async () => {
    const { service } = createService();
    await expect(service.getContentForEdit('00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      ContentNotFoundError,
    );
  });
});

describe('deleteDraft — soft delete', () => {
  it('supprime en soft, audite, libère le slug dans le namespace', async () => {
    const { service, state } = createService();
    const created = await service.createDraft({
      contentTypeKey: 'article',
      title: 'À supprimer',
      data: validArticleData,
      actorAdminId: actorId,
    });
    if (created.kind !== 'created') throw new Error('setup');

    const outcome = await service.deleteDraft({ entryId: created.entry.id, actorAdminId: actorId });
    expect(outcome).toEqual({
      kind: 'deleted',
      entryId: created.entry.id,
      wasPublished: false,
      rebuild: null,
    });

    const stored = state.entries.get(created.entry.id);
    expect(stored?.deletedAt).toBeInstanceOf(Date);
    expect(stored?.slug).toBe('a-supprimer'); // la ligne existe toujours (pas de purge physique)

    expect(state.auditRows.at(-1)).toMatchObject({
      actorAdminId: actorId,
      action: CONTENT_AUDIT_ACTIONS.deleted,
      entityId: created.entry.id,
    });

    // Le slug libéré est réutilisable (sémantique de l'index unique partiel).
    const recreated = await service.createDraft({
      contentTypeKey: 'article',
      title: 'À supprimer',
      data: validArticleData,
      actorAdminId: actorId,
    });
    expect(recreated.kind === 'created' && recreated.entry.slug).toBe('a-supprimer');
  });

  it('double suppression → ContentDeletedError ; absence → ContentNotFoundError', async () => {
    const { service } = createService();
    const created = await service.createDraft({
      contentTypeKey: 'article',
      title: 'Titre',
      data: validArticleData,
      actorAdminId: actorId,
    });
    if (created.kind !== 'created') throw new Error('setup');
    await service.deleteDraft({ entryId: created.entry.id, actorAdminId: actorId });
    await expect(service.deleteDraft({ entryId: created.entry.id, actorAdminId: actorId })).rejects.toThrow(
      ContentDeletedError,
    );
    await expect(
      service.deleteDraft({ entryId: '00000000-0000-0000-0000-000000000000', actorAdminId: actorId }),
    ).rejects.toThrow(ContentNotFoundError);
  });

  it('suppression d’un contenu PUBLIÉ → rebuild demandé ; brouillon jamais publié → aucun rebuild (mission §31)', async () => {
    const { service, state, rebuild } = createService();
    // Brouillon jamais publié : suppression sans rebuild.
    const draft = await service.createDraft({
      contentTypeKey: 'article',
      title: 'Brouillon jetable',
      data: validArticleData,
      actorAdminId: actorId,
    });
    if (draft.kind !== 'created') throw new Error('setup');
    await service.deleteDraft({ entryId: draft.entry.id, actorAdminId: actorId });
    expect(rebuild.calls).toHaveLength(0);

    // Contenu publié (snapshots figés) : sa page est dans le dernier build → rebuild.
    const published = stubContentEntry({
      title: 'Publié à supprimer',
      slug: 'publié-a-supprimer',
      status: 'published',
      publishedAt: new Date(),
      publishedSlug: 'publié-a-supprimer',
      publishedTitle: 'Publié à supprimer',
      publishedData: validArticleData,
      publishedSeo: {},
      createdBy: actorId,
      updatedBy: actorId,
    });
    state.entries.set(published.id, published);
    rebuild.calls.length = 0;

    const outcome = await service.deleteDraft({ entryId: published.id, actorAdminId: actorId });
    expect(outcome.wasPublished).toBe(true);
    expect(outcome.rebuild).toEqual({ ok: true, requestId: 'req-stub' });
    expect(rebuild.calls).toEqual([{ reason: 'content.deleted' }]);
    // L'échec du trigger après suppression : DB reste soft-deleted, échec audité.
    rebuild.nextResult = { ok: false, failure: { kind: 'rejected', statusCode: 500 } };
    const published2 = stubContentEntry({
      status: 'published',
      publishedAt: new Date(),
      publishedSlug: 'publié-2',
      publishedTitle: 'Publié 2',
      publishedData: validArticleData,
      publishedSeo: {},
      createdBy: actorId,
      updatedBy: actorId,
    });
    state.entries.set(published2.id, published2);
    const outcome2 = await service.deleteDraft({ entryId: published2.id, actorAdminId: actorId });
    expect(outcome2.rebuild).toEqual({ ok: false, failure: { kind: 'rejected', statusCode: 500 } });
    expect(state.entries.get(published2.id)?.deletedAt).toBeInstanceOf(Date);
    expect(
      state.auditRows.some(
        (row) => row.action === 'site.rebuild_failed' && row.actorAdminId === actorId,
      ),
    ).toBe(true);
  });
});
