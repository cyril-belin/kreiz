import { describe, expect, it } from 'vitest';
import { fields, type ContentTypeDeclaration } from '../src/domain/content/declaration';
import { createContentTypeRegistry, type ContentTypeRegistryInput } from '../src/domain/content/registry';
import { parseContentForm } from '../src/http/content-form';
import { createContentService } from '../src/services/content';
import { createPublicationService } from '../src/services/publication';
import {
  createInMemoryAuditRepository,
  createInMemoryContentRepository,
  createInMemoryRedirectsRepository,
  type InMemoryContentState,
} from './helpers/in-memory-content';
import {
  createInMemoryMediaRepository,
  stubMediaRow,
  type InMemoryMediaState,
} from './helpers/in-memory-media';
import { createRebuildTriggerStub } from './helpers/stub-rebuild-trigger';
import type { SeoSiteConfig } from '../src/domain/seo/site-config';

/**
 * SEO côté services (slice 9) — validation au **Save** (schéma strict,
 * média OG existant, canonical même origine), parseur de formulaire
 * (`seo_*` whitelisté), et le comptage d'usage média étendu à l'image OG
 * (suppression refusée tant que référencée). PostgreSQL réel : intégration.
 */

const actorId = crypto.randomUUID();
const seoSite: SeoSiteConfig = {
  siteName: 'Kreiz demo',
  siteUrl: 'https://demo.example',
  titleTemplate: '%s | Kreiz demo',
  defaultDescription: null,
  defaultOgImageUrl: null,
  twitterSite: null,
  locale: null,
  organization: null,
  sitemap: { extraPaths: [] },
};

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
    templates: Object.fromEntries(declarations.map((d) => [d.key, function KreizFakeTemplate() {}])),
  };
}

function setup() {
  const contentState: InMemoryContentState = { entries: new Map(), redirects: new Map(), auditRows: [] };
  const mediaState: InMemoryMediaState = { media: new Map(), auditRows: [], entries: contentState.entries };
  const deps = {
    entries: createInMemoryContentRepository(contentState),
    media: createInMemoryMediaRepository(mediaState),
    audit: createInMemoryAuditRepository(contentState),
    registry: createContentTypeRegistry(registryInput()),
    rebuild: createRebuildTriggerStub(),
    mediaPublicBaseUrl: 'https://media.example.test/cdn' as string | null,
    seoSite: seoSite as SeoSiteConfig | null,
  };
  const content = createContentService(deps);
  const publication = createPublicationService({
    ...deps,
    redirects: createInMemoryRedirectsRepository(contentState),
  });
  return { content, publication, media: deps.media, mediaState, contentState };
}

const bodyDocument = {
  version: 1,
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Corps.' }] }],
};
const validData = { excerpt: 'Accroche.', body: bodyDocument };

async function createDraft(service: ReturnType<typeof createContentService>) {
  const outcome = await service.createDraft({
    contentTypeKey: 'article',
    title: 'Article SEO',
    data: validData,
    actorAdminId: actorId,
  });
  if (outcome.kind !== 'created') throw new Error('draft attendu');
  return outcome.entry;
}

