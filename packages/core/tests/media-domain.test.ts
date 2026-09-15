import { describe, expect, it } from 'vitest';
import {
  MEDIA_ACCEPTED_MIME_TYPES,
  MEDIA_ALT_MAX_LENGTH,
  MEDIA_MAX_PIXELS,
  MEDIA_MAX_UPLOAD_BYTES,
  mediaAltInputSchema,
  parseMediaUploadRequest,
} from '../src/domain/media/policy';
import { mediaObjectKeys, mediaOriginalKey, mediaVariantKey } from '../src/domain/media/keys';
import { canTransitionMediaStatus, MEDIA_STATUS_TRANSITIONS } from '../src/domain/media/lifecycle';
import { detectImageMime } from '../src/domain/media/inspect';
import { normalizeMediaPublicBaseUrl, resolvePublicMediaView } from '../src/domain/media/view-model';
import { mediaFallbackSrc, mediaSources } from '../src/domain/media/picture';
import { MediaNotReadyError } from '../src/domain/media/errors';
import { stubMediaRow } from './helpers/in-memory-media';

/**
 * Règles pures du domaine média (mission §4, §5, §6, §11, §30, §31, §41).
 */

describe('politique média — tailles et types (mission §4/§5)', () => {
  it('la limite d’upload est 20 Mo', () => {
    expect(MEDIA_MAX_UPLOAD_BYTES).toBe(20 * 1024 * 1024);
  });

  it('l’allowlist MIME est fermée et sans SVG', () => {
    expect(MEDIA_ACCEPTED_MIME_TYPES).toEqual(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
    expect(MEDIA_ACCEPTED_MIME_TYPES.some((mime) => mime.includes('svg'))).toBe(false);
  });

  it('les métadonnées annoncées valides passent le premier filtre', () => {
    expect(parseMediaUploadRequest({ mime: 'image/png', sizeBytes: 1234 })).toEqual({
      mime: 'image/png',
      sizeBytes: 1234,
    });
  });

  it('refuse taille 0, taille > 20 Mo, MIME hors allowlist et clés inconnues', () => {
    expect(parseMediaUploadRequest({ mime: 'image/png', sizeBytes: 0 })).toBeNull();
    expect(
      parseMediaUploadRequest({ mime: 'image/png', sizeBytes: MEDIA_MAX_UPLOAD_BYTES + 1 }),
    ).toBeNull();
    expect(parseMediaUploadRequest({ mime: 'image/svg+xml', sizeBytes: 10 })).toBeNull();
    expect(parseMediaUploadRequest({ mime: 'application/pdf', sizeBytes: 10 })).toBeNull();
    expect(parseMediaUploadRequest({ mime: 'image/png', sizeBytes: 10, evil: true })).toBeNull();
  });

  it('la borne de pixels anti-bombe à la décompression est posée', () => {
    expect(MEDIA_MAX_PIXELS).toBe(30_000_000);
  });

  it('l’alt text est borné anti-abus', () => {
    expect(mediaAltInputSchema.safeParse('a'.repeat(MEDIA_ALT_MAX_LENGTH + 1)).success).toBe(false);
    expect(mediaAltInputSchema.safeParse('un alt utile').success).toBe(true);
  });
});

describe('clés de stockage générées (mission §6)', () => {
  it('dérivent de l’id média, jamais d’un nom utilisateur', () => {
    const id = crypto.randomUUID();
    expect(mediaOriginalKey(id)).toBe(`media/${id}/original`);
    expect(mediaVariantKey(id, 400, 'webp')).toBe(`media/${id}/400.webp`);
    expect(mediaVariantKey(id, 1400, 'image/avif')).toBe(`media/${id}/1400.avif`);
  });

  it('refusent traversal, collisions par caractères spéciaux et espaces', () => {
    expect(() => mediaOriginalKey('../escape')).toThrow(/clé de stockage invalide/);
    expect(() => mediaVariantKey('x', 400, 'web p')).toThrow(/clé de stockage invalide/);
    expect(() => mediaVariantKey('x', 400, '../evil')).toThrow(/clé de stockage invalide/);
  });

  it('la liste d’objets d’un média couvre original + variantes', () => {
    const keys = mediaObjectKeys('id-1', ['media/id-1/400.webp']);
    expect(keys).toEqual(['media/id-1/original', 'media/id-1/400.webp']);
  });
});

describe('machine à états (mission §2/§11/§22)', () => {
  it('transitions valides : uploading→processing, uploading→failed, processing→ready, processing→failed, failed→processing', () => {
    expect(canTransitionMediaStatus('uploading', 'processing')).toBe(true);
    expect(canTransitionMediaStatus('uploading', 'failed')).toBe(true);
    expect(canTransitionMediaStatus('processing', 'ready')).toBe(true);
    expect(canTransitionMediaStatus('processing', 'failed')).toBe(true);
    expect(canTransitionMediaStatus('failed', 'processing')).toBe(true);
  });

  it('ready est terminal — aucun retour arrière', () => {
    expect(MEDIA_STATUS_TRANSITIONS.ready).toEqual([]);
    expect(canTransitionMediaStatus('ready', 'failed')).toBe(false);
    expect(canTransitionMediaStatus('ready', 'processing')).toBe(false);
  });

  it('interdit les raccourcis (uploading→ready, failed→ready)', () => {
    expect(canTransitionMediaStatus('uploading', 'ready')).toBe(false);
    expect(canTransitionMediaStatus('failed', 'ready')).toBe(false);
  });
});

describe('détection du type réel par magic bytes (mission §5/§10)', () => {
  it('reconnaît JPEG, PNG, WebP et AVIF', () => {
    expect(detectImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/jpeg');
    expect(
      detectImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])),
    ).toBe('image/png');
    const webp = new Uint8Array(12);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(detectImageMime(webp)).toBe('image/webp');
    const avif = new Uint8Array(12);
    avif.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
    expect(detectImageMime(avif)).toBe('image/avif');
  });

  it('rejette un fichier texte maquillé, un HEIC et un buffer trop court', () => {
    const text = new TextEncoder().encode('not an image at all!');
    expect(detectImageMime(text)).toBeNull();
    const heic = new Uint8Array(12);
    heic.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
    expect(detectImageMime(heic)).toBeNull();
    expect(detectImageMime(new Uint8Array(8))).toBeNull();
  });
});

