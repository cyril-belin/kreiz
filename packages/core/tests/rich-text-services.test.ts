import { describe, expect, it } from 'vitest';
import { fields, type ContentTypeDeclaration } from '../src/domain/content/declaration';
import {
  createContentTypeRegistry,
  type ContentTypeRegistryInput,
} from '../src/domain/content/registry';
import type { KreizContentEntry } from '../src/data/tables/content-entries';
import type { KreizMedia } from '../src/data/tables/media';
import { createPublicationService } from '../src/services/publication';
import { createMediaAdminService } from '../src/services/media-admin';
import {
  resolveContentViewModel,
  collectRichTextMediaIds,
} from '../src/domain/content/view-model';
import { ContentDataCorruptedError } from '../src/domain/content/errors';
import {
  createInMemoryAuditRepository,
  createInMemoryContentRepository,
  createInMemoryRedirectsRepository,
  stubContentEntry,
  type InMemoryContentState,
} from './helpers/in-memory-content';
import {
  createInMemoryMediaRepository,
  createInMemoryStorage,
  stubMediaRow,
} from './helpers/in-memory-media';
import { createRebuildTriggerStub } from './helpers/stub-rebuild-trigger';

/**
 * Rich text × services (slice 6 §12/§13/§26) — publication (validation des
 * références médias, avant toute écriture), suppression protégée par les
 * références rich text, vues admin/public. Les sémantiques SQL réelles
 * (comptage JSONB) sont en intégration Neon.
 */

const actorAdminId = crypto.randomUUID();
const MEDIA_READY = crypto.randomUUID();
const MEDIA_NO_ALT = crypto.randomUUID();
const MEDIA_FAILED = crypto.randomUUID();

function richDocument(mediaId: string): Record<string, unknown> {
  return {
    version: 1,
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Avant image' }] },
      { type: 'media', attrs: { mediaId, caption: 'Une légende' } },
    ],
  };
}

function registryInput(): ContentTypeRegistryInput {
  const declarations: ContentTypeDeclaration[] = [
    {
      key: 'article',
      label: 'Article',
      routeNamespace: 'articles',
      fields: {
        excerpt: fields.text({ label: 'Accroche', required: true }),
        body: fields.richText({ label: 'Corps', required: true }),
      },
      template: 'src/templates/ArticleContent.astro',
    },
  ];
  return {
    declarations,
    templates: Object.fromEntries(
      declarations.map((d) => [d.key, function KreizFakeTemplate() {}]),
    ),
  };
}

function mediaState(): {
  state: InMemoryContentState;
  media: Map<string, KreizMedia>;
} {
  const state: InMemoryContentState = { entries: new Map(), redirects: new Map(), auditRows: [] };
  const media = new Map<string, KreizMedia>(
    [
      stubMediaRow({ id: MEDIA_READY, status: 'ready', altText: 'Alt renseigné' }),
      stubMediaRow({ id: MEDIA_NO_ALT, status: 'ready', altText: '' }),
      stubMediaRow({ id: MEDIA_FAILED, status: 'failed', failureReason: 'transform-failed' }),
    ].map((row) => [row.id, row]),
  );
  return { state, media };
}

function setupPublication(media: Map<string, KreizMedia>, mediaPublicBaseUrl: string | null) {
  const { state } = mediaState();
  const rebuild = createRebuildTriggerStub();
  const service = createPublicationService({
    entries: createInMemoryContentRepository(state),
    media: createInMemoryMediaRepository({ media, auditRows: [], entries: state.entries }),
    redirects: createInMemoryRedirectsRepository(state),
    audit: createInMemoryAuditRepository(state),
    registry: createContentTypeRegistry(registryInput()),
    rebuild,
    mediaPublicBaseUrl,
  });
  return { service, state, rebuild };
}

