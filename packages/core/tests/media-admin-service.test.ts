import { beforeEach, describe, expect, it } from 'vitest';
import { createMediaAdminService } from '../src/services/media-admin';
import { createMediaRecoveryService } from '../src/services/media-recovery';
import {
  createInMemoryAudit,
  createInMemoryMediaRepository,
  createInMemoryStorage,
  createQueuedJobs,
  stubMediaRow,
  type InMemoryMediaState,
} from './helpers/in-memory-media';
import { stubContentEntry } from './helpers/in-memory-content';
import { MediaInUseError, MediaStateError } from '../src/domain/media/errors';

/**
 * Service admin média (mission §16, §22, §26, §46) + récupération (§20).
 */

describe('updateAlt — alt saisi par l’admin (mission §16)', () => {
  let mediaState: InMemoryMediaState;
  let service: ReturnType<typeof createMediaAdminService>;

  beforeEach(() => {
    mediaState = { media: new Map(), auditRows: [], entries: new Map() };
    service = createMediaAdminService({
      media: createInMemoryMediaRepository(mediaState),
      audit: createInMemoryAudit(mediaState),
      storage: createInMemoryStorage(),
    });
  });

  it('enregistre l’alt (trim) et audite avec le vrai acteur', async () => {
    const id = crypto.randomUUID();
    mediaState.media.set(id, stubMediaRow({ id, status: 'ready', altText: '' }));

    await service.updateAlt({ mediaId: id, altText: '  Vue du port de Brest  ', actorAdminId: 'admin-1' });

    expect(mediaState.media.get(id)?.altText).toBe('Vue du port de Brest');
    expect(mediaState.auditRows.at(-1)).toMatchObject({
      actorAdminId: 'admin-1',
      action: 'media.alt_updated',
    });
  });

  it('alt vide autorisé (image décorative) — jamais d’alt généré', async () => {
    const id = crypto.randomUUID();
    mediaState.media.set(id, stubMediaRow({ id, status: 'ready', altText: 'ancien' }));
    await service.updateAlt({ mediaId: id, altText: '', actorAdminId: 'admin-1' });
    expect(mediaState.media.get(id)?.altText).toBe('');
  });
});

describe('retryMedia — un média failed repasse processing (mission §22)', () => {
  let mediaState: InMemoryMediaState;
  let storage: ReturnType<typeof createInMemoryStorage>;
  let jobs: ReturnType<typeof createQueuedJobs>;
  let service: ReturnType<typeof createMediaAdminService>;

  beforeEach(() => {
    mediaState = { media: new Map(), auditRows: [], entries: new Map() };
    storage = createInMemoryStorage();
    jobs = createQueuedJobs();
    service = createMediaAdminService({
      media: createInMemoryMediaRepository(mediaState),
      audit: createInMemoryAudit(mediaState),
      storage,
    });
  });

  it('failed → processing, transformation enfilée, audit media.retried (acteur admin)', async () => {
    const id = crypto.randomUUID();
    mediaState.media.set(id, stubMediaRow({ id, status: 'failed', failureReason: 'transform-failed' }));

    const row = await service.retryMedia({ mediaId: id, actorAdminId: 'admin-1' }, { jobs });

    expect(row.status).toBe('processing');
    expect(row.failureReason).toBeNull();
    expect(jobs.queued).toEqual([id]);
    expect(mediaState.auditRows.at(-1)).toMatchObject({
      actorAdminId: 'admin-1',
      action: 'media.retried',
      metadata: { source: 'admin' },
    });
  });

  it('retry d’un média ready est refusé par la machine à états', async () => {
    const id = crypto.randomUUID();
    mediaState.media.set(id, stubMediaRow({ id, status: 'ready' }));
    await expect(service.retryMedia({ mediaId: id, actorAdminId: 'admin-1' }, { jobs })).rejects.toThrow(
      MediaStateError,
    );
    expect(jobs.queued).toEqual([]);
  });
});

