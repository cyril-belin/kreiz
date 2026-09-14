import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createAdminUsersRepository,
  type KreizAdminUser,
} from '../../src/data';
import { createContentTypeRegistry } from '../../src/domain/content/registry';
import { fields } from '../../src/domain/content/fields';
import { ContentDataCorruptedError, PublishedPathOccupiedError } from '../../src/domain/content/errors';
import { hasUnpublishedChanges, resolvePublishedProjection } from '../../src/domain/content/publication-state';
import { createContentService } from '../../src/services/content';
import { createPublicationService } from '../../src/services/publication';
import { createContentEntriesRepository } from '../../src/data/repositories/content-entries';
import { createRedirectsRepository } from '../../src/data/repositories/redirects';
import { createAdminAuditLogRepository } from '../../src/data/repositories/admin-audit-log';
import {
  describeIntegration,
  expectPgError,
  setupIntegration,
  withTransientNetworkRetry,
  type IntegrationHarness,
} from './helpers';
import { createRebuildTriggerStub, type RebuildTriggerStub } from '../helpers/stub-rebuild-trigger';

/**
 * Publication contre PostgreSQL réel (mission §44) : le cycle complet du
 * service de publication sur la chaîne de migrations `apps/demo` —
 * publish (snapshots, published_at), unpublish, republication, redirects
 * normalisés (upsert `from_path` réel, re-cible), conflit d'occupation,
 * course concurrentielle sur le slug, audit, suppression d'un publié.
 * 0 donnée résiduelle.
 */
const runId = crypto.randomUUID().slice(0, 8);
const namespace = `pub-${runId}`;
const emailPattern = `it-${runId}%@example.test`;

let harness: IntegrationHarness;
let entriesRepo: ReturnType<typeof createContentEntriesRepository>;
let redirectsRepo: ReturnType<typeof createRedirectsRepository>;
let publication: ReturnType<typeof createPublicationService>;
let content: ReturnType<typeof createContentService>;
let rebuild: RebuildTriggerStub;
let admin: KreizAdminUser;
let secondAdmin: KreizAdminUser;

const registry = createContentTypeRegistry({
  declarations: [
    {
      // Clé de type propre au run : le build démo du test public-build
      // (parallèle sur la même base) ne doit jamais lire ces lignes — le
      // lecteur public filtre par content_type des déclarations du Project.
      key: `pub_${runId}`,
      label: 'Article',
      routeNamespace: namespace,
      fields: {
        excerpt: fields.text({ label: 'Accroche', required: true }),
        body: fields.textarea({ label: 'Corps', required: true }),
      },
      template: 'src/templates/ArticleContent.astro',
    },
  ],
  templates: { [`pub_${runId}`]: function KreizFakeTemplate() {} },
});

const validData = { excerpt: `Accroche ${runId}`, body: `Corps ${runId}.` };

function createdId(outcome: Awaited<ReturnType<ReturnType<typeof createContentService>['createDraft']>>): string {
  if (outcome.kind !== 'created') throw new Error('fixture non créée');
  return outcome.entry.id;
}