describe('publication — validation des médias du rich text (slice 6 §12)', () => {
  it('média ready avec alt : publication acceptée, snapshot figé', async () => {
    const { media } = mediaState();
    const { service, state } = setupPublication(media, 'https://media.ex/cdn');
    const entry = stubContentEntry({
      data: { excerpt: 'A', body: richDocument(MEDIA_READY) },
      status: 'draft',
    });
    state.entries.set(entry.id, entry);

    const outcome = await service.publishContent({ entryId: entry.id, actorAdminId });
    expect(outcome.kind).toBe('published');
    if (outcome.kind !== 'published') return;
    expect(outcome.entry.publishedData).toEqual({ excerpt: 'A', body: richDocument(MEDIA_READY) });
    // La vue retournée contient le HTML rendu (figure) — prêt pour build.
    expect(outcome.view.richText['body']?.html).toContain('<figure');
  });

  it('média failed : publication refusée explicitement, aucune écriture', async () => {
    const { media } = mediaState();
    const { service, state } = setupPublication(media, 'https://media.ex/cdn');
    const entry = stubContentEntry({
      data: { excerpt: 'A', body: richDocument(MEDIA_FAILED) },
      status: 'draft',
    });
    state.entries.set(entry.id, entry);

    const outcome = await service.publishContent({ entryId: entry.id, actorAdminId });
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind !== 'invalid') return;
    expect(outcome.errors['body']).toMatch(/non prêt/);
    // Aucun effet de bord.
    expect(state.entries.get(entry.id)?.status).toBe('draft');
    expect(state.entries.get(entry.id)?.publishedData).toBeNull();
  });

  it('média inexistant : publication refusée', async () => {
    const { media } = mediaState();
    const { service, state } = setupPublication(media, 'https://media.ex/cdn');
    const entry = stubContentEntry({
      data: { excerpt: 'A', body: richDocument(crypto.randomUUID()) },
      status: 'draft',
    });
    state.entries.set(entry.id, entry);

    const outcome = await service.publishContent({ entryId: entry.id, actorAdminId });
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind !== 'invalid') return;
    expect(outcome.errors['body']).toMatch(/n’existe plus/);
  });

  it('média sans alt : publication refusée (politique alt canonique, slice 6 §19)', async () => {
    const { media } = mediaState();
    const { service, state } = setupPublication(media, 'https://media.ex/cdn');
    const entry = stubContentEntry({
      data: { excerpt: 'A', body: richDocument(MEDIA_NO_ALT) },
      status: 'draft',
    });
    state.entries.set(entry.id, entry);

    const outcome = await service.publishContent({ entryId: entry.id, actorAdminId });
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind !== 'invalid') return;
    expect(outcome.errors['body']).toMatch(/texte alternatif/);
  });

  it('stockage public non configuré : publication refusée', async () => {
    const { media } = mediaState();
    const { service, state } = setupPublication(media, null);
    const entry = stubContentEntry({
      data: { excerpt: 'A', body: richDocument(MEDIA_READY) },
      status: 'draft',
    });
    state.entries.set(entry.id, entry);

    const outcome = await service.publishContent({ entryId: entry.id, actorAdminId });
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind !== 'invalid') return;
    expect(outcome.errors['body']).toMatch(/KREIZ_STORAGE_PUBLIC_BASE_URL/);
  });

  it('document structurellement invalide : refus par le schéma (pas par la validation médias)', async () => {
    const { media } = mediaState();
    const { service, state } = setupPublication(media, 'https://media.ex/cdn');
    const entry = stubContentEntry({
      data: {
        excerpt: 'A',
        body: { version: 1, type: 'doc', content: [{ type: 'rawHtml' }] },
      },
      status: 'draft',
    });
    state.entries.set(entry.id, entry);

    const outcome = await service.publishContent({ entryId: entry.id, actorAdminId });
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind !== 'invalid') return;
    expect(outcome.errors['body']).toBeTruthy();
  });
});

