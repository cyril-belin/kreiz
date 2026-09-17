import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createAdminUsersRepository, type KreizAdminUser } from '../../src/data';
import { createContentTypeRegistry } from '../../src/domain/content/registry';
import { fields } from '../../src/domain/content/fields';
import { MediaInUseError } from '../../src/domain/media/errors';
import type { SeoSiteConfig } from '../../src/domain/seo/site-config';
import { createContentService } from '../../src/services/content';
import { createPublicationService } from '../../src/services/publication';
import { createMediaAdminService } from '../../src/services/media-admin';
import { createContentEntriesRepository } from '../../src/data/repositories/content-entries';
import { createMediaRepository } from '../../src/data/repositories/media';
import { createRedirectsRepository } from '../../src/data/repositories/redirects';
import { createAdminAuditLogRepository } from '../../src/data/repositories/admin-audit-log';
import { createInMemoryStorage } from '../helpers/in-memory-media';
import { describeIntegration, setupIntegration, withTransientNetworkRetry, type IntegrationHarness } from './helpers';
import { createRebuildTriggerStub, type RebuildTriggerStub } from '../helpers/stub-rebuild-trigger';

/**
 * SEO contre PostgreSQL réel (mission slice 9 §39) — Save ≠ Publish du SEO,
 * image OG `ready` exigée au Publish, **références OG comptées** (finding
 * historique `seo.og_image_media_id` corrigé : suppression refusée tant que
 * référencée, autorisée après retrait), sitemap à partir des snapshots
 * publics (drafts/deleted/noindex exclus), drift de slug. 0 donnée résiduelle.
 */
const runId = crypto.randomUUID().slice(0, 8);
const namespace = `seo-${runId}`;
const emailPattern = `it-${runId}%@example.test`;

let harness: IntegrationHarness;
let entriesRepo: ReturnType<typeof createContentEntriesRepository>;
let mediaRepo: ReturnType<typeof createMediaRepository>;
let content: ReturnType<typeof createContentService>;
let publication: ReturnType<typeof createPublicationService>;
let mediaAdmin: ReturnType<typeof createMediaAdminService>;
let rebuild: RebuildTriggerStub;
let admin: KreizAdminUser;

const seoSite: SeoSiteConfig = {
  siteName: 'Kreiz IT',
  siteUrl: 'https://it.example',
  titleTemplate: '%s | Kreiz IT',
  defaultDescription: null,
  defaultOgImageUrl: null,
  twitterSite: null,
  locale: null,
  organization: null,
  sitemap: { extraPaths: [] },
};

const registry = createContentTypeRegistry({
  declarations: [
    {
      key: `seo_${runId}`,
      label: 'Article',
      routeNamespace: namespace,
      fields: {
        excerpt: fields.text({ label: 'Accroche', required: true }),
        body: fields.richText({ label: 'Corps', required: true }),
      },
      template: 'src/templates/ArticleContent.astro',
    },
  ],
  templates: { [`seo_${runId}`]: function KreizFakeTemplate() {} },
});