describe('parseContentForm — champs seo_* whitelistés', () => {
  const declaration = { fields: registryInput().declarations[0]!.fields };

  it('extrait les champs système SEO hors data', () => {
    const formData = new FormData();
    formData.set('title', 'T');
    formData.set('excerpt', 'Accroche.');
    formData.set('body', JSON.stringify(bodyDocument));
    formData.set('seo_title', 'Titre SEO');
    formData.set('seo_description', 'Description SEO');
    formData.set('seo_canonical', '/editions/speciale');
    formData.set('seo_og_title', 'Titre OG');
    formData.set('seo_og_description', 'Description OG');
    formData.set('seo_og_image_media_id', crypto.randomUUID());
    formData.set('seo_noindex', 'on');

    const parsed = parseContentForm(declaration, formData);
    expect(parsed.data).not.toHaveProperty('seo_title');
    expect(parsed.seo).toEqual({
      title: 'Titre SEO',
      description: 'Description SEO',
      canonicalOverride: '/editions/speciale',
      ogTitle: 'Titre OG',
      ogDescription: 'Description OG',
      ogImageMediaId: parsed.seo.ogImageMediaId,
      noindex: true,
      nofollow: false,
    });
  });

  it('formulaire sans champs SEO : seo réduit aux booléens cochés', () => {
    const formData = new FormData();
    formData.set('title', 'T');
    formData.set('excerpt', 'A');
    formData.set('body', JSON.stringify(bodyDocument));
    const parsed = parseContentForm(declaration, formData);
    expect(parsed.seo).toEqual({ noindex: false, nofollow: false });
  });
});

describe('updateDraft — validation SEO au Save', () => {
  it('sauvegarde un SEO valide et normalisé (snapshot intacts)', async () => {
    const { content } = setup();
    const entry = await createDraft(content);
    const outcome = await content.updateDraft({
      entryId: entry.id,
      title: entry.title,
      data: validData,
      seo: { title: '  Titre SEO  ', description: 'Desc.', noindex: true },
      actorAdminId: actorId,
    });
    expect(outcome.kind).toBe('updated');
    if (outcome.kind !== 'updated') return;
    expect(outcome.entry.seo).toEqual({ title: 'Titre SEO', description: 'Desc.', noindex: true });
    expect(outcome.entry.publishedSeo).toBeNull();
  });

  it('refuse un titre SEO hors bornes et une clé inconnue (erreurs par champ)', async () => {
    const { content } = setup();
    const entry = await createDraft(content);
    const outcome = await content.updateDraft({
      entryId: entry.id,
      title: entry.title,
      data: validData,
      seo: { title: 'x'.repeat(121) },
      actorAdminId: actorId,
    });
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind !== 'invalid') return;
    expect(outcome.errors.seo_title).toBeTruthy();

    const hostile = await content.updateDraft({
      entryId: entry.id,
      title: entry.title,
      data: validData,
      seo: { title: 'ok', injected: '<script>' },
      actorAdminId: actorId,
    });
    expect(hostile.kind).toBe('invalid');
  });

  it('refuse une image OG inexistante ou supprimée', async () => {
    const { content } = setup();
    const entry = await createDraft(content);
    const outcome = await content.updateDraft({
      entryId: entry.id,
      title: entry.title,
      data: validData,
      seo: { ogImageMediaId: crypto.randomUUID() },
      actorAdminId: actorId,
    });
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind !== 'invalid') return;
    expect(outcome.errors.seo_og_image).toBeTruthy();
  });

  it('accepte un média OG en traitement au Save (la publication exigera ready)', async () => {
    const { content, mediaState } = setup();
    const processing = stubMediaRow({ status: 'processing' });
    mediaState.media.set(processing.id, processing);
    const entry = await createDraft(content);
    const outcome = await content.updateDraft({
      entryId: entry.id,
      title: entry.title,
      data: validData,
      seo: { ogImageMediaId: processing.id },
      actorAdminId: actorId,
    });
    expect(outcome.kind).toBe('updated');
  });

  it('refuse un canonical absolu hors origine ; accepte chemin interne et même origine', async () => {
    const { content } = setup();
    const entry = await createDraft(content);

    const hostile = await content.updateDraft({
      entryId: entry.id,
      title: entry.title,
      data: validData,
      seo: { canonicalOverride: 'https://autre.example/page' },
      actorAdminId: actorId,
    });
    expect(hostile.kind).toBe('invalid');
    if (hostile.kind !== 'invalid') return;
    expect(hostile.errors.seo_canonical).toBeTruthy();

    const javascript = await content.updateDraft({
      entryId: entry.id,
      title: entry.title,
      data: validData,
      seo: { canonicalOverride: 'javascript:alert(1)' },
      actorAdminId: actorId,
    });
    expect(javascript.kind).toBe('invalid');

    const pathOverride = await content.updateDraft({
      entryId: entry.id,
      title: entry.title,
      data: validData,
      seo: { canonicalOverride: '/editions/speciale' },
      actorAdminId: actorId,
    });
    expect(pathOverride.kind).toBe('updated');

    const sameOrigin = await content.updateDraft({
      entryId: entry.id,
      title: entry.title,
      data: validData,
      seo: { canonicalOverride: 'https://demo.example/autrement' },
      actorAdminId: actorId,
    });
    expect(sameOrigin.kind).toBe('updated');
  });

  it('sans configuration SEO du site : canonical absolu refusé, chemin interne accepté', async () => {
    const contentState: InMemoryContentState = { entries: new Map(), redirects: new Map(), auditRows: [] };
    const mediaState: InMemoryMediaState = { media: new Map(), auditRows: [], entries: contentState.entries };
    const noSite = createContentService({
      entries: createInMemoryContentRepository(contentState),
      media: createInMemoryMediaRepository(mediaState),
      audit: createInMemoryAuditRepository(contentState),
      registry: createContentTypeRegistry(registryInput()),
      rebuild: createRebuildTriggerStub(),
      mediaPublicBaseUrl: 'https://media.example.test/cdn',
      seoSite: null,
    });
    const outcome0 = await noSite.createDraft({
      contentTypeKey: 'article',
      title: 'Article SEO',
      data: validData,
      actorAdminId: actorId,
    });
    if (outcome0.kind !== 'created') throw new Error('draft attendu');
    const absolute = await noSite.updateDraft({
      entryId: outcome0.entry.id,
      title: outcome0.entry.title,
      data: validData,
      seo: { canonicalOverride: 'https://demo.example/x' },
      actorAdminId: actorId,
    });
    expect(absolute.kind).toBe('invalid');
    const relative = await noSite.updateDraft({
      entryId: outcome0.entry.id,
      title: outcome0.entry.title,
      data: validData,
      seo: { canonicalOverride: '/x' },
      actorAdminId: actorId,
    });
    expect(relative.kind).toBe('updated');
  });

  it('seo undefined = inchangé ; seo {} = effacé', async () => {
    const { content } = setup();
    const entry = await createDraft(content);
    await content.updateDraft({
      entryId: entry.id,
      title: entry.title,
      data: validData,
      seo: { title: 'Titre SEO' },
      actorAdminId: actorId,
    });
    const unchanged = await content.updateDraft({
      entryId: entry.id,
      title: entry.title,
      data: validData,
      actorAdminId: actorId,
    });
    expect(unchanged.kind === 'updated' && unchanged.entry.seo).toEqual({ title: 'Titre SEO' });
    const cleared = await content.updateDraft({
      entryId: entry.id,
      title: entry.title,
      data: validData,
      seo: {},
      actorAdminId: actorId,
    });
    expect(cleared.kind === 'updated' && cleared.entry.seo).toEqual({});
  });
});

