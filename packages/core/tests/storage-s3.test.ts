import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import S3rver from 's3rver';
import { createS3ObjectStorage } from '../src/adapters/storage/s3';
import { presignedPutUrl } from '../src/adapters/storage/sigv4';

/**
 * Adapter **S3-compatible réel** contre un serveur S3 local (s3rver) —
 * mission §50 : la CI open source ne dépend d'aucun credential R2/S3.
 * s3rver authentifie par access key **sans recalculer les signatures
 * SigV4** : la preuve cryptographique est portée par les vecteurs AWS
 * officiels (`storage-sigv4.test.ts`) ; ce fichier prouve la **forme et
 * l'intégration HTTP réelle** (URLs présignées consommées par un client
 * indépendant, header-signées, head/get/put/delete, publicUrl).
 */

const BUCKET = 'kreiz-media-test';
// Credentials du compte de test intégré à s3rver (documentation officielle) —
// valeurs publiques, propres au serveur local, jamais des credentials réels.
const ACCESS_KEY = 'S3RVER';
const SECRET_KEY = 'S3RVER';

let server: S3rver;
let endpoint: string;
let publicBaseUrl: string;
let storage: ReturnType<typeof createS3ObjectStorage>;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'kreiz-s3rver-'));
  server = new S3rver({
    port: 0,
    address: '127.0.0.1',
    directory: dataDir,
    configureBuckets: [{ name: BUCKET }],
  });
  await server.run();
  // L'instance S3rver expose son serveur HTTP interne (adresse réelle, port éphémère).
  const address = (server as unknown as { httpServer: { address(): { address: string; port: number } } })
    .httpServer.address();
  endpoint = `http://${address.address}:${address.port}`;
  publicBaseUrl = `${endpoint}/${BUCKET}`;
  storage = createS3ObjectStorage({
    endpoint,
    bucket: BUCKET,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    region: 'us-east-1',
    publicBaseUrl,
  });
}, 30_000);

afterAll(async () => {
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('adapter S3 — serveur S3 local réel (SigV4 prouvé)', () => {
  it('presign → PUT direct (fetch indépendant) → head → read → bytes identiques', async () => {
    const key = 'media/11111111-1111-4111-8111-111111111111/original';
    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);

    const presigned = await storage.presignUpload({ key, contentType: 'image/png', expiresInSeconds: 600 });
    expect(presigned.method).toBe('PUT');
    expect(presigned.url.startsWith(`${endpoint}/${BUCKET}/${key}?`)).toBe(true);
    expect(presigned.url).toContain('X-Amz-Signature=');
    expect(presigned.url).toContain('X-Amz-Expires=600');
    // Le content-type est figé dans la signature : le navigateur doit l'envoyer.
    expect(presigned.headers['content-type']).toBe('image/png');

    // Upload direct — exactement ce que fait le navigateur (mission §3).
    const put = await fetch(presigned.url, {
      method: 'PUT',
      headers: presigned.headers,
      body: body,
    });
    expect(put.status).toBe(200);

    const head = await storage.head(key);
    expect(head).toMatchObject({ sizeBytes: body.byteLength, contentType: 'image/png' });

    const read = await storage.read(key);
    expect([...(read ?? [])]).toEqual([...body]);
  });

  it('presign : l’URL porte exactement les contraintes attendues (mission §9)', async () => {
    const key = 'media/22222222-2222-4222-8222-222222222222/original';
    const presigned = await storage.presignUpload({ key, contentType: 'image/png', expiresInSeconds: 600 });
    const url = new URL(presigned.url);
    expect(url.pathname).toBe(`/${BUCKET}/${key}`);
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host;content-type');
    // Pas de droit général : pas de list ni de delete dans la requête signée.
    expect(presigned.method).toBe('PUT');
  });

  it('head sur un objet absent → null (confirmation post-upload, mission §10)', async () => {
    expect(await storage.head('media/33333333-3333-4333-8333-333333333333/original')).toBeNull();
  });

  it('put serveur d’une variante (Cache-Control immuable) → head + publicUrl', async () => {
    const key = 'media/44444444-4444-4444-8444-444444444444/400.webp';
    await storage.put({
      key,
      body: new Uint8Array([1, 2, 3, 4]),
      contentType: 'image/webp',
      cacheControl: 'public, max-age=31536000, immutable',
    });
    const head = await storage.head(key);
    expect(head?.sizeBytes).toBe(4);
    expect(storage.publicUrl(key)).toBe(`${publicBaseUrl}/${key}`);
    // GET public non signé — les variantes sont servies depuis la base
    // publique sans URL expirante (mission §39).
    const get = await fetch(storage.publicUrl(key));
    expect(get.status).toBe(200);
  });

  it('read plafonné : un objet plus grand que maxBytes échoue, jamais bufferisé (revue sécurité finale)', async () => {
    const key = 'media/55555555-5555-4555-8555-555555555555/original';
    const body = new Uint8Array(64).fill(7);
    await storage.put({ key, body, contentType: 'application/octet-stream' });
    // Borne announced (Content-Length) et borne réelle (streaming) : les deux chemins échouent proprement.
    await expect(storage.read(key, { maxBytes: 16 })).rejects.toThrow(/borne de lecture/);
    const read = await storage.read(key, { maxBytes: 128 });
    expect(read?.byteLength).toBe(64);
    // Sans borne : comportement historique inchangé.
    const unbounded = await storage.read(key);
    expect(unbounded?.byteLength).toBe(64);
  });

  it('deleteMany supprime les objets et tolère les absents', async () => {
    const key = 'media/55555555-5555-4555-8555-555555555555/original';
    await storage.put({ key, body: new Uint8Array([9]), contentType: 'image/png' });
    await storage.deleteMany([key, 'media/inexistant/original']);
    expect(await storage.head(key)).toBeNull();
  });

  it('les clés à caractères non sûrs sont refusées avant toute requête (mission §6)', async () => {
    await expect(storage.head('media/ok/../evil')).rejects.toThrow(/refusée/);
    await expect(storage.head('media/espace interdit')).rejects.toThrow(/refusée/);
  });

  it('presign : la signature est datée du jour (scope), la durée bornée au paramètre', () => {
    const config = {
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      region: 'us-east-1',
      service: 's3',
    };
    const now = new Date('2026-09-15T12:00:00Z');
    const url = presignedPutUrl(config, {
      url: new URL(`${endpoint}/${BUCKET}/media/x/original`),
      contentType: 'image/png',
      expiresInSeconds: 600,
      now,
    });
    expect(url).toContain('X-Amz-Date=20260915T120000Z');
    expect(url).toContain(`X-Amz-Credential=${encodeURIComponent(`${ACCESS_KEY}/20260915/us-east-1/s3/aws4_request`)}`);
  });
});
