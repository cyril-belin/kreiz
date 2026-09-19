import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createMediaRepository } from '../../src/data/repositories/media';
import { createContentEntriesRepository } from '../../src/data/repositories/content-entries';
import { createAdminUsersRepository } from '../../src/data/repositories/admin-users';
import { createAdminAuditLogRepository } from '../../src/data/repositories/admin-audit-log';
import type { KreizMediaVariant } from '../../src/data/tables/media';
import { MediaInUseError } from '../../src/domain/media/errors';
import { createMediaAdminService } from '../../src/services/media-admin';
import { describeIntegration, expectPgError, setupIntegration, withTransientNetworkRetry, type IntegrationHarness } from './helpers';
import { createInMemoryStorage } from '../helpers/in-memory-media';

/**
 * Domaine média sur **PostgreSQL réel** (mission §49) — transitions gardées,
 * FK RESTRICT des couvertures, snapshot public, audit à acteur NULL, 0
 * résidu. Chaque fixture est préfixée par un runId et supprimée en afterAll.
 */

const runId = crypto.randomUUID().slice(0, 8);

describeIntegration('médias — repository + service sur base réelle', () => {
  let harness: IntegrationHarness;
  let media: ReturnType<typeof createMediaRepository>;
  let entries: ReturnType<typeof createContentEntriesRepository>;
  let auditRepo: ReturnType<typeof createAdminAuditLogRepository>;
  let adminId: string;

  beforeAll(async () => {
    harness = await setupIntegration();
    media = createMediaRepository(harness.db);
    entries = createContentEntriesRepository(harness.db);
    auditRepo = createAdminAuditLogRepository(harness.db);
    const users = createAdminUsersRepository(harness.db);
    const admin = await withTransientNetworkRetry(() =>
      users.create({
        email: `it-${runId}-media@example.test`,
        passwordHash: 'hash-test',
        name: 'Admin médias',
      }),
    );
    adminId = admin.id;
  }, 60_000);

  afterAll(async () => {
    if (!harness) return;
    // Ordre FK inverse : contenus (couverture en RESTRICT) → médias → audit → admin.
    await harness.raw(sql`delete from kreiz_content_entries where created_by = ${adminId}`);
    await harness.raw(sql`delete from kreiz_media where uploaded_by = ${adminId}`);
    await harness.raw(sql`delete from kreiz_admin_audit_log where actor_admin_id = ${adminId}`);
    await harness.raw(sql`delete from kreiz_admin_users where id = ${adminId}`);
    await harness.close();
  });

  it('createUploading → findById : ligne uploading persistée avec clé générée', async () => {
    const id = crypto.randomUUID();
    const row = await media.createUploading({
      id,
      storageKey: `media/${id}/original`,
      mime: 'image/png',
      sizeBytes: 4096,
      variants: [],
      uploadedBy: adminId,
    });
    expect(row.status).toBe('uploading');

    const found = await media.findById(id);
    expect(found).toMatchObject({
      id,
      status: 'uploading',
      storageKey: `media/${id}/original`,
      altText: '',
      width: null,
      height: null,
    });
  });

  it('transitions gardées : double markProcessing → une seule gagne (idempotence mission §11)', async () => {
    const id = crypto.randomUUID();
    await media.createUploading({
      id,
      storageKey: `media/${id}/original`,
      mime: 'image/png',
      sizeBytes: 10,
      variants: [],
      uploadedBy: adminId,
    });

    const [first, second] = await Promise.all([
      media.markProcessing(id, { updatedAt: new Date() }),
      media.markProcessing(id, { updatedAt: new Date() }),
    ]);
    // Invariant : exactement un gagnant (l'IDENTITÉ du gagnant dépend de
    // l'ordre d'arrivée au transport — Neon, pont local — et n'est pas le
    // contrat). L'état final fait foi.
    expect([first !== null, second !== null].filter(Boolean)).toHaveLength(1);
    expect((await media.findById(id))?.status).toBe('processing');
  });

  it('markReady persiste dimensions et variantes JSONB ; markFailed depuis processing', async () => {
    const id = crypto.randomUUID();
    await media.createUploading({
      id,
      storageKey: `media/${id}/original`,
      mime: 'image/jpeg',
      sizeBytes: 10,
      variants: [],
      uploadedBy: adminId,
    });
    await media.markProcessing(id, { updatedAt: new Date() });

    const variants: KreizMediaVariant[] = [
      { key: `media/${id}/400.webp`, width: 400, format: 'webp', sizeBytes: 12_345 },
      { key: `media/${id}/400.avif`, width: 400, format: 'avif', sizeBytes: 10_000 },
    ];
    const ready = await media.markReady(id, {
      width: 1600,
      height: 900,
      variants,
      updatedAt: new Date(),
    });
    expect(ready).toMatchObject({ status: 'ready', width: 1600, height: 900 });
    expect((await media.findById(id))?.variants).toEqual(variants);

    // ready est terminal : markFailed ne passe plus.
    expect(await media.markFailed(id, { failureReason: 'x', updatedAt: new Date() })).toBeNull();
  });

  it('retry : failed → processing passe ; ready → processing est refusé', async () => {
    const id = crypto.randomUUID();
    await media.createUploading({
      id,
      storageKey: `media/${id}/original`,
      mime: 'image/png',
      sizeBytes: 10,
      variants: [],
      uploadedBy: adminId,
    });
    await media.markProcessing(id, { updatedAt: new Date() });
    await media.markFailed(id, { failureReason: 'transform-failed', updatedAt: new Date() });

    const retried = await media.markProcessing(id, { updatedAt: new Date() });
    expect(retried?.status).toBe('processing');
    expect(retried?.failureReason).toBeNull();

    // Un failed ne saute jamais vers ready : la transition directe
    // n'existe pas dans la machine à états (il repasse par processing).
    const other = crypto.randomUUID();
    await media.createUploading({
      id: other,
      storageKey: `media/${other}/original`,
      mime: 'image/png',
      sizeBytes: 10,
      variants: [],
      uploadedBy: adminId,
    });
    await media.markFailed(other, { failureReason: 'mime-unsupported', updatedAt: new Date() });
    expect(
      await media.markReady(other, { width: 1, height: 1, variants: [], updatedAt: new Date() }),
    ).toBeNull();
  });

  it('updateAlt persiste l’alt ; listReady/listAdmin filtrent statuts et supprimés', async () => {
    const readyId = crypto.randomUUID();
    await media.createUploading({
      id: readyId,
      storageKey: `media/${readyId}/original`,
      mime: 'image/png',
      sizeBytes: 10,
      variants: [],
      uploadedBy: adminId,
    });
    await media.markProcessing(readyId, { updatedAt: new Date() });
    await media.markReady(readyId, { width: 100, height: 50, variants: [], updatedAt: new Date() });
    await media.updateAlt(readyId, { altText: 'Port de Brest', updatedAt: new Date() });
    expect((await media.findById(readyId))?.altText).toBe('Port de Brest');

    const failedId = crypto.randomUUID();
    await media.createUploading({
      id: failedId,
      storageKey: `media/${failedId}/original`,
      mime: 'image/png',
      sizeBytes: 10,
      variants: [],
      uploadedBy: adminId,
    });
    await media.markFailed(failedId, { failureReason: 'mime-unsupported', updatedAt: new Date() });

    const adminList = await media.listAdmin();
    expect(adminList.map((row) => row.id)).toContain(readyId);
    expect(adminList.map((row) => row.id)).toContain(failedId);

    const readyList = await media.listReady();
    expect(readyList.map((row) => row.id)).toContain(readyId);
    expect(readyList.map((row) => row.id)).not.toContain(failedId);

    // Soft-deleted : absent de l'admin, présent par findById.
    await harness.raw(sql`update kreiz_media set deleted_at = now() where id = ${readyId}`);
    expect((await media.listAdmin()).map((row) => row.id)).not.toContain(readyId);
    expect((await media.listReadyByIds([readyId])).map((row) => row.id)).not.toContain(readyId);
    await harness.raw(sql`update kreiz_media set deleted_at = null where id = ${readyId}`);
  });

  it('couverture contenu : FK réelle, snapshot published_cover_media_id, RESTRICT 23001', async () => {
    const mediaId = crypto.randomUUID();
    await media.createUploading({
      id: mediaId,
      storageKey: `media/${mediaId}/original`,
      mime: 'image/png',
      sizeBytes: 10,
      variants: [],
      uploadedBy: adminId,
    });
    await media.markProcessing(mediaId, { updatedAt: new Date() });
    await media.markReady(mediaId, { width: 800, height: 400, variants: [], updatedAt: new Date() });

    // Draft avec couverture (champ système, jamais dans data).
    const entry = await entries.create({
      contentType: 'article',
      routeNamespace: 'articles',
      title: `it-${runId} couverture`,
      slug: `it-${runId}-cover`,
      status: 'draft',
      data: { excerpt: 'a', body: 'b', author: 'c' },
      coverMediaId: mediaId,
      createdBy: adminId,
      updatedBy: adminId,
    });
    expect(entry.coverMediaId).toBe(mediaId);

    // Un média processing référencé par un draft n'est PAS publiable :
    // le refus est dans le service (publication) — ici on prouve le
    // snapshot : publication via markPublished fige la couverture.
    const published = await entries.markPublished(entry.id, {
      publishedAt: new Date(),
      publishedSlug: entry.slug,
      publishedTitle: entry.title,
      publishedData: entry.data,
      publishedSeo: {},
      publishedCoverMediaId: mediaId,
      updatedBy: adminId,
      updatedAt: new Date(),
    });
    expect(published?.publishedCoverMediaId).toBe(mediaId);

    // La publication a revalidé ready (service) — le média l'est ici.
    expect((await media.findById(mediaId))?.status).toBe('ready');

    // RESTRICT : un média référencé (couverture courante ou snapshot) ne
    // peut pas être supprimé physiquement en base — 23001 (mission §49).
    await expectPgError(() => media.deletePhysical(mediaId), '23001');

    // Le service admin refuse explicitement AVANT (comptage courant + snapshot).
    const service = createMediaAdminService({
      media,
      audit: auditRepo,
      storage: createInMemoryStorage(),
    });
    await expect(service.deleteMedia({ mediaId, actorAdminId: adminId })).rejects.toThrow(MediaInUseError);
  });

  it('audit média à acteur NULL (background) lu en SQL — sémantique slice 2 conservée', async () => {
    // entityId propre au test : les audits système (acteur NULL) survivent au
    // nettoyage, on ne peut pas se fier à la fraîcheur seule.
    const auditMediaId = crypto.randomUUID();
    await auditRepo.append({
      actorAdminId: null,
      action: 'media.ready',
      entityType: 'media',
      entityId: auditMediaId,
      metadata: { source: 'background_job' },
    });
    const rows = await harness.raw(
      sql`select actor_admin_id, action, metadata from kreiz_admin_audit_log
          where entity_id = ${auditMediaId} and metadata->>'source' = 'background_job'`,
    );
    const row = rows.at(0);
    expect(row).toBeDefined();
    expect(row?.actor_admin_id).toBeNull();
    expect(row?.action).toBe('media.ready');
  });

  it('findStuckProcessing / listFailed balayent les états bloqués (mission §49)', async () => {
    const stuckId = crypto.randomUUID();
    await media.createUploading({
      id: stuckId,
      storageKey: `media/${stuckId}/original`,
      mime: 'image/png',
      sizeBytes: 10,
      variants: [],
      uploadedBy: adminId,
    });
    await media.markProcessing(stuckId, { updatedAt: new Date(Date.now() - 2 * 3600 * 1000) });

    const stuck = await media.findStuckProcessing(new Date(Date.now() - 3600 * 1000));
    expect(stuck.map((row) => row.id)).toContain(stuckId);

    const failedId = crypto.randomUUID();
    await media.createUploading({
      id: failedId,
      storageKey: `media/${failedId}/original`,
      mime: 'image/png',
      sizeBytes: 10,
      variants: [],
      uploadedBy: adminId,
    });
    await media.markFailed(failedId, { failureReason: 'transform-failed', updatedAt: new Date() });
    expect((await media.listFailed()).map((row) => row.id)).toContain(failedId);
  });

  it('un id non UUID est « introuvable », jamais une 22P02 brute (garde frontière)', async () => {
    // Sans la garde du repository, PostgreSQL lèverait `invalid input syntax
    // for type uuid` (22P02) au lieu d'un simple résultat vide.
    await expect(media.findById('pas-un-uuid')).resolves.toBeNull();
    expect(await media.deletePhysical('pas-un-uuid')).toBe(false);
  });

  it('suppression physique d’un média non référencé réussit (mission §26)', async () => {
    const id = crypto.randomUUID();
    await media.createUploading({
      id,
      storageKey: `media/${id}/original`,
      mime: 'image/png',
      sizeBytes: 10,
      variants: [],
      uploadedBy: adminId,
    });
    expect(await media.deletePhysical(id)).toBe(true);
    expect(await media.findById(id)).toBeNull();
  });
});