describe('publishContent — validation SEO à la publication', () => {
  it('publie avec le SEO courant figé dans published_seo (Save ≠ Publish)', async () => {
    const { content, publication } = setup();
    const entry = await createDraft(content);
    await content.updateDraft({
      entryId: entry.id,
      title: entry.title,
      data: validData,
      seo: { title: 'SEO A', description: 'Desc A' },
      actorAdminId: actorId,
    });
    const published = await publication.publishContent({ entryId: entry.id, actorAdminId: actorId });
    expect(published.kind).toBe('published');
    if (published.kind !== 'published') return;
    expect(published.entry.publishedSeo).toEqual({ title: 'SEO A', description: 'Desc A' });

    // Save B : public reste A.
    await content.updateDraft({
      entryId: entry.id,
      title: entry.title,
      data: validData,
      seo: { title: 'SEO B', description: 'Desc B' },
      actorAdminId: actorId,
    });
    expect(published.entry.publishedSeo).toEqual({ title: 'SEO A', description: 'Desc A' });

    const republished = await publication.publishContent({ entryId: entry.id, actorAdminId: actorId });
    expect(republished.kind === 'published' && republished.entry.publishedSeo).toEqual({
      title: 'SEO B',
      description: 'Desc B',
    });
  });

  it('refuse la publication avec une image OG non prête', async () => {
    const { content, publication, mediaState } = setup();
    const processing = stubMediaRow({ status: 'processing' });
    mediaState.media.set(processing.id, processing);
    const entry = await createDraft(content);
    await content.updateDraft({
      entryId: entry.id,
      title: entry.title,
      data: validData,
      seo: { ogImageMediaId: processing.id },
      actorAdminId: actorId,
    });
    const outcome = await publication.publishContent({ entryId: entry.id, actorAdminId: actorId });
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind !== 'invalid') return;
    expect(outcome.errors.seo_og_image).toBeTruthy();
    // La base reste en draft : aucun snapshot figé.
    const after = await content.getContentForEdit(entry.id);
    expect(after.entry.status).toBe('draft');
    expect(after.entry.publishedSeo).toBeNull();
  });

  it('accepte la publication quand l’image OG est prête', async () => {
    const { content, publication, mediaState } = setup();
    const ready = stubMediaRow({ status: 'ready' });
    mediaState.media.set(ready.id, ready);
    const entry = await createDraft(content);
    await content.updateDraft({
      entryId: entry.id,
      title: entry.title,
      data: validData,
      seo: { ogImageMediaId: ready.id },
      actorAdminId: actorId,
    });
    const outcome = await publication.publishContent({ entryId: entry.id, actorAdminId: actorId });
    expect(outcome.kind).toBe('published');
  });
});