describe('vue publique média (mission §30/§39/§42)', () => {
  it('résout variantes triées, URLs publiques et dimensions dérivées', () => {
    const media = stubMediaRow({
      width: 800,
      height: 400,
      variants: [
        { key: 'media/x/800.webp', width: 800, format: 'webp', sizeBytes: 1 },
        { key: 'media/x/400.webp', width: 400, format: 'webp', sizeBytes: 1 },
        { key: 'media/x/400.avif', width: 400, format: 'avif', sizeBytes: 1 },
      ],
    });
    const view = resolvePublicMediaView(media, { publicBaseUrl: 'https://cdn.example.test/bucket/' });
    expect(view.variants.map((variant) => variant.width)).toEqual([400, 400, 800]);
    // largeur égale → tri alphabétique du format (avif avant webp)
    expect(view.variants[0]?.url).toBe('https://cdn.example.test/bucket/media/x/400.avif');
    expect(view.variants[1]?.url).toBe('https://cdn.example.test/bucket/media/x/400.webp');
    expect(view.variants[0]?.height).toBe(200); // ratio conservé
    expect(view.width).toBe(800);
    expect(view.height).toBe(400);
    expect(view.alt).toBe('');
  });

  it('refuse un média non ready — le public ne voit jamais autre chose que ready', () => {
    for (const status of ['uploading', 'processing', 'failed'] as const) {
      expect(() =>
        resolvePublicMediaView(stubMediaRow({ status }), { publicBaseUrl: 'https://cdn.test/b' }),
      ).toThrow(MediaNotReadyError);
    }
  });

  it('la base publique est normalisée (slash final retiré, vide = erreur explicite)', () => {
    expect(normalizeMediaPublicBaseUrl('https://cdn.test/b///')).toBe('https://cdn.test/b');
    expect(() => normalizeMediaPublicBaseUrl('  ')).toThrow(/PUBLIC_BASE_URL/);
  });
});

describe('helpers <picture> (mission §31)', () => {
  const view = resolvePublicMediaView(
    stubMediaRow({
      width: 2000,
      height: 1000,
      variants: [
        { key: 'm/400.webp', width: 400, format: 'webp', sizeBytes: 1 },
        { key: 'm/800.webp', width: 800, format: 'webp', sizeBytes: 1 },
        { key: 'm/400.avif', width: 400, format: 'avif', sizeBytes: 1 },
      ],
    }),
    { publicBaseUrl: 'https://cdn.test/b' },
  );

  it('produit une source AVIF puis WebP avec srcset croissant', () => {
    const sources = mediaSources(view);
    expect(sources.map((source) => source.type)).toEqual(['image/avif', 'image/webp']);
    expect(sources[1]?.srcset).toBe(
      'https://cdn.test/b/m/400.webp 400w, https://cdn.test/b/m/800.webp 800w',
    );
  });

  it('le fallback <img> est la plus grande variante WebP — jamais l’original', () => {
    expect(mediaFallbackSrc(view)).toBe('https://cdn.test/b/m/800.webp');
  });
});