describeIntegration('publication — service + PostgreSQL réel', () => {
  beforeAll(async () => {
    harness = await setupIntegration();
    entriesRepo = createContentEntriesRepository(harness.db);
    redirectsRepo = createRedirectsRepository(harness.db);
    rebuild = createRebuildTriggerStub();
    const audit = createAdminAuditLogRepository(harness.db);
    content = createContentService({
      entries: entriesRepo,
      audit,
      registry,
      rebuild,
    });
    publication = createPublicationService({
      entries: entriesRepo,
      redirects: redirectsRepo,
      audit,
      registry,
      rebuild,
    });
    const users = createAdminUsersRepository(harness.db);
    admin = await withTransientNetworkRetry(() =>
      users.create({
        email: `it-${runId}-admin@example.test`,
        passwordHash: 'hash-test-argon2id',
        name: 'Admin publication',
      }),
    );
    secondAdmin = await withTransientNetworkRetry(() =>
      users.create({
        email: `it-${runId}-second@example.test`,
        passwordHash: 'hash-test-argon2id',
        name: 'Second admin',
      }),
    );
  }, 60_000);

  afterAll(async () => {
    if (!harness) return;
    // Ordre FK : redirects (SET NULL survivrait sinon) → audit → contenus → admins.
    await withTransientNetworkRetry(() =>
      harness.raw(sql`delete from kreiz_redirects where from_path like ${`/${namespace}/%`}`),
    );
    await withTransientNetworkRetry(() =>
      harness.raw(
        sql`delete from kreiz_admin_audit_log where entity_id in (select id::text from kreiz_content_entries where route_namespace = ${namespace}) or (entity_id = 'rebuild' and actor_admin_id in (${admin.id}, ${secondAdmin.id}))`,
      ),
    );
    await withTransientNetworkRetry(() =>
      harness.raw(sql`delete from kreiz_content_entries where route_namespace = ${namespace}`),
    );
    await harness.raw(sql`delete from kreiz_admin_users where email like ${emailPattern}`);
    await harness.close();
  }, 60_000);

  it('publish persiste l’état publié : snapshots, published_at, traçabilité, audit, rebuild', async () => {
    const draftId = createdId(
      await content.createDraft({
        contentTypeKey: `pub_${runId}`,
        title: 'Article publié Neon',
        data: validData,
        actorAdminId: admin.id,
      }),
    );
    rebuild.calls.length = 0;

    const outcome = await publication.publishContent({ entryId: draftId, actorAdminId: admin.id });
    expect(outcome.kind).toBe('published');

    const row = (await entriesRepo.findById(draftId))!;
    expect(row.status).toBe('published');
    expect(row.publishedSlug).toBe('article-publie-neon');
    expect(row.publishedTitle).toBe('Article publié Neon');
    expect(row.publishedData).toEqual(validData);
    expect(row.publishedAt).toBeInstanceOf(Date);
    expect(row.updatedBy).toBe(admin.id);
    expect(hasUnpublishedChanges(row)).toBe(false);

    expect(rebuild.calls).toEqual([{ reason: 'content.published' }]);
    const audit = await harness.raw(
      sql`select action, actor_admin_id, metadata from kreiz_admin_audit_log where entity_id = ${draftId} and action = 'content.published'`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_admin_id: admin.id });
  });

  it('republication après édition : snapshots mis à jour, published_at inchangé (mission §6)', async () => {
    const draftId = createdId(
      await content.createDraft({
        contentTypeKey: `pub_${runId}`,
        title: 'Article daté',
        data: validData,
        actorAdminId: admin.id,
      }),
    );
    await publication.publishContent({ entryId: draftId, actorAdminId: admin.id });
    const firstPublishedAt = (await entriesRepo.findById(draftId))!.publishedAt;
    expect(firstPublishedAt).toBeInstanceOf(Date);

    // Édition par un second admin puis publication des modifications.
    await content.updateDraft({
      entryId: draftId,
      title: 'Article daté — v2',
      data: { excerpt: 'Accroche v2', body: 'Corps v2.' },
      actorAdminId: secondAdmin.id,
    });
    const edited = (await entriesRepo.findById(draftId))!;
    expect(edited.publishedTitle).toBe('Article daté'); // snapshot intact
    expect(hasUnpublishedChanges(edited)).toBe(true);

    const outcome = await publication.publishContent({ entryId: draftId, actorAdminId: admin.id });
    expect(outcome.kind).toBe('published');
    const republished = (await entriesRepo.findById(draftId))!;
    expect(republished.publishedTitle).toBe('Article daté — v2');
    expect(republished.publishedData).toEqual({ excerpt: 'Accroche v2', body: 'Corps v2.' });
    // La date de première publication n'est jamais réécrite.
    expect(republished.publishedAt).toEqual(firstPublishedAt);
    expect(republished.updatedBy).toBe(admin.id);
    expect(hasUnpublishedChanges(republished)).toBe(false);
  });

  it('unpublish puis republication : historique conservé, published_at originel conservé', async () => {
    const draftId = createdId(
      await content.createDraft({
        contentTypeKey: `pub_${runId}`,
        title: 'Article réversible',
        data: validData,
        actorAdminId: admin.id,
      }),
    );
    await publication.publishContent({ entryId: draftId, actorAdminId: admin.id });
    const originalAt = (await entriesRepo.findById(draftId))!.publishedAt;

    const unpublished = await publication.unpublishContent({ entryId: draftId, actorAdminId: admin.id });
    expect(unpublished.kind).toBe('unpublished');
    const draftRow = (await entriesRepo.findById(draftId))!;
    expect(draftRow.status).toBe('draft');
    // Contenu et historique public conservés.
    expect(draftRow.slug).toBe('article-reversible');
    expect(draftRow.publishedAt).toEqual(originalAt);
    expect(draftRow.publishedSlug).toBe('article-reversible');
    const audit = await harness.raw(
      sql`select action from kreiz_admin_audit_log where entity_id = ${draftId} and action = 'content.unpublished'`,
    );
    expect(audit).toHaveLength(1);
    expect(rebuild.calls.at(-1)).toEqual({ reason: 'content.unpublished' });

    // Republication : repart en published sans réécrire published_at.
    await publication.publishContent({ entryId: draftId, actorAdminId: admin.id });
    const republished = (await entriesRepo.findById(draftId))!;
    expect(republished.status).toBe('published');
    expect(republished.publishedAt).toEqual(originalAt);
  });

  it('redirection de changement de slug publié : row 301 créée, re-cible normalisée (mission §21)', async () => {
    const draftId = createdId(
      await content.createDraft({
        contentTypeKey: `pub_${runId}`,
        title: 'Article migré',
        data: validData,
        actorAdminId: admin.id,
        slug: 'migre-a',
      }),
    );
    await publication.publishContent({ entryId: draftId, actorAdminId: admin.id });

    // a → b : publication avec nouveau slug → redirect /a → /b.
    await content.updateDraft({
      entryId: draftId,
      title: 'Article migré',
      slug: 'migre-b',
      data: validData,
      actorAdminId: admin.id,
    });
    const first = await publication.publishContent({ entryId: draftId, actorAdminId: admin.id });
    if (first.kind !== 'published') throw new Error('attendu published');
    expect(first.redirect).toEqual({ fromPath: `/${namespace}/migre-a`, toPath: `/${namespace}/migre-b` });
    const rowB = await redirectsRepo.findByFromPath(`/${namespace}/migre-a`);
    expect(rowB).toMatchObject({ toPath: `/${namespace}/migre-b`, contentEntryId: draftId });

    // b → c : /a → /b devient /a → /c (normalisation), plus /b → /c.
    await content.updateDraft({
      entryId: draftId,
      title: 'Article migré',
      slug: 'migre-c',
      data: validData,
      actorAdminId: admin.id,
    });
    const second = await publication.publishContent({ entryId: draftId, actorAdminId: admin.id });
    if (second.kind !== 'published') throw new Error('attendu published');
    expect(second.redirect).toEqual({ fromPath: `/${namespace}/migre-b`, toPath: `/${namespace}/migre-c` });
    expect((await redirectsRepo.findByFromPath(`/${namespace}/migre-a`))?.toPath).toBe(
      `/${namespace}/migre-c`,
    );
    expect((await redirectsRepo.findByFromPath(`/${namespace}/migre-b`))?.toPath).toBe(
      `/${namespace}/migre-c`,
    );

    // Les audits tracés : première publication + 2 changements avec previousSlug.
    const audits = await harness.raw(
      sql`select metadata from kreiz_admin_audit_log where entity_id = ${draftId} and action = 'content.published' order by created_at`,
    );
    expect(audits).toHaveLength(3);
    expect(audits[1]?.metadata).toMatchObject({ previousSlug: 'migre-a', redirectCreated: true });
  });

  it('slug réapparu : retour à un ancien slug publié supprime la redirection source (aucune boucle)', async () => {
    const draftId = createdId(
      await content.createDraft({
        contentTypeKey: `pub_${runId}`,
        title: 'Article ping-pong',
        data: validData,
        actorAdminId: admin.id,
        slug: 'ping',
      }),
    );
    await publication.publishContent({ entryId: draftId, actorAdminId: admin.id });
    // ping → pong
    await content.updateDraft({ entryId: draftId, title: 'Article ping-pong', slug: 'pong', data: validData, actorAdminId: admin.id });
    await publication.publishContent({ entryId: draftId, actorAdminId: admin.id });
    expect(await redirectsRepo.findByFromPath(`/${namespace}/ping`)).toBeTruthy();

    // pong → ping : /ping redevient une page, la redirection /ping → /pong meurt.
    await content.updateDraft({ entryId: draftId, title: 'Article ping-pong', slug: 'ping', data: validData, actorAdminId: admin.id });
    const outcome = await publication.publishContent({ entryId: draftId, actorAdminId: admin.id });
    if (outcome.kind !== 'published') throw new Error('attendu published');
    expect(outcome.redirect).toEqual({ fromPath: `/${namespace}/pong`, toPath: `/${namespace}/ping` });
    expect(await redirectsRepo.findByFromPath(`/${namespace}/ping`)).toBeNull();
    expect((await redirectsRepo.findByFromPath(`/${namespace}/pong`))?.toPath).toBe(`/${namespace}/ping`);
  });

  it('conflit d’occupation : l’ancien chemin public appartient à un autre contenu → PublishedPathOccupiedError, rien d’écrit', async () => {
    const moved = createdId(
      await content.createDraft({
        contentTypeKey: `pub_${runId}`,
        title: 'Article déplacé',
        data: validData,
        actorAdminId: admin.id,
        slug: 'deplace-original',
      }),
    );
    await publication.publishContent({ entryId: moved, actorAdminId: admin.id });

    // Le Save change le slug éditorial ; l'occupation survient hors bande.
    await content.updateDraft({
      entryId: moved,
      title: 'Article déplacé',
      slug: 'deplace-nouveau',
      data: validData,
      actorAdminId: admin.id,
    });
    const occupant = createdId(
      await content.createDraft({
        contentTypeKey: `pub_${runId}`,
        title: 'Occupant',
        data: validData,
        actorAdminId: secondAdmin.id,
        slug: 'deplace-original',
      }),
    );
    await publication.publishContent({ entryId: occupant, actorAdminId: secondAdmin.id });

    const before = await entriesRepo.findById(moved);
    await expect(publication.publishContent({ entryId: moved, actorAdminId: admin.id })).rejects.toThrow(
      PublishedPathOccupiedError,
    );
    // Aucun effet de bord : la ligne est intacte, l'occupant reste publié.
    const after = await entriesRepo.findById(moved);
    expect(after).toEqual(before);
    expect((await entriesRepo.findById(occupant))!.status).toBe('published');
  });

  it('course concurrentielle : l’index unique partiel refuse un doublon de slug actif (23505 réelle)', async () => {
    const first = createdId(
      await content.createDraft({
        contentTypeKey: `pub_${runId}`,
        title: 'Course',
        data: validData,
        actorAdminId: admin.id,
        slug: 'course-libre',
      }),
    );
    await publication.publishContent({ entryId: first, actorAdminId: admin.id });
    // Deux publications concurrentes du même contenu : idempotentes (mission §33/§34).
    const second = await publication.publishContent({ entryId: first, actorAdminId: admin.id });
    if (second.kind !== 'published') throw new Error('attendu published');
    expect(second.redirect).toBeNull(); // slug public inchangé — pas de redirect

    // Un doublon de slug actif est refusé par l'index unique partiel.
    await expectPgError(
      () =>
        entriesRepo.create({
          contentType: `pub_${runId}`,
          routeNamespace: namespace,
          title: 'Doublon',
          slug: 'course-libre',
          data: validData,
          createdBy: admin.id,
          updatedBy: admin.id,
        }),
      '23505',
    );
  });

  it('suppression d’un contenu publié : soft delete + audit + rebuild ; brouillon : aucun rebuild', async () => {
    const publishedId = createdId(
      await content.createDraft({
        contentTypeKey: `pub_${runId}`,
        title: 'À supprimer publié',
        data: validData,
        actorAdminId: admin.id,
      }),
    );
    await publication.publishContent({ entryId: publishedId, actorAdminId: admin.id });
    rebuild.calls.length = 0;
    const deleted = await content.deleteDraft({ entryId: publishedId, actorAdminId: admin.id });
    expect(deleted.wasPublished).toBe(true);
    expect(deleted.rebuild).toEqual({ ok: true, requestId: 'req-stub' });
    expect(rebuild.calls).toEqual([{ reason: 'content.deleted' }]);

    const draftId = createdId(
      await content.createDraft({
        contentTypeKey: `pub_${runId}`,
        title: 'À supprimer brouillon',
        data: validData,
        actorAdminId: admin.id,
      }),
    );
    rebuild.calls.length = 0;
    const deletedDraft = await content.deleteDraft({ entryId: draftId, actorAdminId: admin.id });
    expect(deletedDraft.wasPublished).toBe(false);
    expect(deletedDraft.rebuild).toBeNull();
    expect(rebuild.calls).toHaveLength(0);
  });

  it('lignes publiées sans snapshot = corruption : le lecteur échoue explicitement (mission §39)', async () => {
    // Écriture directe en base (contourne Publish — l'unique écrivain légitime).
    const rows = await harness.raw(
      sql`insert into kreiz_content_entries (content_type, route_namespace, title, slug, status, published_at, data, created_by, updated_by)
          values ('article', ${namespace}, 'Corrompu', ${`corrompu-${runId}`}, 'published', now(), ${JSON.stringify(validData)}::jsonb, ${admin.id}, ${admin.id})
          returning id`,
    );
    const corruptedId = String(rows[0]!.id);
    const corrupted = (await entriesRepo.findById(corruptedId))!;
    expect(() => resolvePublishedProjection(corrupted)).toThrow(ContentDataCorruptedError);
  });

  it('projection publique : un contenu dérivé résout au slug public, jamais au slug courant', async () => {
    const driftId = createdId(
      await content.createDraft({
        contentTypeKey: `pub_${runId}`,
        title: 'Dérive publique',
        data: validData,
        actorAdminId: admin.id,
        slug: 'derive-pub',
      }),
    );
    await publication.publishContent({ entryId: driftId, actorAdminId: admin.id });
    await content.updateDraft({
      entryId: driftId,
      title: 'Dérive publique v2',
      slug: 'derive-courant',
      data: { excerpt: 'Dérive v2', body: 'Corps v2.' },
      actorAdminId: admin.id,
    });

    // Le lecteur public ne trouve QUE le slug publié.
    const byPublicSlug = await entriesRepo.findPublishedByNamespaceAndPublishedSlug(namespace, 'derive-pub');
    expect(byPublicSlug?.id).toBe(driftId);
    const byCurrentSlug = await entriesRepo.findPublishedByNamespaceAndPublishedSlug(namespace, 'derive-courant');
    expect(byCurrentSlug).toBeNull();

    // La projection utilisée par le build reste la version figée.
    const projection = resolvePublishedProjection((await entriesRepo.findById(driftId))!);
    expect(projection.title).toBe('Dérive publique');
    expect(projection.slug).toBe('derive-pub');
    expect(projection.data).toEqual(validData);
    // Les routes publiées vivantes pour la matérialisation des redirections.
    const routes = await entriesRepo.listPublishedRoutes();
    expect(routes).toContainEqual({ routeNamespace: namespace, slug: 'derive-pub' });
  });
});
