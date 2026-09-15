import { beforeEach, describe, expect, it } from 'vitest';
import { createMediaProcessingService } from '../src/services/media-processing';
import { MEDIA_VARIANT_CACHE_CONTROL } from '../src/services/media-processing';
import { MEDIA_VARIANT_WIDTHS } from '../src/domain/media/policy';
import type { ImageTransformer, TransformedImage } from '../src/ports/image-transform';
import {
  createInMemoryAudit,
  createInMemoryMediaRepository,
  createInMemoryStorage,
  stubMediaRow,
  type InMemoryMediaState,
} from './helpers/in-memory-media';

/**
 * Service processing (mission §21, §25) — transformer en mémoire piloté par
 * les tests (le transformer Sharp réel a son propre fichier de tests).
 */

function fakeTransformer(result?: Partial<TransformedImage>, fail = false): ImageTransformer & { calls: number } {
  return {
    calls: 0,
    async transform(original, variants) {
      this.calls += 1;
      if (fail) throw new Error('boom — stack interne');
      const width = 1200;
      const height = 800;
      void original;
      return {
        original: { width, height, format: 'image/png' },
        variants: variants.map((spec) => ({
          width: spec.width,
          format: spec.format,
          data: new Uint8Array([1, 2, spec.width & 0xff]),
        })),
        ...result,
      };
    },
  };
}

describe('processMedia — flux nominal et états', () => {
  let mediaState: InMemoryMediaState;
  let storage: ReturnType<typeof createInMemoryStorage>;
  let transformer: ReturnType<typeof fakeTransformer>;
  let service: ReturnType<typeof createMediaProcessingService>;

  beforeEach(() => {
    mediaState = { media: new Map(), auditRows: [], entries: new Map() };
    storage = createInMemoryStorage();
    transformer = fakeTransformer();
    service = createMediaProcessingService({
      media: createInMemoryMediaRepository(mediaState),
      audit: createInMemoryAudit(mediaState),
      storage,
      transformer,
    });
  });

  function seedProcessing(): string {
    const id = crypto.randomUUID();
    mediaState.media.set(
      id,
      stubMediaRow({ id, status: 'processing', mime: 'image/png', variants: [] }),
    );
    return id;
  }

  it('transforme, écrit les variantes (cache immuable), passe ready et audite acteur NULL', async () => {
    const id = seedProcessing();
    storage.state.objects.set(`media/${id}/original`, {
      body: new Uint8Array([9, 9, 9]),
      contentType: 'image/png',
      cacheControl: null,
    });

    const outcome = await service.processMedia({ mediaId: id, source: 'background_job' });

    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') return;
    expect(outcome.media.width).toBe(1200);
    expect(outcome.media.height).toBe(800);
    // 4 largeurs × 2 formats
    expect(outcome.media.variants).toHaveLength(MEDIA_VARIANT_WIDTHS.length * 2);
    for (const variant of outcome.media.variants) {
      const stored = storage.state.objects.get(variant.key);
      expect(stored).toBeDefined();
      expect(stored?.cacheControl).toBe(MEDIA_VARIANT_CACHE_CONTROL);
      expect(stored?.contentType).toBe(variant.format === 'avif' ? 'image/avif' : 'image/webp');
    }
    expect(mediaState.auditRows.at(-1)).toMatchObject({
      actorAdminId: null, // acteur système honnête (mission §44)
      action: 'media.ready',
      metadata: { source: 'background_job' },
    });
  });

  it('original absent → failed original-missing, audit acteur NULL', async () => {
    const id = seedProcessing();
    const outcome = await service.processMedia({ mediaId: id, source: 'background_job' });
    expect(outcome.kind).toBe('failed');
    expect(mediaState.media.get(id)).toMatchObject({ status: 'failed', failureReason: 'original-missing' });
    expect(mediaState.auditRows.at(-1)).toMatchObject({ actorAdminId: null, action: 'media.failed' });
  });

  it('échec de transformation → failed transform-failed, jamais de stack trace en DB', async () => {
    const id = seedProcessing();
    storage.state.objects.set(`media/${id}/original`, {
      body: new Uint8Array([1]),
      contentType: 'image/png',
      cacheControl: null,
    });
    const failing = createMediaProcessingService({
      media: createInMemoryMediaRepository(mediaState),
      audit: createInMemoryAudit(mediaState),
      storage,
      transformer: fakeTransformer(undefined, true),
    });
    const outcome = await failing.processMedia({ mediaId: id, source: 'background_job' });
    expect(outcome.kind).toBe('failed');
    const row = mediaState.media.get(id);
    expect(row?.failureReason).toBe('transform-failed');
    expect(JSON.stringify(row)).not.toContain('stack interne');
  });

  it('idempotent : un média déjà ready n’est jamais retransformé', async () => {
    const id = crypto.randomUUID();
    mediaState.media.set(id, stubMediaRow({ id, status: 'ready' }));
    const outcome = await service.processMedia({ mediaId: id, source: 'background_job' });
    expect(outcome.kind).toBe('already-ready');
    expect(transformer.calls).toBe(0);
  });

  it('n’entreprenant rien sur un média uploading (jamais confirmé)', async () => {
    const id = crypto.randomUUID();
    mediaState.media.set(id, stubMediaRow({ id, status: 'uploading' }));
    const outcome = await service.processMedia({ mediaId: id, source: 'background_job' });
    expect(outcome.kind).toBe('skipped');
    expect(transformer.calls).toBe(0);
  });

  it('média inconnu ou supprimé → skip silencieux (job obsolète)', async () => {
    const missing = await service.processMedia({ mediaId: crypto.randomUUID(), source: 'background_job' });
    expect(missing.kind).toBe('skipped');
    const deleted = crypto.randomUUID();
    mediaState.media.set(deleted, stubMediaRow({ id: deleted, status: 'processing', deletedAt: new Date() }));
    const outcome = await service.processMedia({ mediaId: deleted, source: 'recovery' });
    expect(outcome.kind).toBe('skipped');
  });
});