const validData = { excerpt: `Accroche ${runId}`, body: { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Corps.' }] }] } };

async function createReadyMedia(): Promise<string> {
  const id = crypto.randomUUID();
  await withTransientNetworkRetry(() =>
    mediaRepo.createUploading({
      id,
      storageKey: `media/${id}/original`,
      mime: 'image/png',
      sizeBytes: 100,
      variants: [],
      uploadedBy: admin.id,
    }),
  );
  await mediaRepo.markProcessing(id, { updatedAt: new Date() });
  const ready = await mediaRepo.markReady(id, {
    width: 1200,
    height: 630,
    variants: [
      { key: `media/${id}/800.webp`, width: 800, format: 'webp', sizeBytes: 40_000 },
      { key: `media/${id}/1200.webp`, width: 1200, format: 'webp', sizeBytes: 80_000 },
    ],
    updatedAt: new Date(),
  });
  if (!ready) throw new Error('média de fixture non prêt');
  return id;
}

async function createDraft(title: string): Promise<string> {
  const outcome = await content.createDraft({
    contentTypeKey: `seo_${runId}`,
    title,
    data: validData,
    actorAdminId: admin.id,
  });
  if (outcome.kind !== 'created') throw new Error('fixture non créée');
  return outcome.entry.id;
}

describeIntegration('SEO — service + PostgreSQL réel (slice 9)', () => {
  beforeAll(async () => {
    harness = await setupIntegration();
    entriesRepo = createContentEntriesRepository(harness.db);
    mediaRepo = createMediaRepository(harness.db);
    rebuild = createRebuildTriggerStub();
    const audit = createAdminAuditLogRepository(harness.db);
    content = createContentService({
      entries: entriesRepo,
      media: mediaRepo,
      audit,
      registry,
      rebuild,
      mediaPublicBaseUrl: 'https://media.example.test/cdn',
      seoSite,
    });
    publication = createPublicationService({
      entries: entriesRepo,
      media: mediaRepo,
      redirects: createRedirectsRepository(harness.db),
      audit,
      registry,
      rebuild,
      mediaPublicBaseUrl: 'https://media.example.test/cdn',
      seoSite,
    });
    mediaAdmin = createMediaAdminService({ media: mediaRepo, audit, storage: createInMemoryStorage() });
    const users = createAdminUsersRepository(harness.db);
    admin = await withTransientNetworkRetry(() =>
      users.create({
        email: `it-${runId}-admin@example.test`,
        passwordHash: 'hash-test-argon2id',
        name: 'Admin SEO',
      }),
    );
  }, 60_000);

  afterAll(async () => {
    if (!harness) return;
    await withTransientNetworkRetry(() =>
      harness.raw(sql`delete from kreiz_redirects where from_path like ${`/${namespace}/%`}`),
    );
    await withTransientNetworkRetry(() =>
      harness.raw(
        sql`delete from kreiz_admin_audit_log where entity_id in (select id::text from kreiz_content_entries where route_namespace = ${namespace}) or (entity_type = 'media' and actor_admin_id = ${admin.id})`,
      ),
    );
    await withTransientNetworkRetry(() =>
      harness.raw(sql`delete from kreiz_content_entries where route_namespace = ${namespace}`),
    );
    await withTransientNetworkRetry(() =>
      harness.raw(sql`delete from kreiz_media where uploaded_by = ${admin.id}`),
    );
    await harness.raw(sql`delete from kreiz_admin_users where email like ${emailPattern}`);
    await harness.close();
  }, 60_000);

  it('Save ≠ Publish : le SEO éditorial ne bascule le public qu’au Publish', async () => {
    const id = await createDraft(`Article SEO A ${runId}`);
    await content.updateDraft({
      entryId: id,
      title: `Article SEO A ${runId}`,
      data: validData,
      seo: { title: 'SEO A', description: 'Description A' },
      actorAdminId: admin.id,
    });
    await publication.publishContent({ entryId: id, actorAdminId: admin.id });

    // Save B : le snapshot public reste A.
    await content.updateDraft({
      entryId: id,
      title: `Article SEO A ${runId}`,
      data: validData,
      seo: { title: 'SEO B', description: 'Description B' },
      actorAdminId: admin.id,
    });
    let row = (await entriesRepo.findById(id))!;
    expect(row.seo).toEqual({ title: 'SEO B', description: 'Description B' });
    expect(row.publishedSeo).toEqual({ title: 'SEO A', description: 'Description A' });

    // Publish : le public bascule en B.
    await publication.publishContent({ entryId: id, actorAdminId: admin.id });
    row = (await entriesRepo.findById(id))!;
    expect(row.publishedSeo).toEqual({ title: 'SEO B', description: 'Description B' });
  });

  it('image OG : ready acceptée au Publish, non prête refusée avant toute écriture', async () => {
    const readyId = await createReadyMedia();
    const readyEntry = await createDraft(`Article OG ready ${runId}`);
    await content.updateDraft({
      entryId: readyEntry,
      title: `Article OG ready ${runId}`,
      data: validData,
      seo: { ogImageMediaId: readyId },
      actorAdminId: admin.id,
    });
    const accepted = await publication.publishContent({ entryId: readyEntry, actorAdminId: admin.id });
    expect(accepted.kind).toBe('published');
    expect((await entriesRepo.findById(readyEntry))!.publishedSeo).toEqual({ ogImageMediaId: readyId });

    // Média `processing` : le Save du brouillon passe, le Publish refuse.
    const processingId = crypto.randomUUID();
    await withTransientNetworkRetry(() =>
      mediaRepo.createUploading({
        id: processingId,
        storageKey: `media/${processingId}/original`,
        mime: 'image/png',
        sizeBytes: 100,
        variants: [],
        uploadedBy: admin.id,
      }),
    );
    await mediaRepo.markProcessing(processingId, { updatedAt: new Date() });
    const processingEntry = await createDraft(`Article OG processing ${runId}`);
    await content.updateDraft({
      entryId: processingEntry,
      title: `Article OG processing ${runId}`,
      data: validData,
      seo: { ogImageMediaId: processingId },
      actorAdminId: admin.id,
    });
    const refused = await publication.publishContent({ entryId: processingEntry, actorAdminId: admin.id });
    expect(refused.kind).toBe('invalid');
    if (refused.kind !== 'invalid') return;
    expect(refused.errors.seo_og_image).toBeTruthy();
    const after = await entriesRepo.findById(processingEntry);
    expect(after!.status).toBe('draft');
    expect(after!.publishedSeo).toBeNull();
  });

  it('références OG comptées : suppression média refusée tant que référencée (courant ou snapshot)', async () => {
    const ogId = await createReadyMedia();
    const entryId = await createDraft(`Article OG delete ${runId}`);
    await content.updateDraft({
      entryId,
      title: `Article OG delete ${runId}`,
      data: validData,
      seo: { ogImageMediaId: ogId },
      actorAdminId: admin.id,
    });

    // Référence courante seule : refus.
    await expect(mediaAdmin.deleteMedia({ mediaId: ogId, actorAdminId: admin.id })).rejects.toThrow(MediaInUseError);
    await expect(mediaRepo.countSeoOgImageReferences(ogId)).resolves.toBe(1);

    // Snapshot publié : la référence éditoriale retirée, le snapshot compte encore → refus.
    await publication.publishContent({ entryId, actorAdminId: admin.id });
    await content.updateDraft({
      entryId,
      title: `Article OG delete ${runId}`,
      data: validData,
      seo: {},
      actorAdminId: admin.id,
    });
    await expect(mediaRepo.countSeoOgImageReferences(ogId)).resolves.toBe(1);
    await expect(mediaAdmin.deleteMedia({ mediaId: ogId, actorAdminId: admin.id })).rejects.toThrow(MediaInUseError);

    // Republication sans OG : plus aucune référence → suppression autorisée.
    await publication.publishContent({ entryId, actorAdminId: admin.id });
    await expect(mediaRepo.countSeoOgImageReferences(ogId)).resolves.toBe(0);
    await expect(mediaRepo.countContentReferences(ogId)).resolves.toBe(0);
    await expect(mediaAdmin.deleteMedia({ mediaId: ogId, actorAdminId: admin.id })).resolves.toEqual({
      deleted: true,
      mediaId: ogId,
    });
  });

  it('sitemap : publiés indexables seuls (draft, soft-deleted et noindex exclus), lastmod fiable', async () => {
    const publishedId = await createDraft(`Article sitemap ${runId}`);
    await publication.publishContent({ entryId: publishedId, actorAdminId: admin.id });

    const noindexId = await createDraft(`Article noindex ${runId}`);
    await content.updateDraft({
      entryId: noindexId,
      title: `Article noindex ${runId}`,
      data: validData,
      seo: { noindex: true },
      actorAdminId: admin.id,
    });
    await publication.publishContent({ entryId: noindexId, actorAdminId: admin.id });

    const _draftId = await createDraft(`Article draft ${runId}`);

    const deletedId = await createDraft(`Article deleted ${runId}`);
    await publication.publishContent({ entryId: deletedId, actorAdminId: admin.id });
    await content.deleteDraft({ entryId: deletedId, actorAdminId: admin.id });

    const rows = await entriesRepo.listPublishedForSitemap();
    const slugs = rows.map((row) => row.publishedSlug);
    expect(slugs).toContain(`article-sitemap-${runId}`);
    expect(slugs).not.toContain(`article-noindex-${runId}`);
    expect(slugs).not.toContain(`article-draft-${runId}`);
    expect(slugs).not.toContain(`article-deleted-${runId}`);
    const published = rows.find((row) => row.publishedSlug === `article-sitemap-${runId}`)!;
    expect(published.routeNamespace).toBe(namespace);
    expect(published.publishedAt).not.toBeNull();
  });

  it('drift de slug : canonical dérivée du slug publié, sitemap ne liste que la nouvelle URL', async () => {
    const id = await createDraft(`Article drift ${runId}`);
    await publication.publishContent({ entryId: id, actorAdminId: admin.id });

    await content.updateDraft({
      entryId: id,
      title: `Article drift ${runId}`,
      slug: `article-drift-${runId}-b`,
      data: validData,
      actorAdminId: admin.id,
    });
    const outcome = await publication.publishContent({ entryId: id, actorAdminId: admin.id });
    expect(outcome.kind).toBe('published');

    // Le lecteur public résout par slug publié : l'ancienne URL ne renvoie rien.
    await expect(
      entriesRepo.findPublishedByNamespaceAndPublishedSlug(namespace, `article-drift-${runId}`),
    ).resolves.toBeNull();
    const current = await entriesRepo.findPublishedByNamespaceAndPublishedSlug(
      namespace,
      `article-drift-${runId}-b`,
    );
    expect(current).not.toBeNull();

    const rows = await entriesRepo.listPublishedForSitemap();
    const driftRows = rows.filter(
      (row) => row.publishedSlug === `article-drift-${runId}` || row.publishedSlug === `article-drift-${runId}-b`,
    );
    expect(driftRows).toHaveLength(1);
    expect(driftRows[0]!.publishedSlug).toBe(`article-drift-${runId}-b`);
  });
});
