import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import S3rver from 's3rver';

/**
 * Serveur S3 **local contrôlé** pour l'E2E (mission §52 — « direct upload
 * fake storage » ; §50 — aucun credential réel) : s3rver tourne dans le
 * processus Playwright (démarré par le global-setup, arrêté par le
 * global-teardown, comme le serveur de hook) et le navigateur y exécute
 * l'upload présigné **pour de vrai** — la chaîne navigateur → PUT SigV4 →
 * stockage est réellement exercée.
 *
 * Port **fixe** (même mécanique que `HOOK_URL`) : le serveur dev Astro
 * reçoit le bloc `KREIZ_STORAGE_*` constant dès son démarrage, sans
 * coordonner l'ordre config/global-setup. Les credentials sont les
 * credentials de test intégrés à s3rver (publics, non secrets, sans pouvoir
 * hors localhost — rien à masquer en CI).
 */

export const E2E_BUCKET = 'kreiz-e2e-media';
export const E2E_ACCESS_KEY = 'S3RVER';
export const E2E_SECRET_KEY = 'S3RVER';
export const STORAGE_PORT = 43_991;
export const STORAGE_ENDPOINT = `http://127.0.0.1:${STORAGE_PORT}`;
export const STORAGE_PUBLIC_BASE_URL = `${STORAGE_ENDPOINT}/${E2E_BUCKET}`;
/** Bloc env complet reçu par le serveur dev (config Playwright). */
export const STORAGE_ENV = {
  KREIZ_STORAGE_ENDPOINT: STORAGE_ENDPOINT,
  KREIZ_STORAGE_BUCKET: E2E_BUCKET,
  KREIZ_STORAGE_ACCESS_KEY_ID: E2E_ACCESS_KEY,
  KREIZ_STORAGE_SECRET_ACCESS_KEY: E2E_SECRET_KEY,
  KREIZ_STORAGE_PUBLIC_BASE_URL: STORAGE_PUBLIC_BASE_URL,
};

/**
 * CORS du bucket (mission §38) — l'upload direct part du domaine admin vers
 * le stockage : le bucket doit autoriser les PUT avec les en-têtes exigés.
 * `image/png` n'est pas un content-type safelisted → requête préliminaire
 * OPTIONS incluse. Config de référence documentée dans docs/slices/slice-5.md.
 */
const BUCKET_CORS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>*</AllowedOrigin>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedHeader>content-type</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
  </CORSRule>
</CORSConfiguration>`;

let server: S3rver | null = null;
let dataDir: string | null = null;

/** Démarre le serveur S3 local (idempotent). */
export function startStorageServer(): void {
  if (server) return;
  dataDir = mkdtempSync(join(tmpdir(), 'kreiz-e2e-media-'));
  server = new S3rver({
    port: STORAGE_PORT,
    address: '127.0.0.1',
    directory: dataDir,
    silent: true,
    configureBuckets: [{ name: E2E_BUCKET, configs: [BUCKET_CORS_XML] }],
  });
  void server.run();
}

/** Arrête le serveur et purge les objets (répertoire temporaire). */
export function stopStorageServer(): void {
  if (server) {
    void server.close();
    server = null;
  }
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  }
}
