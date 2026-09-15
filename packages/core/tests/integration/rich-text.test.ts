import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createMediaRepository } from '../../src/data/repositories/media';
import { createContentEntriesRepository } from '../../src/data/repositories/content-entries';
import { createAdminAuditLogRepository } from '../../src/data/repositories/admin-audit-log';
import { createRedirectsRepository } from '../../src/data/repositories/redirects';
import { createAdminUsersRepository } from '../../src/data/repositories/admin-users';
import {
  defineContentType,
  fields,
  type ContentTypeDeclaration,
} from '../../src/domain/content/declaration';
import {
  createContentTypeRegistry,
  type ContentTypeRegistryInput,
} from '../../src/domain/content/registry';
import { ContentDataCorruptedError } from '../../src/domain/content/errors';
import { hasUnpublishedChanges } from '../../src/domain/content/publication-state';
import { createContentService } from '../../src/services/content';
import { createPublicationService } from '../../src/services/publication';
import { createMediaAdminService } from '../../src/services/media-admin';
import { createInMemoryStorage } from '../helpers/in-memory-media';
import { createRebuildTriggerStub } from '../helpers/stub-rebuild-trigger';
import { describeIntegration, setupIntegration, withTransientNetworkRetry, type IntegrationHarness } from './helpers';

/**
 * Rich text sur **PostgreSQL réel** (slice 6 §34) — roundtrip JSONB, Save ≠
 * Publish sur le corps, validation des références médias à la publication,
 * suppression protégée par les références rich text (comptage JSONB
 * `jsonb_path_exists` réel), compat des contenus **pré-slice 6** (corps en
 * texte simple), cohérence du lecteur de build.
 *
 * Isolation : les fixtures custom vivent sous une **clé de type propre au
 * run** (`rt_<runId>`) — le build démo du test public-build (parallèle sur
 * la même base) ne doit jamais les lire. La seule exception assumée est le
 * test de compat legacy : la ligne pré-slice 6 est créée sous le type
 * **démo** `article` (avec `author`, son corps restant une simple chaîne) —
 * c'est exactement ce que le build démo doit savoir tolérer.
 *
 * 0 résidu : chaque fixture est attachée à l'admin de test, supprimé en
 * afterAll (ordre FK inverse).
 */

const runId = crypto.randomUUID().slice(0, 8);
const RUN_TYPE = `rt_${runId}`;
const MEDIA_PUBLIC_BASE_URL = 'https://media.example.test/cdn';

const MEDIA_READY = crypto.randomUUID();
const MEDIA_NO_ALT = crypto.randomUUID();
const MEDIA_FAILED = crypto.randomUUID();
const MEDIA_UNREFERENCED = crypto.randomUUID();
// Médias dédiés au test de comptage (aucun autre test ne les référence).
const MEDIA_COUNT = crypto.randomUUID();
const MEDIA_COUNT_NESTED = crypto.randomUUID();

function doc(mediaId: string, extraBlocks: unknown[] = []): Record<string, unknown> {
  return {
    version: 1,
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: `Corps ${runId}` }] },
      { type: 'media', attrs: { mediaId, caption: 'Légende du corps' } },
      ...extraBlocks,
    ],
  };
}

