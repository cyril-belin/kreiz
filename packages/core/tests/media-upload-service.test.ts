import { beforeEach, describe, expect, it } from 'vitest';
import { createMediaUploadService, MEDIA_FAILURE_REASONS } from '../src/services/media-upload';
import { MEDIA_MAX_UPLOAD_BYTES } from '../src/domain/media/policy';
import {
  createInMemoryAudit,
  createInMemoryMediaRepository,
  createInMemoryStorage,
  createQueuedJobs,
  stubMediaRow,
  type InMemoryMediaState,
} from './helpers/in-memory-media';

/**
 * Service upload (mission §3, §4, §10, §11) — doubles en mémoire.
 */

function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]);
}

describe('createUploadRequest — validation initiale + présignature', () => {
  it('crée la ligne uploading avec clé générée, URL présignée courte durée et audit media.created', async () => {
    const mediaState: InMemoryMediaState = { media: new Map(), auditRows: [], entries: new Map() };
    const media = createInMemoryMediaRepository(mediaState);
    const audit = createInMemoryAudit(mediaState);
    const storage = createInMemoryStorage();
    const service = createMediaUploadService({ media, audit, storage });

    const now = new Date('2026-09-15T10:00:00Z');
    const outcome = await service.createUploadRequest(
      { actorAdminId: 'admin-1', request: { mime: 'image/png', sizeBytes: 2048 } },
      { now },
    );

    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    const row = mediaState.media.get(outcome.media.id);
    expect(row?.status).toBe('uploading');
    expect(row?.storageKey).toBe(`media/${outcome.media.id}/original`);
    expect(row?.mime).toBe('image/png');
    expect(row?.sizeBytes).toBe(2048);
    expect(outcome.upload.method).toBe('PUT');
    expect(outcome.upload.headers['content-type']).toBe('image/png');
    // 10 minutes (mission §9 : 5–15 min) — l'adapter date depuis l'horloge réelle
    const remainingSeconds = (outcome.upload.expiresAt.getTime() - Date.now()) / 1000;
    expect(remainingSeconds).toBeGreaterThan(590);
    expect(remainingSeconds).toBeLessThanOrEqual(600);
    expect(mediaState.auditRows).toHaveLength(1);
    expect(mediaState.auditRows[0]).toMatchObject({
      actorAdminId: 'admin-1',
      action: 'media.created',
      entityId: outcome.media.id,
      metadata: { mime: 'image/png', sizeBytes: 2048 },
    });
  });

  it('refuse les métadonnées hors politique sans rien créer ni présigner', async () => {
    const mediaState: InMemoryMediaState = { media: new Map(), auditRows: [], entries: new Map() };
    const service = createMediaUploadService({
      media: createInMemoryMediaRepository(mediaState),
      audit: createInMemoryAudit(mediaState),
      storage: createInMemoryStorage(),
    });

    const tooBig = await service.createUploadRequest({
      actorAdminId: 'admin-1',
      request: { mime: 'image/png', sizeBytes: MEDIA_MAX_UPLOAD_BYTES + 1 },
    });
    expect(tooBig).toEqual({ kind: 'invalid', reason: 'metadata' });

    const svg = await service.createUploadRequest({
      actorAdminId: 'admin-1',
      request: { mime: 'image/svg+xml', sizeBytes: 100 },
    });
    expect(svg.kind).toBe('invalid');
    expect(mediaState.media.size).toBe(0);
    expect(mediaState.auditRows).toHaveLength(0);
  });
});