describe('suppression — protection par références rich text (slice 6 §13)', () => {
  function mediaServiceFor(entries: Map<string, KreizContentEntry>) {
    const media = new Map<string, KreizMedia>([
      [MEDIA_READY, stubMediaRow({ id: MEDIA_READY, status: 'ready', altText: 'Alt' })],
    ]);
    const auditRows: Array<{ action: string }> = [];
    const service = createMediaAdminService({
      media: createInMemoryMediaRepository({ media, auditRows: auditRows as never, entries }),
      audit: { append: async () => ({}) } as never,
      storage: createInMemoryStorage(),
    });
    return service;
  }

  it('média référencé dans un corps courant : suppression refusée', async () => {
    const entry = stubContentEntry({ data: { excerpt: 'A', body: richDocument(MEDIA_READY) } });
    const entries = new Map<string, KreizContentEntry>([[entry.id, entry]]);
    const service = mediaServiceFor(entries);
    await expect(service.deleteMedia({ mediaId: MEDIA_READY, actorAdminId })).rejects.toMatchObject({
      name: 'MediaInUseError',
    });
    // Rien n'a été supprimé.
    expect(entries.size).toBe(1);
  });

  it('média référencé uniquement par le snapshot publié : suppression refusée', async () => {
    const entry = stubContentEntry({
      data: { excerpt: 'A', body: { version: 1, type: 'doc', content: [] } },
      publishedData: { excerpt: 'A', body: richDocument(MEDIA_READY) },
      status: 'published',
    });
    const entries = new Map<string, KreizContentEntry>([[entry.id, entry]]);
    const service = mediaServiceFor(entries);
    await expect(service.deleteMedia({ mediaId: MEDIA_READY, actorAdminId })).rejects.toMatchObject({
      name: 'MediaInUseError',
    });
  });

  it('contenu soft-deleted référençant le média : suppression toujours refusée', async () => {
    const entry = stubContentEntry({
      data: { excerpt: 'A', body: richDocument(MEDIA_READY) },
      deletedAt: new Date(),
    });
    const entries = new Map<string, KreizContentEntry>([[entry.id, entry]]);
    const service = mediaServiceFor(entries);
    await expect(service.deleteMedia({ mediaId: MEDIA_READY, actorAdminId })).rejects.toMatchObject({
      name: 'MediaInUseError',
    });
  });

  it('référence retirée : suppression autorisée', async () => {
    const entry = stubContentEntry({
      data: { excerpt: 'A', body: { version: 1, type: 'doc', content: [] } },
    });
    const entries = new Map<string, KreizContentEntry>([[entry.id, entry]]);
    const service = mediaServiceFor(entries);
    await expect(service.deleteMedia({ mediaId: MEDIA_READY, actorAdminId })).resolves.toMatchObject({
      deleted: true,
    });
  });
});

describe('vues — richText résolu pour les templates (slice 6 §15)', () => {
  const declaration = createContentTypeRegistry(registryInput()).requireByKey('article');

  it('view.richText[name] porte le document + le HTML rendu (mode strict public)', () => {
    const entry = stubContentEntry({
      data: { excerpt: 'A', body: richDocument(MEDIA_READY) },
    });
    const view = resolveContentViewModel(declaration, entry, {
      richTextMedia: new Map([
        [
          MEDIA_READY,
          {
            id: MEDIA_READY,
            alt: 'Alt',
            width: 1600,
            height: 900,
            variants: [
              { url: `https://media.ex/cdn/${MEDIA_READY}/800.webp`, width: 800, format: 'image/webp', height: 450 },
            ],
          },
        ],
      ]),
    });
    expect(view.richText['body']?.html).toContain('<figure');
    expect(view.richText['body']?.html).toContain('Une légende');
    expect(view.richText['body']?.html).toContain('Avant image');
  });

  it('mode strict (public) : référence non résolue = corruption explicite', () => {
    const entry = stubContentEntry({
      data: { excerpt: 'A', body: richDocument(MEDIA_READY) },
    });
    expect(() => resolveContentViewModel(declaration, entry, {})).toThrow(ContentDataCorruptedError);
  });

  it('mode admin (best-effort) : média non résoluble → figure omise, vue rendue', () => {
    const entry = stubContentEntry({
      data: { excerpt: 'A', body: richDocument(MEDIA_FAILED) },
    });
    const view = resolveContentViewModel(declaration, entry, { richTextStrict: false });
    expect(view.richText['body']?.html).not.toContain('<figure');
    expect(view.richText['body']?.html).toContain('<p>Avant image</p>');
  });

  it('collectRichTextMediaIds : agrégation sur tous les champs richText', () => {
    const ids = collectRichTextMediaIds(declaration.fields, {
      excerpt: 'A',
      body: richDocument(MEDIA_READY),
      extra: richDocument(MEDIA_FAILED),
    } as Record<string, unknown>);
    expect(ids).toEqual([MEDIA_READY]);
  });
});