function plainDoc(text: string): Record<string, unknown> {
  return { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function registryInput(key: string): ContentTypeRegistryInput {
  const declarations: ContentTypeDeclaration[] = [
    {
      key,
      label: 'Article',
      routeNamespace: 'articles',
      fields: {
        excerpt: fields.text({ label: 'Accroche', required: true, maxLength: 300 }),
        body: fields.richText({ label: 'Corps', required: true }),
        // Miroir du type démo `article` — optionnel ici : les fixtures du
        // run s'en passent, la ligne legacy (pré-slice 6) le porte.
        author: fields.text({ label: 'Auteur', maxLength: 120 }),
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

describeIntegration('rich text — repository, publication, références, compat (base réelle)', () => {
  let harness: IntegrationHarness;
  let adminId: string;
  let mediaRepo: ReturnType<typeof createMediaRepository>;
  let entriesRepo: ReturnType<typeof createContentEntriesRepository>;
  let content: ReturnType<typeof createContentService>;
  let publication: ReturnType<typeof createPublicationService>;
  let mediaAdmin: ReturnType<typeof createMediaAdminService>;
  // Registre miroir du type démo `article` (slice 6) — pour la ligne legacy.
  const demoLikeRegistry = createContentTypeRegistry(registryInput('article'));
  const rebuildStub = createRebuildTriggerStub();

  async function createMediaRow(id: string, alt: string, status: 'ready' | 'failed'): Promise<void> {
    await mediaRepo.createUploading({
      id,
      storageKey: `media/${id}/original`,
      mime: 'image/png',
      sizeBytes: 20_000,
      uploadedBy: adminId,
    });
    await mediaRepo.markProcessing(id, { updatedAt: new Date() });
    if (status === 'ready') {
      await mediaRepo.markReady(id, {
        width: 1200,
        height: 800,
        variants: [
          { key: `media/${id}/400.webp`, width: 400, format: 'webp', sizeBytes: 20_000 },
          { key: `media/${id}/800.webp`, width: 800, format: 'webp', sizeBytes: 40_000 },
        ],
        updatedAt: new Date(),
      });
    } else {
      await mediaRepo.markFailed(id, { failureReason: 'transform-failed', updatedAt: new Date() });
    }
    await mediaRepo.updateAlt(id, { altText: alt, updatedAt: new Date() });
  }

  beforeAll(async () => {
    harness = await setupIntegration();
    mediaRepo = createMediaRepository(harness.db);
    entriesRepo = createContentEntriesRepository(harness.db);
    const users = createAdminUsersRepository(harness.db);
    const admin = await withTransientNetworkRetry(() =>
      users.create({
        email: `it-${runId}-richtext@example.test`,
        passwordHash: 'hash-test',
        name: 'Admin rich text',
      }),
    );
    adminId = admin.id;

    const registry = createContentTypeRegistry(registryInput(RUN_TYPE));
    const audit = createAdminAuditLogRepository(harness.db);
    content = createContentService({
      entries: entriesRepo,
      media: mediaRepo,
      audit,
      registry,
      rebuild: rebuildStub,
      mediaPublicBaseUrl: MEDIA_PUBLIC_BASE_URL,
    });
    publication = createPublicationService({
      entries: entriesRepo,
      media: mediaRepo,
      audit,
      registry,
      redirects: createRedirectsRepository(harness.db),
      rebuild: rebuildStub,
      mediaPublicBaseUrl: MEDIA_PUBLIC_BASE_URL,
    });
    mediaAdmin = createMediaAdminService({ media: mediaRepo, audit, storage: createInMemoryStorage() });

    await createMediaRow(MEDIA_READY, `Image prête ${runId}`, 'ready');
    await createMediaRow(MEDIA_NO_ALT, '', 'ready');
    await createMediaRow(MEDIA_FAILED, `Image échouée ${runId}`, 'failed');
    await createMediaRow(MEDIA_UNREFERENCED, `Image libre ${runId}`, 'ready');
    await createMediaRow(MEDIA_COUNT, `Image comptage ${runId}`, 'ready');
    await createMediaRow(MEDIA_COUNT_NESTED, `Image comptage imbriquée ${runId}`, 'ready');
  }, 120_000);

  afterAll(async () => {
    if (!harness) return;
    await withTransientNetworkRetry(() =>
      harness.raw(sql`delete from kreiz_content_entries where created_by = ${adminId}`),
    );
    await harness.raw(sql`delete from kreiz_media where uploaded_by = ${adminId}`);
    await harness.raw(sql`delete from kreiz_admin_audit_log where actor_admin_id = ${adminId}`);
    await harness.raw(sql`delete from kreiz_admin_users where id = ${adminId}`);
    await harness.close();
  }, 60_000);

  it('save → load : le document JSONB repart identique (roundtrip canonique)', async () => {
    const document = doc(MEDIA_READY, [
      {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Puce' }] }] }],
      },
    ]);
    const created = await content.createDraft({
      contentTypeKey: RUN_TYPE,
      title: `Roundtrip ${runId}`,
      data: { excerpt: 'Accroche', body: document },
      actorAdminId: adminId,
    });
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;

    const loaded = await entriesRepo.findById(created.entry.id);
    expect(loaded?.data).toEqual({ excerpt: 'Accroche', body: document });
  });

  it('comptage JSONB : références courante, publiée, imbriquée, soft-deleted — pas de faux positif', async () => {
    // Courante + imbriquée dans une citation.
    const a = await entriesRepo.create({
      contentType: RUN_TYPE,
      routeNamespace: 'articles',
      title: `Refs A ${runId}`,
      slug: `rt-a-${runId}`,
      status: 'draft',
      data: {
        excerpt: 'A',
        body: doc(MEDIA_COUNT, [
          { type: 'blockquote', content: [{ type: 'media', attrs: { mediaId: MEDIA_COUNT_NESTED } }] },
        ]),
      },
      createdBy: adminId,
      updatedBy: adminId,
    });
    // Référence par snapshot uniquement (courant = document sans média).
    const b = await entriesRepo.create({
      contentType: RUN_TYPE,
      routeNamespace: 'articles',
      title: `Refs B ${runId}`,
      slug: `rt-b-${runId}`,
      status: 'published',
      publishedAt: new Date(),
      publishedSlug: `rt-b-${runId}`,
      publishedTitle: `Refs B ${runId}`,
      publishedData: { excerpt: 'B', body: doc(MEDIA_COUNT) },
      publishedSeo: {},
      data: { excerpt: 'B', body: plainDoc('sans média') },
      createdBy: adminId,
      updatedBy: adminId,
    });
    // Soft-deleted : continue de compter.
    const c = await entriesRepo.create({
      contentType: RUN_TYPE,
      routeNamespace: 'articles',
      title: `Refs C ${runId}`,
      slug: `rt-c-${runId}`,
      status: 'draft',
      data: { excerpt: 'C', body: doc(MEDIA_COUNT) },
      createdBy: adminId,
      updatedBy: adminId,
    });
    await entriesRepo.softDelete(c.id, { deletedAt: new Date(), updatedBy: adminId });

    expect(await mediaRepo.countRichTextReferences(MEDIA_COUNT)).toBe(3); // a, b (snapshot), c
    expect(await mediaRepo.countRichTextReferences(MEDIA_COUNT_NESTED)).toBe(1); // a (citation)
    expect(await mediaRepo.countRichTextReferences(crypto.randomUUID())).toBe(0);

    // Un contenu au format pré-slice 6 (chaîne) ne fait ni erreur ni référence.
    await entriesRepo.create({
      contentType: RUN_TYPE,
      routeNamespace: 'articles',
      title: `Refs legacy ${runId}`,
      slug: `rt-legacy-count-${runId}`,
      status: 'draft',
      data: { excerpt: 'L', body: 'Texte simple sans référence' },
      createdBy: adminId,
      updatedBy: adminId,
    });
    expect(await mediaRepo.countRichTextReferences(MEDIA_COUNT)).toBe(3);

    // Usage combiné : couverture ET corps dans le même contenu = 1 ligne,
    // deux entrées distinctes = comptage par référence, la garde refuse dès > 0.
    await entriesRepo.create({
      contentType: RUN_TYPE,
      routeNamespace: 'articles',
      title: `Refs D ${runId}`,
      slug: `rt-d-${runId}`,
      status: 'draft',
      coverMediaId: MEDIA_COUNT_NESTED,
      data: { excerpt: 'D', body: doc(MEDIA_COUNT_NESTED) },
      createdBy: adminId,
      updatedBy: adminId,
    });
    expect(await mediaRepo.countRichTextReferences(MEDIA_COUNT_NESTED)).toBe(2); // citation (a) + corps (d)
    expect(await mediaRepo.countCoverReferences(MEDIA_COUNT_NESTED)).toBe(1);
    expect(await mediaRepo.countContentReferences(MEDIA_COUNT_NESTED)).toBe(3);
    void a;
    void b;
    void c;
  });

  it('Save ≠ Publish sur le corps : snapshot figé à A, Save B sans effet public, Publish → B', async () => {
    const created = await content.createDraft({
      contentTypeKey: RUN_TYPE,
      title: `Save vs Publish ${runId}`,
      data: { excerpt: 'Accroche', body: doc(MEDIA_READY) },
      actorAdminId: adminId,
    });
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;
    const entryId = created.entry.id;

    const published = await publication.publishContent({ entryId, actorAdminId: adminId });
    expect(published.kind).toBe('published');
    if (published.kind !== 'published') return;
    expect((published.entry.publishedData as { body: unknown }).body).toEqual(doc(MEDIA_READY));

    // Save B (document différent) — le snapshot reste A.
    const documentB = plainDoc(`Version B ${runId}`);
    const updated = await content.updateDraft({
      entryId,
      title: `Save vs Publish ${runId}`,
      data: { excerpt: 'Accroche', body: documentB },
      actorAdminId: adminId,
    });
    expect(updated.kind).toBe('updated');
    const afterSave = await entriesRepo.findById(entryId);
    expect((afterSave?.publishedData as { body: unknown }).body).toEqual(doc(MEDIA_READY));
    expect((afterSave?.data as { body: unknown }).body).toEqual(documentB);
    expect(hasUnpublishedChanges(afterSave!)).toBe(true);

    // Publish → le snapshot bascule vers B.
    const republished = await publication.publishContent({ entryId, actorAdminId: adminId });
    expect(republished.kind).toBe('published');
    if (republished.kind !== 'published') return;
    expect((republished.entry.publishedData as { body: unknown }).body).toEqual(documentB);
    const final = await entriesRepo.findById(entryId);
    expect(hasUnpublishedChanges(final!)).toBe(false);
  });

  it('publication refusée pour média non ready / inexistant / sans alt — aucune écriture, aucune audit', async () => {
    for (const [mediaId, expected] of [
      [MEDIA_FAILED, /non prêt/],
      [crypto.randomUUID(), /n’existe plus/],
      [MEDIA_NO_ALT, /texte alternatif/],
    ] as Array<[string, RegExp]>) {
      const created = await content.createDraft({
        contentTypeKey: RUN_TYPE,
        title: `Refus ${runId} ${mediaId.slice(0, 6)}`,
        data: { excerpt: 'Accroche', body: doc(mediaId) },
        actorAdminId: adminId,
      });
      expect(created.kind).toBe('created');
      if (created.kind !== 'created') return;
      const outcome = await publication.publishContent({ entryId: created.entry.id, actorAdminId: adminId });
      expect(outcome.kind, `refus attendu pour ${mediaId}`).toBe('invalid');
      if (outcome.kind !== 'invalid') return;
      expect(outcome.errors['body'], `message pour ${mediaId}`).toMatch(expected);
      const row = await entriesRepo.findById(created.entry.id);
      expect(row?.status).toBe('draft');
      expect(row?.publishedData).toBeNull();
      const audits = await harness.raw(
        sql`select 1 from kreiz_admin_audit_log where entity_id = ${created.entry.id} and action = 'content.published'`,
      );
      expect(audits).toHaveLength(0);
    }
  });

  it('suppression : média référencé en rich text refusé, puis autorisé après retrait des références', async () => {
    const created = await content.createDraft({
      contentTypeKey: RUN_TYPE,
      title: `Suppression ${runId}`,
      data: { excerpt: 'Accroche', body: doc(MEDIA_UNREFERENCED) },
      actorAdminId: adminId,
    });
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;

    await expect(mediaAdmin.deleteMedia({ mediaId: MEDIA_UNREFERENCED, actorAdminId: adminId })).rejects.toMatchObject({
      name: 'MediaInUseError',
    });
    expect(await mediaRepo.findById(MEDIA_UNREFERENCED)).not.toBeNull();

    // Retrait de la référence → la suppression passe (ligne + objets storage).
    await content.updateDraft({
      entryId: created.entry.id,
      title: `Suppression ${runId}`,
      data: { excerpt: 'Accroche', body: plainDoc('Sans image désormais') },
      actorAdminId: adminId,
    });
    await expect(mediaAdmin.deleteMedia({ mediaId: MEDIA_UNREFERENCED, actorAdminId: adminId })).resolves.toMatchObject({
      deleted: true,
    });
    expect(await mediaRepo.findById(MEDIA_UNREFERENCED)).toBeNull();
  });

  it('contenu pré-slice 6 (type démo, corps texte simple) : lisible, modifiable, publiable', async () => {
    // État exact d'une ligne écrite avant le slice 6 : data.body = string.
    // Le type est celui du démo (`article`) : le build démo parallèle doit
    // savoir rendre cette ligne (author présent, corps converti à la volée).
    const inserted = await withTransientNetworkRetry(() =>
      harness.raw(sql`
        insert into kreiz_content_entries
          (content_type, route_namespace, title, slug, status, data, created_by, updated_by)
        values ('article', 'articles', ${`Legacy ${runId}`}, ${`rt-legacy-body-${runId}`}, 'draft',
                ${JSON.stringify({ excerpt: 'Accroche', body: 'Premier paragraphe.\n\nDeuxième.', author: 'Auteure IT' })}::jsonb,
                ${adminId}, ${adminId})
        returning id
      `),
    );
    const entryId = String(inserted[0]!.id);

    // Lisible : la vue porte le document converti et son HTML.
    const legacyContent = createContentService({
      entries: entriesRepo,
      media: mediaRepo,
      audit: createAdminAuditLogRepository(harness.db),
      registry: demoLikeRegistry,
      rebuild: rebuildStub,
      mediaPublicBaseUrl: MEDIA_PUBLIC_BASE_URL,
    });
    const loaded = await legacyContent.getContentForEdit(entryId);
    const html = loaded.view.richText['body']?.html ?? '';
    expect(html).toContain('<p>Premier paragraphe.</p>');
    expect(html).toContain('<p>Deuxième.</p>');

    // Modifiable : le premier Save stocke le document canonique.
    const updated = await legacyContent.updateDraft({
      entryId,
      title: `Legacy ${runId}`,
      data: { excerpt: 'Accroche', body: plainDoc('Converti au slice 6'), author: 'Auteure IT' },
      actorAdminId: adminId,
    });
    expect(updated.kind).toBe('updated');
    const row = await entriesRepo.findById(entryId);
    expect(row?.data).toEqual({
      excerpt: 'Accroche',
      body: plainDoc('Converti au slice 6'),
      author: 'Auteure IT',
    });

    // Publiable : le snapshot fige le document.
    const legacyPublication = createPublicationService({
      entries: entriesRepo,
      media: mediaRepo,
      audit: createAdminAuditLogRepository(harness.db),
      registry: demoLikeRegistry,
      redirects: createRedirectsRepository(harness.db),
      rebuild: rebuildStub,
      mediaPublicBaseUrl: MEDIA_PUBLIC_BASE_URL,
    });
    const outcome = await legacyPublication.publishContent({ entryId, actorAdminId: adminId });
    expect(outcome.kind).toBe('published');
  });

  it('lecteur de build : HTML riche rendu depuis le snapshot ; référence corrompue = échec explicite', async () => {
    const { createContentReader } = await import('../../src/content/reader');
    const reader = createContentReader({
      databaseUrl: process.env.KREIZ_DATABASE_URL ?? process.env.KREIZ_TEST_DATABASE_URL ?? '',
      mediaPublicBaseUrl: MEDIA_PUBLIC_BASE_URL,
    });
    // Le lecteur de build consomme une **définition** (comme les pages du
    // Project via defineContentType), pas la déclaration résolue du registre.
    const definition = defineContentType({
      key: RUN_TYPE,
      label: 'Article',
      routeNamespace: 'articles',
      fields: {
        excerpt: fields.text({ label: 'Accroche', required: true, maxLength: 300 }),
        body: fields.richText({ label: 'Corps', required: true }),
      },
      template: 'src/templates/ArticleContent.astro',
    });

    // Snapshot publié avec document riche (titre, citation, lien, média).
    const richSnapshot = {
      version: 1,
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Titre riche' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Avant' }] },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Citation' }] }] },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'lien', marks: [{ type: 'link', attrs: { href: 'https://exemple.fr' } }] }],
        },
        { type: 'media', attrs: { mediaId: MEDIA_READY, caption: 'La légende publique' } },
      ],
    };
    const slug = `rt-build-${runId}`;
    await entriesRepo.create({
      contentType: RUN_TYPE,
      routeNamespace: 'articles',
      title: `Build ${runId}`,
      slug,
      status: 'published',
      publishedAt: new Date(),
      publishedSlug: slug,
      publishedTitle: `Build ${runId}`,
      publishedData: { excerpt: 'Accroche', body: richSnapshot },
      publishedSeo: {},
      data: { excerpt: 'Accroche', body: richSnapshot },
      createdBy: adminId,
      updatedBy: adminId,
    });

    const view = await reader.getPublishedViewBySlug({ declaration: definition, slug });
    expect(view).not.toBeNull();
    const html = view!.richText['body']?.html ?? '';
    expect(html).toContain('<h2>Titre riche</h2>');
    expect(html).toContain('<blockquote><p>Citation</p></blockquote>');
    expect(html).toContain('<a href="https://exemple.fr" target="_blank" rel="noopener noreferrer">lien</a>');
    expect(html).toContain('<figure class="kz-richtext-figure"');
    expect(html).toContain('srcset=');
    expect(html).toContain('<figcaption>La légende publique</figcaption>');
    expect(html).toContain(`alt="Image prête ${runId}"`);
    // Le fallback est la plus grande WebP — jamais l'original.
    expect(html).toContain(`media/${MEDIA_READY}/800.webp`);
    expect(html).not.toContain('original');

    // Divergence snapshot ⇄ médiathèque : le média publié est détruit hors
    // service (simulation d'une suppression physique directe) → le build
    // échoue explicitement, jamais un rendu silencieux.
    await withTransientNetworkRetry(() =>
      harness.raw(sql`delete from kreiz_media where id = ${MEDIA_READY}`),
    );
    await expect(reader.getPublishedViewBySlug({ declaration: definition, slug })).rejects.toBeInstanceOf(ContentDataCorruptedError);
    await expect(reader.listPublishedViews({ declaration: definition })).rejects.toBeInstanceOf(ContentDataCorruptedError);
  });
});
