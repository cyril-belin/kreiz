import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createAdminUsersRepository } from '../../src/data/repositories/admin-users';
import type { KreizAdminUser } from '../../src/data';
import { createContentTypeRegistry } from '../../src/domain/content/registry';
import { fields } from '../../src/domain/content/fields';
import { ContentConcurrentModificationError, ContentDataCorruptedError } from '../../src/domain/content/errors';
import { createContentService, CONTENT_AUDIT_ACTIONS } from '../../src/services/content';
import { createPublicationService } from '../../src/services/publication';
import { createContentEntriesRepository } from '../../src/data/repositories/content-entries';
import { createMediaRepository } from '../../src/data/repositories/media';
import { createAdminAuditLogRepository } from '../../src/data/repositories/admin-audit-log';
import { createRedirectsRepository } from '../../src/data/repositories/redirects';
import {
  describeIntegration,
  expectPgError,
  setupIntegration,
  withTransientNetworkRetry,
  type IntegrationHarness,
} from './helpers';
import { createRebuildTriggerStub } from '../helpers/stub-rebuild-trigger';

/**
 * Moteur de contenu contre PostgreSQL réel (mission §34) : le service est
 * exercé par l'API publique du Core (repositories + registre), sur la
 * chaîne de migrations `apps/demo`. Vérifie l'index unique **partiel**
 * `(route_namespace, slug) WHERE deleted_at IS NULL`, la traçabilité
 * created_by/updated_by, l'isolation des types et l'audit
 * content.created/updated/deleted. 0 donnée résiduelle.
 */
const runId = crypto.randomUUID().slice(0, 8);
const emailPattern = `it-${runId}%@example.test`;

let harness: IntegrationHarness;
let service: ReturnType<typeof createContentService>;
let publication: ReturnType<typeof createPublicationService>;
let entriesRepo: ReturnType<typeof createContentEntriesRepository>;
let admin: KreizAdminUser;
let secondAdmin: KreizAdminUser;
let articleId = '';

const registry = createContentTypeRegistry({
  declarations: [
    {
      key: 'article',
      label: 'Article',
      labelPlural: 'Articles',
      routeNamespace: `art-${runId}`,
      fields: {
        excerpt: fields.text({ label: 'Accroche', required: true, maxLength: 300 }),
        body: fields.textarea({ label: 'Corps', required: true }),
      },
      template: 'src/templates/ArticleContent.astro',
    },
    {
      key: 'guide',
      label: 'Guide',
      labelPlural: 'Guides',
      routeNamespace: `gd-${runId}`,
      fields: { body: fields.textarea({ label: 'Corps', required: true }) },
      template: 'src/templates/GuideContent.astro',
    },
  ],
  templates: {
    article: function KreizFakeTemplate() {},
    guide: function KreizFakeTemplate() {},
  },
});

