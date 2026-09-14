import { describe, expect, it } from 'vitest';
import { fields, type ContentTypeDeclaration } from '../src/domain/content/declaration';
import {
  createContentTypeRegistry,
  type ContentTypeRegistryInput,
} from '../src/domain/content/registry';
import {
  ContentDeletedError,
  ContentNotFoundError,
  PublishedPathOccupiedError,
} from '../src/domain/content/errors';
import { hasUnpublishedChanges } from '../src/domain/content/publication-state';
import { createPublicationService } from '../src/services/publication';
import {
  createInMemoryAuditRepository,
  createInMemoryContentRepository,
  createInMemoryRedirectsRepository,
  stubContentEntry,
  type InMemoryContentState,
} from './helpers/in-memory-content';
import { createRebuildTriggerStub } from './helpers/stub-rebuild-trigger';

/**
 * Service de publication — cycle Save → Publish → rebuild (mission §3-§17),
 * testé sans PostgreSQL. Les sémantiques PostgreSQL réelles (upsert
 * `from_path`, index unique, dates) sont en intégration Neon.
 */

const actorAdminId = crypto.randomUUID();
const otherActorId = crypto.randomUUID();

function registryInput(): ContentTypeRegistryInput {
  const declarations: ContentTypeDeclaration[] = [
    {
      key: 'article',
      label: 'Article',
      routeNamespace: 'articles',
      fields: {
        excerpt: fields.text({ label: 'Accroche', required: true }),
        body: fields.textarea({ label: 'Corps', required: true }),
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

function setup(state: InMemoryContentState = { entries: new Map(), redirects: new Map(), auditRows: [] }) {
  const rebuild = createRebuildTriggerStub();
  const service = createPublicationService({
    entries: createInMemoryContentRepository(state),
    redirects: createInMemoryRedirectsRepository(state),
    audit: createInMemoryAuditRepository(state),
    registry: createContentTypeRegistry(registryInput()),
    rebuild,
  });
  return { service, state, rebuild };
}

const validData = { excerpt: 'Accroche', body: 'Corps.' };

async function seedPublished(
  state: InMemoryContentState,
  overrides: Partial<Parameters<typeof stubContentEntry>[0]> = {},
) {
  const entry = stubContentEntry({ data: validData, ...overrides });
  state.entries.set(entry.id, entry);
  return entry;
}

describe('publishContent — première publication (mission §4)', () => {
  it('draft → published : snapshots figés, published_at posé, audit, rebuild demandé', async () => {
    const { service, state, rebuild } = setup();
    const draft = await seedPublished(state, {
      title: 'Mon article',
      slug: 'mon-article',
      status: 'draft',
    });

    const outcome = await service.publishContent({ entryId: draft.id, actorAdminId });

    expect(outcome.kind).toBe('published');
    if (outcome.kind !== 'published') return;
    expect(outcome.entry.status).toBe('published');
    expect(outcome.entry.publishedSlug).toBe('mon-article');
    expect(outcome.entry.publishedTitle).toBe('Mon article');
    expect(outcome.entry.publishedData).toEqual(validData);
    expect(outcome.entry.publishedAt).toBeInstanceOf(Date);
    expect(outcome.redirect).toBeNull();
    expect(rebuild.calls).toEqual([{ reason: 'content.published' }]);

    const audit = state.auditRows.find((row) => row.action === 'content.published');
    expect(audit).toMatchObject({
      actorAdminId,
      entityType: 'content_entry',
      entityId: draft.id,
    });
    expect(audit?.metadata).toMatchObject({ contentType: 'article', slug: 'mon-article' });
  });

  it('échoue proprement AVANT toute écriture si les données sont invalides (mission §4)', async () => {
    const { service, state, rebuild } = setup();
    const draft = await seedPublished(state, { data: { excerpt: '', body: '' }, status: 'draft' });

    const outcome = await service.publishContent({ entryId: draft.id, actorAdminId });

    expect(outcome.kind).toBe('invalid');
    if (outcome.kind !== 'invalid') return;
    expect(outcome.errors['excerpt']).toBeTruthy();
    // Aucun effet de bord : statut, snapshots, audit, rebuild.
    expect(state.entries.get(draft.id)?.status).toBe('draft');
    expect(state.entries.get(draft.id)?.publishedSlug).toBeNull();
    expect(state.auditRows).toHaveLength(0);
    expect(rebuild.calls).toHaveLength(0);
  });

  it('échoue sur un titre vide — validation identique à la sauvegarde', async () => {
    const { service, state } = setup();
    const draft = await seedPublished(state, { title: '   ', status: 'draft' });
    const outcome = await service.publishContent({ entryId: draft.id, actorAdminId });
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind !== 'invalid') return;
    expect(outcome.errors['title']).toBeTruthy();
    expect(state.auditRows).toHaveLength(0);
  });

  it('contenu introuvable ou supprimé : erreurs de domaine', async () => {
    const { service } = setup();
    await expect(service.publishContent({ entryId: crypto.randomUUID(), actorAdminId })).rejects.toThrow(
      ContentNotFoundError,
    );
  });

  it('contenu supprimé (soft) : ContentDeletedError, rien d’écrit', async () => {
    const { service, state } = setup();
    const deleted = await seedPublished(state, { deletedAt: new Date() });
    await expect(service.publishContent({ entryId: deleted.id, actorAdminId })).rejects.toThrow(
      ContentDeletedError,
    );
    expect(state.auditRows).toHaveLength(0);
  });
});

describe('Save != Publish (mission §5, §20)', () => {
  it('une édition d’un contenu publié ne touche jamais les snapshots', async () => {
    const { state, rebuild } = setup();
    const published = await seedPublished(state, {
      title: 'Version publique',
      slug: 'version-publique',
      status: 'published',
      publishedAt: new Date(),
      publishedSlug: 'version-publique',
      publishedTitle: 'Version publique',
      publishedData: validData,
      publishedSeo: {},
    });
    rebuild.calls.length = 0;

    // Save éditorial (service contenu = updateDraft côté moteur) simulé
    // directement sur l'état courant : titre, slug et données changent.
    const current = state.entries.get(published.id)!;
    state.entries.set(published.id, {
      ...current,
      title: 'Nouveau titre',
      slug: 'nouveau-titre',
      data: { excerpt: 'Nouvelle accroche', body: 'Nouveau corps.' },
    });
    expect(hasUnpublishedChanges(state.entries.get(published.id)!)).toBe(true);

    // Le build public ne voit QUE la projection publiée : l'ancienne version.
    const readerRow = state.entries.get(published.id)!;
    expect(readerRow.publishedTitle).toBe('Version publique');
    expect(readerRow.publishedSlug).toBe('version-publique');
    expect(readerRow.publishedData).toEqual(validData);

    // Un Save ne déclenche jamais de rebuild.
    expect(rebuild.calls).toHaveLength(0);
  });

  it('re-published : Publier fige les modifications et les rend publiques', async () => {
    const { service, state, rebuild } = setup();
    const published = await seedPublished(state, {
      title: 'V1',
      slug: 'article-v1',
      status: 'published',
      publishedAt: new Date('2026-01-01T10:00:00Z'),
      publishedSlug: 'article-v1',
      publishedTitle: 'V1',
      publishedData: validData,
      publishedSeo: {},
    });
    const firstPublishedAt = state.entries.get(published.id)!.publishedAt;
    state.entries.set(published.id, {
      ...state.entries.get(published.id)!,
      title: 'V2 modifiée',
      data: { excerpt: 'Accroche V2', body: 'Corps V2.' },
    });
    rebuild.calls.length = 0;

    const outcome = await service.publishContent({ entryId: published.id, actorAdminId });
    expect(outcome.kind).toBe('published');
    const row = state.entries.get(published.id)!;
    expect(row.publishedTitle).toBe('V2 modifiée');
    expect(row.publishedData).toEqual({ excerpt: 'Accroche V2', body: 'Corps V2.' });
    expect(hasUnpublishedChanges(row)).toBe(false);
    expect(rebuild.calls).toEqual([{ reason: 'content.published' }]);
    expect(firstPublishedAt).toBeInstanceOf(Date);
  });
});

describe('published_at — première publication (mission §6)', () => {
  it('la republication (après édition ou après unpublish) ne réécrit jamais published_at', async () => {
    const { service, state } = setup();
    const original = new Date('2026-03-01T08:00:00Z');
    const published = await seedPublished(state, {
      status: 'published',
      publishedAt: original,
      publishedSlug: 'daté',
      publishedTitle: 'Daté',
      publishedData: validData,
      publishedSeo: {},
    });

    // Unpublish puis republication ultérieure.
    await service.unpublishContent({ entryId: published.id, actorAdminId: otherActorId });
    expect(state.entries.get(published.id)!.status).toBe('draft');
    expect(state.entries.get(published.id)!.publishedAt).toEqual(original);

    const outcome = await service.publishContent({ entryId: published.id, actorAdminId });
    expect(outcome.kind).toBe('published');
    expect(state.entries.get(published.id)!.publishedAt).toEqual(original);
  });
});

describe('unpublishContent (mission §7)', () => {
  it('published → draft : contenu et historique public conservés, audit, rebuild', async () => {
    const { service, state, rebuild } = setup();
    const publishedAt = new Date('2026-02-02T08:00:00Z');
    const published = await seedPublished(state, {
      status: 'published',
      publishedAt,
      slug: 'en-ligne',
      publishedSlug: 'en-ligne',
      publishedTitle: 'En ligne',
      publishedData: validData,
      publishedSeo: {},
    });

    const outcome = await service.unpublishContent({ entryId: published.id, actorAdminId });
    expect(outcome.kind).toBe('unpublished');
    const row = state.entries.get(published.id)!;
    expect(row.status).toBe('draft');
    expect(row.slug).toBe('en-ligne');
    expect(row.data).toEqual(validData);
    // Historique conservé.
    expect(row.publishedAt).toEqual(publishedAt);
    expect(row.publishedSlug).toBe('en-ligne');
    expect(rebuild.calls).toEqual([{ reason: 'content.unpublished' }]);

    const audit = state.auditRows.find((row) => row.action === 'content.unpublished');
    expect(audit?.actorAdminId).toBe(actorAdminId);
    expect(audit?.metadata).toMatchObject({ slug: 'en-ligne', publishedSlug: 'en-ligne' });
  });

  it('dépublier un draft est un no-op : ni audit ni rebuild', async () => {
    const { service, state, rebuild } = setup();
    const draft = await seedPublished(state, { status: 'draft' });
    const outcome = await service.unpublishContent({ entryId: draft.id, actorAdminId });
    expect(outcome.kind).toBe('not-published');
    expect(state.auditRows).toHaveLength(0);
    expect(rebuild.calls).toHaveLength(0);
  });
});

describe('redirections au changement de slug publié (mission §17-§23)', () => {
  it('changement de slug publié → redirection 301 (row créée, ownership posé)', async () => {
    const { service, state } = setup();
    const published = await seedPublished(state, {
      status: 'published',
      publishedAt: new Date(),
      slug: 'ancien-slug',
      publishedSlug: 'ancien-slug',
      publishedTitle: 'Titre',
      publishedData: validData,
      publishedSeo: {},
    });

    // Le Save a changé le slug éditorial ; l'ancien chemin reste public.
    state.entries.set(published.id, { ...state.entries.get(published.id)!, slug: 'nouveau-slug' });

    const outcome = await service.publishContent({ entryId: published.id, actorAdminId });
    expect(outcome.kind).toBe('published');
    if (outcome.kind !== 'published') return;
    expect(outcome.redirect).toEqual({
      fromPath: '/articles/ancien-slug',
      toPath: '/articles/nouveau-slug',
    });
    const redirectRow = state.redirects.get('/articles/ancien-slug');
    expect(redirectRow).toMatchObject({
      toPath: '/articles/nouveau-slug',
      contentEntryId: published.id,
    });
    // L'audit trace l'ancien slug (mission §16).
    const audit = state.auditRows.find((row) => row.action === 'content.published');
    expect(audit?.metadata).toMatchObject({ previousSlug: 'ancien-slug', redirectCreated: true });
  });

  it('un changement de slug sur un simple draft ne crée PAS de redirect (mission §18)', async () => {
    const { service, state } = setup();
    const draft = await seedPublished(state, { status: 'draft', slug: 'foo', publishedSlug: null });

    state.entries.set(draft.id, { ...state.entries.get(draft.id)!, slug: 'bar' });
    const outcome = await service.publishContent({ entryId: draft.id, actorAdminId });
    expect(outcome.kind).toBe('published');
    if (outcome.kind !== 'published') return;
    // Première publication : pas d'URL historique, pas de redirect.
    expect(outcome.redirect).toBeNull();
    expect(state.redirects.size).toBe(0);
  });

  it('chaîne /a → /b puis /b → /c est normalisée en /a → /c et /b → /c (mission §21)', async () => {
    const { service, state } = setup();
    // État : publié à b, redirection /a → /b existante.
    const published = await seedPublished(state, {
      status: 'published',
      publishedAt: new Date(),
      slug: 'b',
      publishedSlug: 'b',
      publishedTitle: 'Titre',
      publishedData: validData,
      publishedSeo: {},
    });
    state.redirects.set('/articles/a', {
      id: crypto.randomUUID(),
      fromPath: '/articles/a',
      toPath: '/articles/b',
      contentEntryId: published.id,
      createdAt: new Date(),
    });

    state.entries.set(published.id, { ...state.entries.get(published.id)!, slug: 'c' });
    await service.publishContent({ entryId: published.id, actorAdminId });

    // /b → /c créée, /a re-ciblée vers /c : jamais de chaîne.
    expect(state.redirects.get('/articles/b')?.toPath).toBe('/articles/c');
    expect(state.redirects.get('/articles/a')?.toPath).toBe('/articles/c');
  });

  it('slug réapparu : retour à un ancien slug remplace la redirection, aucune boucle (mission §22)', async () => {
    const { service, state } = setup();
    // État : publié à b, /a → /b.
    const published = await seedPublished(state, {
      status: 'published',
      publishedAt: new Date(),
      slug: 'b',
      publishedSlug: 'b',
      publishedTitle: 'Titre',
      publishedData: validData,
      publishedSeo: {},
    });
    state.redirects.set('/articles/a', {
      id: crypto.randomUUID(),
      fromPath: '/articles/a',
      toPath: '/articles/b',
      contentEntryId: published.id,
      createdAt: new Date(),
    });

    // L'admin ramène le slug à a et publie.
    state.entries.set(published.id, { ...state.entries.get(published.id)!, slug: 'a' });
    await service.publishContent({ entryId: published.id, actorAdminId });

    // /a est redevenue une page (sa redirection source a disparu) et /b → /a.
    expect(state.redirects.has('/articles/a')).toBe(false);
    expect(state.redirects.get('/articles/b')?.toPath).toBe('/articles/a');
  });

  it('conflit : l’ancien chemin public est occupé par un autre contenu → échec avant toute écriture', async () => {
    const { service, state } = setup();
    // Publié à 'foo', l'admin a enregistré un passage à 'bar' (non publié).
    const published = await seedPublished(state, {
      status: 'published',
      publishedAt: new Date(),
      slug: 'bar',
      publishedSlug: 'foo',
      publishedTitle: 'Foo',
      publishedData: validData,
      publishedSeo: {},
    });
    // Un AUTRE contenu actif occupe désormais 'foo' — l'ancien chemin public.
    const occupant = stubContentEntry({ slug: 'foo', data: validData });
    state.entries.set(occupant.id, occupant);

    await expect(service.publishContent({ entryId: published.id, actorAdminId })).rejects.toThrow(
      PublishedPathOccupiedError,
    );
    // Aucune écriture : snapshots inchangés, aucun redirect, aucun audit.
    expect(state.entries.get(published.id)!.status).toBe('published');
    expect(state.entries.get(published.id)!.publishedSlug).toBe('foo');
    expect(state.redirects.size).toBe(0);
    expect(state.auditRows).toHaveLength(0);
  });

  it('l’ancien slug public survivant en snapshot sert de source fiable (mission §19)', async () => {
    const { service, state } = setup();
    // Slug public foo ; deux éditions successives foo → bar → baz avant publish.
    const published = await seedPublished(state, {
      status: 'published',
      publishedAt: new Date(),
      slug: 'foo',
      publishedSlug: 'foo',
      publishedTitle: 'Titre',
      publishedData: validData,
      publishedSeo: {},
    });
    state.entries.set(published.id, { ...state.entries.get(published.id)!, slug: 'bar' });
    state.entries.set(published.id, { ...state.entries.get(published.id)!, slug: 'baz' });

    const outcome = await service.publishContent({ entryId: published.id, actorAdminId });
    if (outcome.kind !== 'published') return expect.unreachable();
    // Seul le dernier chemin réellement public compte : /foo → /baz.
    expect(outcome.redirect).toEqual({ fromPath: '/articles/foo', toPath: '/articles/baz' });
    expect(state.redirects.has('/articles/bar')).toBe(false);
  });
});

describe('rebuild — échecs et absence d’adapter (mission §10, §11, §40)', () => {
  it('absence d’adapter : publication réussie, rebuild not-configured, pas d’audit d’échec', async () => {
    const { service, state, rebuild } = setup();
    rebuild.nextResult = { ok: false, failure: { kind: 'not-configured' } };
    const draft = await seedPublished(state, { status: 'draft' });

    const outcome = await service.publishContent({ entryId: draft.id, actorAdminId });
    expect(outcome.kind).toBe('published');
    if (outcome.kind !== 'published') return;
    expect(outcome.rebuild).toEqual({ ok: false, failure: { kind: 'not-configured' } });
    // L'état DB reste publié (DB = source éditoriale), pas d'échec journalisé.
    expect(state.entries.get(draft.id)!.status).toBe('published');
    expect(state.auditRows.some((row) => row.action === 'site.rebuild_failed')).toBe(false);
  });

  it('trigger en échec : DB reste publiée, site inchangé, échec audité sans secret (mission §11)', async () => {
    const { service, state, rebuild } = setup();
    rebuild.nextResult = { ok: false, failure: { kind: 'rejected', statusCode: 503 } };
    const draft = await seedPublished(state, { status: 'draft' });

    const outcome = await service.publishContent({ entryId: draft.id, actorAdminId });
    expect(outcome.kind).toBe('published');
    if (outcome.kind !== 'published') return;
    expect(outcome.rebuild.ok).toBe(false);
    // DB = source éditoriale : le contenu reste publié (pas de rollback, mission §12).
    expect(state.entries.get(draft.id)!.status).toBe('published');

    const failure = state.auditRows.find((row) => row.action === 'site.rebuild_failed');
    expect(failure?.actorAdminId).toBe(actorAdminId);
    expect(failure?.metadata).toEqual({ operation: 'content.published', failure: 'rejected', statusCode: 503 });
  });

  it('rebuild manuel : même port, audit site.rebuild_requested', async () => {
    const { service, state, rebuild } = setup();
    const outcome = await service.requestSiteRebuild({ actorAdminId });
    expect(outcome.rebuild.ok).toBe(true);
    expect(rebuild.calls).toEqual([{ reason: 'manual' }]);
    const audit = state.auditRows.find((row) => row.action === 'site.rebuild_requested');
    expect(audit?.actorAdminId).toBe(actorAdminId);
    expect(audit?.metadata).toMatchObject({ reason: 'manual', source: 'admin', outcome: 'requested' });
  });

  it('le rebuild est idempotent : plusieurs déclenchements successifs possibles (mission §34)', async () => {
    const { service, rebuild } = setup();
    await service.requestSiteRebuild({ actorAdminId });
    await service.requestSiteRebuild({ actorAdminId });
    expect(rebuild.calls).toHaveLength(2);
  });
});