describe('confirmUpload — vérification de l’objet réel (mission §10)', () => {
  let mediaState: InMemoryMediaState;
  let storage: ReturnType<typeof createInMemoryStorage>;
  let jobs: ReturnType<typeof createQueuedJobs>;
  let service: ReturnType<typeof createMediaUploadService>;

  beforeEach(() => {
    mediaState = { media: new Map(), auditRows: [], entries: new Map() };
    storage = createInMemoryStorage();
    jobs = createQueuedJobs();
    service = createMediaUploadService({
      media: createInMemoryMediaRepository(mediaState),
      audit: createInMemoryAudit(mediaState),
      storage,
    });
  });

  async function seedUploading(): Promise<string> {
    const outcome = await service.createUploadRequest({
      actorAdminId: 'admin-1',
      request: { mime: 'image/png', sizeBytes: pngBytes().byteLength },
    });
    if (outcome.kind !== 'created') throw new Error('seed failed');
    return outcome.media.id;
  }

  it('objet réel valide → processing + mime réel stocké + transformation enfilée', async () => {
    const id = await seedUploading();
    const bytes = pngBytes();
    storage.state.objects.set(`media/${id}/original`, {
      body: bytes,
      contentType: 'image/png',
      cacheControl: null,
    });

    const outcome = await service.confirmUpload({ mediaId: id, actorAdminId: 'admin-1' }, { jobs });

    expect(outcome.kind).toBe('confirmed');
    if (outcome.kind !== 'confirmed') return;
    expect(outcome.media.status).toBe('processing');
    expect(jobs.queued).toEqual([id]);
  });

  it('objet absent → état explicite, l’uploading est conservé (retry confirm possible)', async () => {
    const id = await seedUploading();
    const outcome = await service.confirmUpload({ mediaId: id, actorAdminId: 'admin-1' }, { jobs });
    expect(outcome.kind).toBe('object-missing');
    expect(mediaState.media.get(id)?.status).toBe('uploading');
    expect(jobs.queued).toEqual([]);
  });

  it('objet trop gros → refusé, objet supprimé du storage, média failed + audit', async () => {
    const id = await seedUploading();
    const key = `media/${id}/original`;
    storage.state.objects.set(key, {
      body: new Uint8Array(MEDIA_MAX_UPLOAD_BYTES + 1),
      contentType: 'image/png',
      cacheControl: null,
    });

    const outcome = await service.confirmUpload({ mediaId: id, actorAdminId: 'admin-1' }, { jobs });

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') return;
    expect(outcome.reason).toBe(MEDIA_FAILURE_REASONS.tooLarge);
    expect(storage.state.objects.has(key)).toBe(false);
    expect(mediaState.media.get(id)).toMatchObject({ status: 'failed', failureReason: 'too-large' });
    expect(mediaState.auditRows.at(-1)).toMatchObject({
      actorAdminId: 'admin-1',
      action: 'media.failed',
      metadata: { reason: 'too-large', source: 'confirm' },
    });
  });

  it('fichier maquillé (bytes non image) → mime réel décidé, failed mime-unsupported', async () => {
    const id = await seedUploading();
    const key = `media/${id}/original`;
    const evil = new TextEncoder().encode('<script>alert(1)</script>');
    storage.state.objects.set(key, { body: evil, contentType: 'image/png', cacheControl: null });

    const outcome = await service.confirmUpload({ mediaId: id, actorAdminId: 'admin-1' }, { jobs });

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') return;
    expect(outcome.reason).toBe(MEDIA_FAILURE_REASONS.mimeUnsupported);
    expect(storage.state.objects.has(key)).toBe(false);
  });

  it('idempotence : double confirm sur processing est un succès explicite sans nouvel enqueue', async () => {
    const id = await seedUploading();
    storage.state.objects.set(`media/${id}/original`, {
      body: pngBytes(),
      contentType: 'image/png',
      cacheControl: null,
    });
    await service.confirmUpload({ mediaId: id, actorAdminId: 'admin-1' }, { jobs });

    const second = await service.confirmUpload({ mediaId: id, actorAdminId: 'admin-1' }, { jobs });
    expect(second.kind).toBe('already-processing');
    expect(jobs.queued).toEqual([id]); // pas de double transformation
  });

  it('confirm sur un média failed est refusé (passe par le retry admin)', async () => {
    const id = await seedUploading();
    mediaState.media.set(id, stubMediaRow({ id, status: 'failed', failureReason: 'too-large' }));
    const outcome = await service.confirmUpload({ mediaId: id, actorAdminId: 'admin-1' }, { jobs });
    expect(outcome.kind).toBe('failed');
    expect(jobs.queued).toEqual([]);
  });

  it('média inconnu → erreur de domaine explicite', async () => {
    await expect(
      service.confirmUpload({ mediaId: crypto.randomUUID(), actorAdminId: 'admin-1' }, { jobs }),
    ).rejects.toThrow(/média introuvable/);
  });
});