describeIntegration('moteur de contenu — service + PostgreSQL réel', () => {
  beforeAll(async () => {
    harness = await setupIntegration();
    entriesRepo = createContentEntriesRepository(harness.db);
    const users = createAdminUsersRepository(harness.db);
    service = createContentService({
      entries: entriesRepo,
      media: createMediaRepository(harness.db),
      audit: createAdminAuditLogRepository(harness.db),
      registry,
      rebuild: createRebuildTriggerStub(),
      mediaPublicBaseUrl: 'https://media.example.test/cdn',
    });
    publication = createPublicationService({
      entries: entriesRepo,
      media: createMediaRepository(harness.db),
      redirects: createRedirectsRepository(harness.db),
      audit: createAdminAuditLogRepository(harness.db),
      registry,
      rebuild: createRebuildTriggerStub(),
      mediaPublicBaseUrl: 'https://media.example.test/cdn',
    });
    admin = await withTransientNetworkRetry(() =>
      users.create({
        email: `it-${runId}-admin@example.test`,
        passwordHash: 'hash-test-argon2id',
        name: 'Admin contenu',
      }),
    );
    secondAdmin = await withTransientNetworkRetry(() =>
      users.create({
        email: `it-${runId}-second@example.test`,
        passwordHash: 'hash-test-argon2id',
        name: 'Second éditeur',
      }),
    );
  }, 60_000);

  afterAll(async () => {
    if (!harness) return;
    // Ordre FK : audit (RESTRICT acteur) et contenus (RESTRICT created_by)
    // avant les admins. Aucune donnée résiduelle.
    await harness.raw(sql`delete from kreiz_admin_audit_log where actor_admin_id in (select id from kreiz_admin_users where email like ${emailPattern})`);
    await harness.raw(sql`delete from kreiz_content_entries where created_by in (select id from kreiz_admin_users where email like ${emailPattern})`);
    await harness.raw(sql`delete from kreiz_admin_users where email like ${emailPattern}`);
    await harness.close();
  }, 60_000);

  it('createDraft persiste titre, data typée, namespace imposé et traçabilité', async () => {
    const outcome = await withTransientNetworkRetry(() =>
      service.createDraft({
        contentTypeKey: 'article',
        title: 'Contenu d’intégration',
        data: { excerpt: 'Accroche réelle', body: 'Corps du contenu.' },
        actorAdminId: admin.id,
      }),
    );
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    articleId = outcome.entry.id;
    expect(outcome.entry.contentType).toBe('article');
    expect(outcome.entry.routeNamespace).toBe(`art-${runId}`);
    expect(outcome.entry.status).toBe('draft');
    expect(outcome.entry.title).toBe('Contenu d’intégration');
    expect(outcome.entry.data).toEqual({ excerpt: 'Accroche réelle', body: 'Corps du contenu.' });
    expect(outcome.entry.createdBy).toBe(admin.id);
    expect(outcome.entry.updatedBy).toBe(admin.id);
    expect(outcome.entry.slug).toBe('contenu-d-integration');
  });

  it('génère le slug depuis le titre et suffixe les collisions (foo, foo-2, foo-3)', async () => {
    const slugs: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const outcome = await withTransientNetworkRetry(() =>
        service.createDraft({
          contentTypeKey: 'guide',
          title: 'Même sujet',
          data: { body: 'Corps.' },
          actorAdminId: admin.id,
        }),
      );
      expect(outcome.kind).toBe('created');
      if (outcome.kind === 'created') slugs.push(outcome.entry.slug);
    }
    expect(slugs).toEqual(['meme-sujet', 'meme-sujet-2', 'meme-sujet-3']);
  });

  it('refuse une validation invalide sans rien persister', async () => {
    const outcome = await service.createDraft({
      contentTypeKey: 'article',
      title: 'Invalide',
      data: { excerpt: '' }, // requis vide
      actorAdminId: admin.id,
    });
    expect(outcome).toMatchObject({ kind: 'invalid', errors: { excerpt: /requis/i } });
  });

  it('updateDraft modifie le brouillon et trace updated_by + audit', async () => {
    const outcome = await service.updateDraft({
      entryId: articleId,
      title: 'Contenu modifié',
      slug: 'contenu-modifie',
      data: { excerpt: 'Accroche v2', body: 'Corps v2.' },
      actorAdminId: secondAdmin.id,
    });
    expect(outcome.kind).toBe('updated');
    if (outcome.kind !== 'updated') return;
    expect(outcome.entry.title).toBe('Contenu modifié');
    expect(outcome.entry.slug).toBe('contenu-modifie');
    expect(outcome.entry.updatedBy).toBe(secondAdmin.id);
    const auditRows = await harness.raw(
      sql`select action, actor_admin_id from kreiz_admin_audit_log where entity_id = ${articleId} order by created_at asc`,
    );
    expect(auditRows.map((row) => row.action)).toEqual([
      CONTENT_AUDIT_ACTIONS.created,
      CONTENT_AUDIT_ACTIONS.updated,
    ]);
    expect(auditRows[0]?.actor_admin_id).toBe(admin.id);
    expect(auditRows[1]?.actor_admin_id).toBe(secondAdmin.id);
  });

  it('concurrence optimiste (passe de fermeture) : deux éditeurs — le premier gagne, le second reçoit ContentConcurrentModificationError, rien n’est écrasé', async () => {
    const created = await service.createDraft({
      contentTypeKey: 'article',
      title: 'Concurrence',
      data: { excerpt: 'Accroche', body: 'Corps.' },
      actorAdminId: admin.id,
      slug: 'concurrence-optimiste',
    });
    if (created.kind !== 'created') throw new Error('attendu created');
    const entryId = created.entry.id;

    // Les deux éditeurs ouvrent la même version.
    const openedByA = await entriesRepo.findById(entryId);
    const openedByB = await entriesRepo.findById(entryId);
    expect(openedByA!.updatedAt).toEqual(openedByB!.updatedAt);

    // B enregistre en premier (garde active, version fraîche) → gagne.
    const bOutcome = await service.updateDraft({
      entryId,
      title: 'Version de B',
      data: { excerpt: 'Accroche B', body: 'Corps B.' },
      expectedUpdatedAt: openedByB!.updatedAt.toISOString(),
      actorAdminId: secondAdmin.id,
    });
    expect(bOutcome.kind).toBe('updated');

    // A enregistre ensuite avec la version OBSOLÈTE → conflit explicite.
    await expect(
      service.updateDraft({
        entryId,
        title: 'Version périmée de A',
        data: { excerpt: 'Accroche A', body: 'Corps A.' },
        expectedUpdatedAt: openedByA!.updatedAt.toISOString(),
        actorAdminId: admin.id,
      }),
    ).rejects.toThrow(ContentConcurrentModificationError);
    // Rien n'a été écrasé : la version de B fait foi.
    expect((await entriesRepo.findById(entryId))!.title).toBe('Version de B');

    // A recharge puis reporte avec la version fraîche → réussit.
    const fresh = await entriesRepo.findById(entryId);
    const retry = await service.updateDraft({
      entryId,
      title: 'Version reportée de A',
      data: { excerpt: 'Accroche A2', body: 'Corps A2.' },
      expectedUpdatedAt: fresh!.updatedAt.toISOString(),
      actorAdminId: admin.id,
    });
    expect(retry.kind).toBe('updated');

    // Version non parsable → conflit immédiat (état altéré, jamais une écriture).
    await expect(
      service.updateDraft({
        entryId,
        title: 'Jamais écrit',
        data: { excerpt: 'x', body: 'y' },
        expectedUpdatedAt: 'pas-une-date',
        actorAdminId: admin.id,
      }),
    ).rejects.toThrow(ContentConcurrentModificationError);
    expect((await entriesRepo.findById(entryId))!.title).toBe('Version reportée de A');

    // Sans garde (flows historiques) : écriture inconditionnelle conservée.
    const legacy = await service.updateDraft({
      entryId,
      title: 'Sans garde',
      data: { excerpt: 'x', body: 'y' },
      actorAdminId: admin.id,
    });
    expect(legacy.kind).toBe('updated');
  });

  it('microsecondes timestamptz (passe de fermeture) : une version rendue à la ms passe la garde même si la base garde des µs', async () => {
    const created = await service.createDraft({
      contentTypeKey: 'article',
      title: 'Microsecondes',
      data: { excerpt: 'A.', body: 'B.' },
      actorAdminId: admin.id,
      slug: 'microsecondes',
    });
    if (created.kind !== 'created') throw new Error('attendu created');
    const entryId = created.entry.id;
    // Écriture **SQL directe** : `now()` PostgreSQL porte des microsecondes
    // que la Date JS perd à la lecture du formulaire.
    await harness.raw(sql`update kreiz_content_entries set updated_at = now() where id = ${entryId}`);
    const rendered = await entriesRepo.findById(entryId);
    const renderedIso = rendered!.updatedAt.toISOString();
    const outcome = await service.updateDraft({
      entryId,
      title: 'Sauvegarde après lecture µs',
      data: { excerpt: 'A2.', body: 'B2.' },
      expectedUpdatedAt: renderedIso,
      actorAdminId: admin.id,
    });
    expect(outcome.kind).toBe('updated');
  });

  it('Save ≠ Publish intact (passe de fermeture) : un Publish après un Save concurrent publie l’état courant en base, jamais un état client obsolète', async () => {
    const created = await service.createDraft({
      contentTypeKey: 'article',
      title: 'Publish concurrent',
      data: { excerpt: 'Accroche', body: 'Corps.' },
      actorAdminId: admin.id,
      slug: 'publish-concurrent',
    });
    if (created.kind !== 'created') throw new Error('attendu created');
    const entryId = created.entry.id;

    // A "ouvre" une page (version v1), B enregistre une nouvelle version v2,
    // A publie : Publish ne transporte AUCUNE donnée de formulaire — il
    // publie l'état courant en base (v2). Rien de périmé ne peut être
    // publié, et la v2 reste dans le brouillon quel que soit le snapshot.
    const v1 = await entriesRepo.findById(entryId);
    await service.updateDraft({
      entryId,
      title: 'Version publiée (v2)',
      data: { excerpt: 'Accroche v2', body: 'Corps v2.' },
      actorAdminId: secondAdmin.id,
    });
    const published = await publication.publishContent({ entryId, actorAdminId: admin.id });
    expect(published.kind).toBe('published');
    if (published.kind !== 'published') return;
    // Le snapshot porte bien l'état courant (v2), pas un hypothétique état v1.
    expect(published.entry.publishedTitle).toBe('Version publiée (v2)');
    expect(published.entry.publishedSlug).toBe('publish-concurrent');
    // La garde Save n'empêche pas le Publish (aucun expectedUpdatedAt en jeu).
    expect(v1).not.toBeNull();

    // Nettoyage immédiat : le contenu publié doit sortir des lectures
    // publiques sans attendre l'afterAll — le build Astro des tests
    // d'intégration parallèles lit les lignes publiées vivantes.
    await service.deleteDraft({ entryId, actorAdminId: admin.id });
  });

  it('l’index unique partiel protège la collision — même après vérification préalable', async () => {
    // Création directe via le repository (simule une course concurrentielle
    // entre la vérification du service et l'écriture) : PostgreSQL tranche.
    await expectPgError(
      () =>
        entriesRepo.create({
          contentType: 'article',
          routeNamespace: `art-${runId}`,
          title: 'Collision',
          slug: 'contenu-modifie',
          createdBy: admin.id,
          updatedBy: admin.id,
        }),
      '23505',
    );
  });

  it('listContent isole les types et liste les actifs', async () => {
    const articles = await service.listContent('article');
    const guides = await service.listContent('guide');
    expect(articles.every((row) => row.contentType === 'article')).toBe(true);
    expect(guides.every((row) => row.contentType === 'guide')).toBe(true);
    expect(articles.map((row) => row.slug)).toContain('contenu-modifie');
    expect(guides.map((row) => row.slug)).toEqual(
      expect.arrayContaining(['meme-sujet', 'meme-sujet-2', 'meme-sujet-3']),
    );
  });

  it('des data corrompues en base lèvent ContentDataCorruptedError — jamais un rendu silencieux', async () => {
    // Écriture SQL directe (réservée aux tests) : data invalide pour le schéma.
    await harness.raw(
      sql`update kreiz_content_entries set data = ${JSON.stringify({ excerpt: 'seulement ça' })}::jsonb where id = ${articleId}`,
    );
    await expect(service.getContentForEdit(articleId)).rejects.toThrow(ContentDataCorruptedError);
    // Restauration pour la suite.
    await harness.raw(
      sql`update kreiz_content_entries set data = ${JSON.stringify({ excerpt: 'Accroche v2', body: 'Corps v2.' })}::jsonb where id = ${articleId}`,
    );
  });

  it('soft delete : absent du listing, slug libéré et réutilisable (index partiel)', async () => {
    // Un guide dédié, pour ne pas toucher au fil principal d'articles.
    const created = await service.createDraft({
      contentTypeKey: 'guide',
      title: 'Guide supprimable',
      data: { body: 'Corps.' },
      actorAdminId: admin.id,
    });
    if (created.kind !== 'created') throw new Error('setup : création attendue');
    const guideId = created.entry.id;

    const deleted = await service.deleteDraft({ entryId: guideId, actorAdminId: secondAdmin.id });
    expect(deleted).toEqual({
      kind: 'deleted',
      entryId: guideId,
      wasPublished: false,
      rebuild: null,
    });

    // Absent du listing actif.
    const guides = await service.listContent('guide');
    expect(guides.map((row) => row.id)).not.toContain(guideId);

    // La ligne existe toujours (soft delete, pas de purge physique).
    const rawRows = await harness.raw(
      sql`select deleted_at, slug from kreiz_content_entries where id = ${guideId}`,
    );
    expect(rawRows[0]?.deleted_at).not.toBeNull();
    expect(rawRows[0]?.slug).toBe('guide-supprimable');

    // Le slug libéré est réutilisable dans le même namespace.
    const recreated = await service.createDraft({
      contentTypeKey: 'guide',
      title: 'Guide supprimable',
      data: { body: 'Corps.' },
      actorAdminId: admin.id,
    });
    expect(recreated.kind === 'created' && recreated.entry.slug).toBe('guide-supprimable');

    // L'audit content.deleted trace le vrai acteur.
    const auditRows = await harness.raw(
      sql`select actor_admin_id, action from kreiz_admin_audit_log where entity_id = ${guideId} and action = ${CONTENT_AUDIT_ACTIONS.deleted}`,
    );
    expect(auditRows[0]?.actor_admin_id).toBe(secondAdmin.id);
  });

  it('le preview resolver rend la vue validée d’un brouillon', async () => {
    const loaded = await service.getContentForPreview(articleId);
    expect(loaded.declaration.key).toBe('article');
    expect(loaded.view.title).toBe('Contenu modifié');
    expect(loaded.view.data).toEqual({ excerpt: 'Accroche v2', body: 'Corps v2.' });
  });
});