describe('comptage d’usage média — l’image OG est une référence (finding corrigé)', () => {
  it('l’OG SEO (courante ou snapshot publié) compte dans countContentReferences', async () => {
    const { content, publication, mediaState } = setup();
    const ogMedia = stubMediaRow({ status: 'ready' });
    mediaState.media.set(ogMedia.id, ogMedia);
    const entry = await createDraft(content);
    await content.updateDraft({
      entryId: entry.id,
      title: entry.title,
      data: validData,
      seo: { ogImageMediaId: ogMedia.id },
      actorAdminId: actorId,
    });

    const mediaRepo = createInMemoryMediaRepository(mediaState);
    await expect(mediaRepo.countSeoOgImageReferences(ogMedia.id)).resolves.toBe(1);
    await expect(mediaRepo.countContentReferences(ogMedia.id)).resolves.toBe(1);

    // Publication : le snapshot `published_seo` référence aussi le média —
    // toujours une seule entrée (comptage par contenu), toujours utilisé.
    await publication.publishContent({ entryId: entry.id, actorAdminId: actorId });
    await expect(mediaRepo.countContentReferences(ogMedia.id)).resolves.toBe(1);

    // Retrait de la référence éditoriale : le snapshot publié compte encore.
    await content.updateDraft({
      entryId: entry.id,
      title: entry.title,
      data: validData,
      seo: {},
      actorAdminId: actorId,
    });
    await expect(mediaRepo.countSeoOgImageReferences(ogMedia.id)).resolves.toBe(1);
    await expect(mediaRepo.countContentReferences(ogMedia.id)).resolves.toBe(1);
  });

  it('aucune référence (courante, publiée, couverture, rich text) ⇒ comptage 0', async () => {
    const { content, mediaState } = setup();
    const orphan = stubMediaRow({ status: 'ready' });
    mediaState.media.set(orphan.id, orphan);
    await createDraft(content);
    const mediaRepo = createInMemoryMediaRepository(mediaState);
    await expect(mediaRepo.countContentReferences(orphan.id)).resolves.toBe(0);
  });
});