describe('deleteMedia — protection des médias utilisés (mission §26/§46)', () => {
  let mediaState: InMemoryMediaState;
  let storage: ReturnType<typeof createInMemoryStorage>;
  let service: ReturnType<typeof createMediaAdminService>;

  beforeEach(() => {
    mediaState = { media: new Map(), auditRows: [], entries: new Map() };
    storage = createInMemoryStorage();
    service = createMediaAdminService({
      media: createInMemoryMediaRepository(mediaState),
      audit: createInMemoryAudit(mediaState),
      storage,
    });
  });

  it('média non référencé → suppression physique + objets storage (original + variantes) + audit', async () => {
    const id = crypto.randomUUID();
    const row = stubMediaRow({ id, status: 'ready' });
    mediaState.media.set(id, row);
    for (const variant of row.variants) {
      storage.state.objects.set(variant.key, { body: new Uint8Array([1]), contentType: 'image/webp', cacheControl: null });
    }
    storage.state.objects.set(row.storageKey, { body: new Uint8Array([1]), contentType: 'image/png', cacheControl: null });

    const result = await service.deleteMedia({ mediaId: id, actorAdminId: 'admin-1' });

    expect(result.deleted).toBe(true);
    expect(mediaState.media.has(id)).toBe(false);
    expect(storage.state.objects.size).toBe(0);
    expect(mediaState.auditRows.at(-1)).toMatchObject({ actorAdminId: 'admin-1', action: 'media.deleted' });
  });

  it('média utilisé comme couverture → refus explicite, rien n’est supprimé', async () => {
    const id = crypto.randomUUID();
    const row = stubMediaRow({ id, status: 'ready' });
    mediaState.media.set(id, row);
    const entry = stubContentEntry({ coverMediaId: id });
    mediaState.entries.set(entry.id, entry);

    await expect(service.deleteMedia({ mediaId: id, actorAdminId: 'admin-1' })).rejects.toThrow(
      MediaInUseError,
    );
    expect(mediaState.media.has(id)).toBe(true);
    expect(mediaState.auditRows).toHaveLength(0);
  });

  it('un contenu soft-deleted qui référence le média bloque toujours la suppression (mission §46)', async () => {
    const id = crypto.randomUUID();
    mediaState.media.set(id, stubMediaRow({ id, status: 'ready' }));
    const entry = stubContentEntry({ coverMediaId: id, deletedAt: new Date() });
    mediaState.entries.set(entry.id, entry);

    await expect(service.deleteMedia({ mediaId: id, actorAdminId: 'admin-1' })).rejects.toThrow(
      MediaInUseError,
    );
    expect(mediaState.media.has(id)).toBe(true);
  });

  it('la couverture publiée (snapshot) bloque aussi la suppression', async () => {
    const id = crypto.randomUUID();
    mediaState.media.set(id, stubMediaRow({ id, status: 'ready' }));
    const entry = stubContentEntry({ publishedCoverMediaId: id, status: 'published' });
    mediaState.entries.set(entry.id, entry);
    await expect(service.deleteMedia({ mediaId: id, actorAdminId: 'admin-1' })).rejects.toThrow(
      MediaInUseError,
    );
  });
});

describe('récupération — retryFailedMedia / processStuckMedia (mission §20)', () => {
  let mediaState: InMemoryMediaState;
  let jobs: ReturnType<typeof createQueuedJobs>;
  let recovery: ReturnType<typeof createMediaRecoveryService>;

  beforeEach(() => {
    mediaState = { media: new Map(), auditRows: [], entries: new Map() };
    jobs = createQueuedJobs();
    recovery = createMediaRecoveryService({
      media: createInMemoryMediaRepository(mediaState),
      audit: createInMemoryAudit(mediaState),
      jobs,
    });
  });

  it('reprend les failed : processing + enqueue + audit acteur NULL source recovery', async () => {
    const id = crypto.randomUUID();
    mediaState.media.set(id, stubMediaRow({ id, status: 'failed', failureReason: 'transform-failed' }));

    const result = await recovery.retryFailedMedia();

    expect(result.recovered).toBe(1);
    expect(jobs.queued).toEqual([id]);
    expect(mediaState.media.get(id)?.status).toBe('processing');
    expect(mediaState.auditRows.at(-1)).toMatchObject({
      actorAdminId: null,
      action: 'media.retried',
      metadata: { source: 'recovery' },
    });
  });

  it('ré-enfile les processing bloqués (job perdu) sans transition d’état', async () => {
    const id = crypto.randomUUID();
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
    mediaState.media.set(id, stubMediaRow({ id, status: 'processing', updatedAt: stale }));

    const result = await recovery.processStuckMedia({ olderThanMs: 60 * 60 * 1000 });

    expect(result.recovered).toBe(1);
    expect(jobs.queued).toEqual([id]);
    expect(mediaState.media.get(id)?.status).toBe('processing');
    expect(mediaState.auditRows.at(-1)).toMatchObject({
      actorAdminId: null,
      metadata: { source: 'recovery', reason: 'stuck' },
    });
  });

  it('un processing récent n’est pas touché (seuil par défaut 1 h)', async () => {
    const id = crypto.randomUUID();
    mediaState.media.set(id, stubMediaRow({ id, status: 'processing' }));
    const result = await recovery.processStuckMedia({});
    expect(result.recovered).toBe(0);
    expect(jobs.queued).toEqual([]);
  });
});

describe('garde d’entrée du repository — id non UUID', () => {
  it('un id non UUID résout « introuvable » au lieu d’une erreur SQL brute', async () => {
    const mediaState: InMemoryMediaState = { media: new Map(), auditRows: [], entries: new Map() };
    // Le double en mémoire tolère tout id ; on vérifie le contrat via le
    // repository réel dans l'intégration — ici on prouve la surface service.
    const service = createMediaAdminService({
      media: createInMemoryMediaRepository(mediaState),
      audit: createInMemoryAudit(mediaState),
      storage: createInMemoryStorage(),
    });
    await expect(service.statusOf('pas-un-uuid')).resolves.toBeNull();
  });
});
