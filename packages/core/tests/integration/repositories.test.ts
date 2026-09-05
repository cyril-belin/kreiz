import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createAdminUsersRepository,
  createContentEntriesRepository,
  createRedirectsRepository,
  type KreizAdminUser,
  type KreizContentEntry,
} from '../../src/data';
import {
  describeIntegration,
  expectPgError,
  setupIntegration,
  withTransientNetworkRetry,
  type IntegrationHarness,
} from './helpers';

/**
 * Preuve write → read → résultat typé via l'API publique des repositories,
 * contre Neon/PostgreSQL réel. Les données sont isolées par préfixe unique et
 * nettoyées en fin de run — aucun ordre implicite entre les tests.
 */
const runId = crypto.randomUUID().slice(0, 8);
const emailPattern = `it-${runId}%@example.test`;
const namespace = `it-${runId}`;

let harness: IntegrationHarness;
let users: ReturnType<typeof createAdminUsersRepository>;
let entries: ReturnType<typeof createContentEntriesRepository>;
let redirectsRepo: ReturnType<typeof createRedirectsRepository>;
let admin: KreizAdminUser;
let entry: KreizContentEntry;

describeIntegration('repositories — écriture et lecture typées', () => {
  beforeAll(async () => {
    harness = await setupIntegration();
    users = createAdminUsersRepository(harness.db);
    entries = createContentEntriesRepository(harness.db);
    redirectsRepo = createRedirectsRepository(harness.db);
    admin = await withTransientNetworkRetry(() =>
      users.create({
        email: `it-${runId}-admin@example.test`,
        passwordHash: 'hash-test-argon2id',
        name: 'Admin intégration',
      }),
    );
    entry = await withTransientNetworkRetry(() =>
      entries.create({
        contentType: 'article',
        routeNamespace: namespace,
        title: 'Contenu d’intégration',
        slug: 'contenu-integration',
        createdBy: admin.id,
        updatedBy: admin.id,
      }),
    );
  }, 60_000);

  afterAll(async () => {
    if (!harness) return;
    await harness.raw(sql`delete from kreiz_redirects where from_path like ${`/it-${runId}/%`}`);
    await harness.raw(sql`delete from kreiz_content_entries where route_namespace like ${`${namespace}%`}`);
    await harness.raw(sql`delete from kreiz_admin_users where email like ${emailPattern}`);
    await harness.close();
  }, 60_000);

  it('adminUsers.create retourne une ligne typée et complète', () => {
    expect(admin.email).toBe(`it-${runId}-admin@example.test`);
    expect(admin.passwordHash).toBe('hash-test-argon2id');
    expect(admin.name).toBe('Admin intégration');
    expect(admin.id).toBeTruthy();
    expect(admin.disabledAt).toBeNull();
    expect(admin.createdAt).toBeInstanceOf(Date);
    expect(admin.updatedAt).toBeInstanceOf(Date);
  });

  it('adminUsers.findByEmail retrouve l’admin — et null sinon', async () => {
    const found = await users.findByEmail(`it-${runId}-admin@example.test`);
    expect(found?.id).toBe(admin.id);

    const unknown = await users.findByEmail(`it-${runId}-inconnu@example.test`);
    expect(unknown).toBeNull();
  });

  it('adminUsers.findById retrouve par identifiant', async () => {
    const found = await users.findById(admin.id);
    expect(found?.email).toBe(`it-${runId}-admin@example.test`);
  });

  it('contentEntries.create applique les valeurs par défaut du schéma (draft, jsonb vides)', () => {
    expect(entry.status).toBe('draft');
    expect(entry.publishedAt).toBeNull();
    expect(entry.deletedAt).toBeNull();
    expect(entry.seo).toEqual({});
    expect(entry.data).toEqual({});
    expect(entry.coverMediaId).toBeNull();
  });

  it('contentEntries.findById et findActiveByNamespaceAndSlug relisent la même ligne', async () => {
    const byId = await entries.findById(entry.id);
    expect(byId?.title).toBe('Contenu d’intégration');

    const bySlug = await entries.findActiveByNamespaceAndSlug(namespace, 'contenu-integration');
    expect(bySlug?.id).toBe(entry.id);
  });

  it('la contrainte d’unicité (namespace, slug) remonte via le repository', async () => {
    await expectPgError(
      () =>
        entries.create({
          contentType: 'article',
          routeNamespace: namespace,
          title: 'Doublon',
          slug: 'contenu-integration',
          createdBy: admin.id,
          updatedBy: admin.id,
        }),
      '23505',
    );
  });

  it('findActiveByNamespaceAndSlug ignore les contenus soft-deleted', async () => {
    const ghost = await entries.create({
      contentType: 'article',
      routeNamespace: namespace,
      title: 'Supprimé',
      slug: 'supprime',
      createdBy: admin.id,
      updatedBy: admin.id,
    });
    await entries.findById(ghost.id); // lecture OK avant suppression
    await harness.raw(sql`update kreiz_content_entries set deleted_at = now() where id = ${ghost.id}`);

    const stillReadable = await entries.findById(ghost.id);
    expect(stillReadable?.id).toBe(ghost.id); // la ligne existe toujours (soft delete)

    const notActive = await entries.findActiveByNamespaceAndSlug(namespace, 'supprime');
    expect(notActive).toBeNull();
  });

  it('redirects.create + findByFromPath : write → read typé, avec ou sans contenu d’origine', async () => {
    const withOrigin = await redirectsRepo.create({
      fromPath: `/it-${runId}/ancien`,
      toPath: `/${namespace}/contenu-integration`,
      contentEntryId: entry.id,
    });
    expect(withOrigin.fromPath).toBe(`/it-${runId}/ancien`);
    expect(withOrigin.contentEntryId).toBe(entry.id);
    expect(withOrigin.createdAt).toBeInstanceOf(Date);

    const withoutOrigin = await redirectsRepo.create({
      fromPath: `/it-${runId}/autre`,
      toPath: `/`,
    });
    expect(withoutOrigin.contentEntryId).toBeNull();

    const found = await redirectsRepo.findByFromPath(`/it-${runId}/ancien`);
    expect(found?.toPath).toBe(`/${namespace}/contenu-integration`);

    const unknown = await redirectsRepo.findByFromPath(`/it-${runId}/jamais-cree`);
    expect(unknown).toBeNull();
  });
});
